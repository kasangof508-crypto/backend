import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { q, tx } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';
import { createPayslipPdf } from '../services/payslipPdf.js';

const r = Router();
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const staffRoles = [ROLES.WORKER, ROLES.OPERATOR, ROLES.VET, ROLES.ADMIN];

async function getEmployeePayslips(userId, entryId) {
  const entryFilter = entryId ? 'AND e.entry_id = ?' : '';
  const params = entryId ? [userId, entryId] : [userId];
  const payslips = await q(
    `SELECT e.entry_id, e.run_id, r.payroll_month, r.period_start, r.period_end, r.created_at,
            e.role_name, u.full_name, e.hours_worked, e.hourly_rate_kes, e.base_amount_kes,
            e.treatment_cost_kes, e.adjustment_kes, e.adjustment_note, e.total_amount_kes,
            e.updated_at, editor.full_name AS adjusted_by
       FROM payroll_entries e
       JOIN payroll_runs r ON r.run_id = e.run_id
       JOIN users u ON u.user_id = e.user_id
       LEFT JOIN users editor ON editor.user_id = e.adjusted_by
      WHERE e.user_id = ? ${entryFilter}
      ORDER BY r.payroll_month DESC`,
    params);
  const treatments = await q(
    `SELECT p.entry_id, h.record_id, a.tag_id, h.examined_at, h.treatment, h.treatment_cost_kes
       FROM payroll_treatment_records p
       JOIN health_records h ON h.record_id = p.record_id
       JOIN livestock a ON a.animal_id = h.animal_id
       JOIN payroll_entries e ON e.entry_id = p.entry_id
      WHERE e.user_id = ? ${entryFilter}
      ORDER BY h.examined_at, h.record_id`,
    params);
  return payslips.map((payslip) => ({
    ...payslip,
    treatments: treatments.filter((treatment) => treatment.entry_id === payslip.entry_id),
  }));
}

r.get('/', authorize(ROLES.SYSADMIN), wrap(async (_req, res) => {
  res.json(await q(
    `SELECT r.run_id, r.payroll_month, r.period_start, r.period_end, r.created_at,
            u.full_name AS created_by, COUNT(e.entry_id) AS employee_count,
            COALESCE(SUM(e.total_amount_kes), 0) AS total_amount_kes
       FROM payroll_runs r
       JOIN users u ON u.user_id = r.created_by
       LEFT JOIN payroll_entries e ON e.run_id = r.run_id
      GROUP BY r.run_id ORDER BY r.payroll_month DESC LIMIT 100`));
}));

