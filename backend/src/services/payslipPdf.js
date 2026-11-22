import PDFDocument from 'pdfkit';

const money = (amount) => `KES ${Number(amount ?? 0).toFixed(2)}`;
const date = (value) => new Intl.DateTimeFormat('en-KE', {
  timeZone: 'Africa/Nairobi', dateStyle: 'medium',
}).format(new Date(value));

export function createPayslipPdf(payslip) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const row = (label, value, amount = null) => {
      doc.font('Helvetica-Bold').text(`${label}:`, { continued: true });
      doc.font('Helvetica').text(` ${value ?? '-'}`, { continued: amount !== null });
      if (amount !== null) doc.font('Helvetica-Bold').text(`  ${money(amount)}`);
    };

    doc.font('Helvetica-Bold').fontSize(21).fillColor('#1f5a2d').text('SAFM Farm Management');
    doc.moveDown(0.35).fontSize(16).fillColor('#232820').text('Payslip');
    doc.moveDown().fontSize(10);
    row('Employee', payslip.full_name);
    row('Role', payslip.role_name);
    row('Payroll month', date(payslip.payroll_month));
    row('Pay period', `${date(payslip.period_start)} – ${date(payslip.period_end)}`);
    doc.moveDown().moveTo(48, doc.y).lineTo(547, doc.y).strokeColor('#e2ded1').stroke();
    doc.moveDown();

    const baseDetails = Number(payslip.hourly_rate_kes) > 0
      ? `${Number(payslip.hours_worked).toFixed(2)} hours × ${money(payslip.hourly_rate_kes)}/hour`
      : payslip.role_name === 'Farm Administrator' ? 'Monthly salary' : 'No hourly base pay';
    row('Base pay', baseDetails, payslip.base_amount_kes);
    if (Number(payslip.treatment_cost_kes) > 0) {
      row('Veterinary treatment reimbursements', `${payslip.treatments.length} treatment record(s)`, payslip.treatment_cost_kes);
      for (const treatment of payslip.treatments) {
        row(`  Treatment — ${treatment.tag_id}`, `${date(treatment.examined_at)}${treatment.treatment ? ` · ${treatment.treatment}` : ''}`, treatment.treatment_cost_kes);
      }
    }
    if (Number(payslip.adjustment_kes) !== 0) {
      row('Payroll adjustment', payslip.adjustment_note || 'Adjustment recorded by farm administration', payslip.adjustment_kes);
    }
    doc.moveDown().moveTo(48, doc.y).lineTo(547, doc.y).strokeColor('#e2ded1').stroke();
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(14).fillColor('#17401f')
      .text(`Total payroll amount: ${money(payslip.total_amount_kes)}`);
    if (payslip.adjusted_by) {
      doc.moveDown(0.6).font('Helvetica').fontSize(9).fillColor('#555')
        .text(`Adjusted by ${payslip.adjusted_by}${payslip.updated_at ? ` on ${date(payslip.updated_at)}` : ''}`);
    }
    doc.end();
  });
}