r.post('/', authorize(ROLES.SYSADMIN), wrap(async (req, res) => {
  const { month } = z.object({ month: monthSchema }).parse(req.body);
  const [year, monthNumber] = month.split('-').map(Number);
  const periodStart = `${month}-01`;
  const nextMonth = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
  const periodEnd = new Date(Date.UTC(year, monthNumber, 1) - 86400000).toISOString().slice(0, 10);
  const runId = randomUUID();

  let created;
  try {
    created = await tx(async (execute) => {
      await execute(
        'INSERT INTO payroll_runs (run_id, payroll_month, period_start, period_end, created_by) VALUES (?,?,?,?,?)',
        [runId, periodStart, periodStart, periodEnd, req.user.sub]);

      const employees = await execute(
        `SELECT u.user_id, u.full_name, r.role_name
           FROM users u JOIN roles r ON r.role_id = u.role_id
          WHERE u.status <> 'deleted' AND r.role_name IN (?,?,?,?)
          ORDER BY r.role_name, u.full_name`,
        staffRoles);
      const attendance = await execute(
        `SELECT user_id,
                ROUND(SUM(TIMESTAMPDIFF(SECOND, GREATEST(sign_in_at, ?), LEAST(sign_out_at, ?))) / 3600, 2) AS hours_worked
           FROM attendance
          WHERE sign_out_at IS NOT NULL AND sign_out_at > ? AND sign_in_at < ?
          GROUP BY user_id`,
        [periodStart, nextMonth, periodStart, nextMonth]);
      const treatmentRecords = await execute(
        `SELECT h.record_id, h.vet_id, h.treatment_cost_kes
           FROM health_records h
           LEFT JOIN payroll_treatment_records p ON p.record_id = h.record_id
          WHERE h.examined_at >= ? AND h.examined_at < ?
            AND h.treatment_cost_kes > 0 AND p.record_id IS NULL
          ORDER BY h.record_id FOR UPDATE`,
        [periodStart, nextMonth]);

      const hoursByUser = new Map(attendance.map((row) => [row.user_id, Number(row.hours_worked ?? 0)]));
      const expensesByVet = new Map();
      for (const record of treatmentRecords) {
        const expenses = expensesByVet.get(record.vet_id) ?? [];
        expenses.push(record);
        expensesByVet.set(record.vet_id, expenses);
      }

      const entriesByUser = new Map();
      for (const employee of employees) {
        const hours = hoursByUser.get(employee.user_id) ?? 0;
        const hourlyRate = employee.role_name === ROLES.WORKER ? 150
          : employee.role_name === ROLES.OPERATOR ? 200 : 0;
        const baseAmount = employee.role_name === ROLES.ADMIN ? 35000
          : Number((hours * hourlyRate).toFixed(2));
        const employeeExpenses = expensesByVet.get(employee.user_id) ?? [];
        const treatmentAmount = Number(employeeExpenses
          .reduce((sum, record) => sum + Number(record.treatment_cost_kes), 0).toFixed(2));
        const entryId = randomUUID();
        await execute(
          `INSERT INTO payroll_entries
             (entry_id, run_id, user_id, role_name, hours_worked, hourly_rate_kes,
              base_amount_kes, treatment_cost_kes, total_amount_kes)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [entryId, runId, employee.user_id, employee.role_name, hours, hourlyRate,
            baseAmount, treatmentAmount, Number((baseAmount + treatmentAmount).toFixed(2))]);
        entriesByUser.set(employee.user_id, entryId);
      }

      for (const record of treatmentRecords) {
        const entryId = entriesByUser.get(record.vet_id);
        if (entryId) {
          await execute(
            'INSERT INTO payroll_treatment_records (record_id, entry_id) VALUES (?,?)',
            [record.record_id, entryId]);
        }
      }
      return { run_id: runId, payroll_month: periodStart, period_start: periodStart, period_end: periodEnd };
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'A payroll run already exists for this month');
    throw error;
  }

  await auditReq(req, 'payroll_run_created', 'payroll_run', { run_id: created.run_id, payroll_month: month });
  res.status(201).json(created);
}));

r.get('/mine', authorize(...staffRoles), wrap(async (req, res) => {
  res.json(await getEmployeePayslips(req.user.sub));
}));

r.get('/mine/:entryId/download', authorize(...staffRoles), wrap(async (req, res) => {
  const entryId = z.string().uuid().parse(req.params.entryId);
  const [payslip] = await getEmployeePayslips(req.user.sub, entryId);
  if (!payslip) throw new HttpError(404, 'Payslip not found');
  const pdf = await createPayslipPdf(payslip);
  await auditReq(req, 'payslip_downloaded', 'payroll_entry', { entry_id: payslip.entry_id });
  const month = new Date(payslip.payroll_month).toISOString().slice(0, 7);
  res.type('application/pdf').attachment(`SAFM_payslip_${month}.pdf`).send(pdf);
}));

r.get('/:runId', authorize(ROLES.SYSADMIN), wrap(async (req, res) => {
  const [run] = await q(
    `SELECT r.run_id, r.payroll_month, r.period_start, r.period_end, r.created_at, u.full_name AS created_by
       FROM payroll_runs r JOIN users u ON u.user_id = r.created_by WHERE r.run_id = ?`,
    [req.params.runId]);
  if (!run) throw new HttpError(404, 'Payroll run not found');
  const entries = await q(
    `SELECT e.entry_id, e.run_id, e.user_id, e.role_name, u.full_name, e.hours_worked, e.hourly_rate_kes,
            e.base_amount_kes, e.treatment_cost_kes, e.adjustment_kes, e.adjustment_note,
            e.total_amount_kes, e.updated_at, editor.full_name AS adjusted_by
       FROM payroll_entries e
       JOIN users u ON u.user_id = e.user_id
       LEFT JOIN users editor ON editor.user_id = e.adjusted_by
      WHERE e.run_id = ? ORDER BY e.role_name, u.full_name`,
    [req.params.runId]);
  const treatments = await q(
    `SELECT p.entry_id, h.record_id, h.animal_id, a.tag_id, h.examined_at, h.treatment,
            h.treatment_cost_kes
       FROM payroll_treatment_records p
       JOIN health_records h ON h.record_id = p.record_id
       JOIN livestock a ON a.animal_id = h.animal_id
       JOIN payroll_entries e ON e.entry_id = p.entry_id
      WHERE e.run_id = ? ORDER BY h.examined_at, h.record_id`,
    [req.params.runId]);
  res.json({
    run,
    entries: entries.map((entry) => ({
      ...entry,
      treatments: treatments.filter((treatment) => treatment.entry_id === entry.entry_id),
    })),
  });
}));

r.put('/:runId/entries/:entryId', authorize(ROLES.SYSADMIN), wrap(async (req, res) => {
  const body = z.object({
    adjustment_kes: z.number().min(-9999999999.99).max(9999999999.99),
    adjustment_note: z.string().trim().max(500).optional(),
  }).parse(req.body);
  const [entry] = await q(
    `SELECT e.base_amount_kes, e.treatment_cost_kes, e.adjustment_kes, e.adjustment_note, e.total_amount_kes
       FROM payroll_entries e JOIN payroll_runs r ON r.run_id = e.run_id
      WHERE e.entry_id = ? AND e.run_id = ?`,
    [req.params.entryId, req.params.runId]);
  if (!entry) throw new HttpError(404, 'Payroll entry not found');
  const total = Number((Number(entry.base_amount_kes) + Number(entry.treatment_cost_kes) + body.adjustment_kes).toFixed(2));
  if (total < 0) throw new HttpError(400, 'Adjustment cannot make the payroll amount negative');
  await q(
    'UPDATE payroll_entries SET adjustment_kes = ?, adjustment_note = ?, total_amount_kes = ?, adjusted_by = ? WHERE entry_id = ?',
    [body.adjustment_kes, body.adjustment_note || null, total, req.user.sub, req.params.entryId]);
  await auditReq(req, 'payroll_entry_adjusted', 'payroll_entry', {
    entry_id: req.params.entryId,
    run_id: req.params.runId,
    previous_total_kes: Number(entry.total_amount_kes),
    adjustment_kes: body.adjustment_kes,
    total_amount_kes: total,
    note: body.adjustment_note || null,
  });
  res.json({ ok: true, total_amount_kes: total });
}));

export default r;
