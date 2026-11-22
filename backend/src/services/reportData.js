import { q } from '../db.js';
import { fuelSummary } from './analytics.js';

const n1 = (v) => (v == null ? '' : Number(Number(v).toFixed(1)));

/** Each builder returns { title, sections: [{ heading, columns[], rows[][] }] } so PDF and Excel share one data path. */
export const REPORT_TYPES = ['livestock', 'weekly_performance', 'environment', 'fuel_efficiency', 'milk_produce', 'crop_produce', 'produce_sale'];

async function workforce(from, to) {
  const tasks = await q(`SELECT status, COUNT(*) AS n FROM tasks WHERE created_at BETWEEN ? AND ? GROUP BY status`, [from, to]);
  const perWorker = await q(
    `SELECT u.full_name,
            SUM(t.status = 'completed') AS completed, COUNT(t.task_id) AS assigned,
            ROUND(AVG(CASE WHEN t.status = 'completed' THEN TIMESTAMPDIFF(MINUTE, t.started_at, t.completed_at) END) / 60, 1) AS avg_hours
       FROM users u JOIN roles r ON r.role_id = u.role_id AND r.role_name = 'Field Worker'
       LEFT JOIN tasks t ON t.assigned_to = u.user_id AND t.created_at BETWEEN ? AND ?
      WHERE u.status = 'active' GROUP BY u.user_id ORDER BY u.full_name`, [from, to]);
  const hours = await q(
    `SELECT u.full_name, ROUND(SUM(TIMESTAMPDIFF(MINUTE, a.sign_in_at, COALESCE(a.sign_out_at, NOW(3)))) / 60, 1) AS hours, COUNT(*) AS shifts
       FROM attendance a JOIN users u ON u.user_id = a.user_id WHERE a.sign_in_at BETWEEN ? AND ? GROUP BY u.user_id ORDER BY u.full_name`, [from, to]);
  return [
    { heading: 'Tasks by status', columns: ['Status', 'Count'], rows: tasks.map((t) => [t.status, t.n]) },
    { heading: 'Task completion per worker', columns: ['Worker', 'Assigned', 'Completed', 'Avg hours to complete'], rows: perWorker.map((w) => [w.full_name, w.assigned, Number(w.completed ?? 0), n1(w.avg_hours)]) },
    { heading: 'Attendance', columns: ['Worker', 'Shifts', 'Hours on shift'], rows: hours.map((h) => [h.full_name, h.shifts, n1(h.hours)]) },
  ];
}

async function livestock(from, to) {
  const herd = await q(
    `SELECT a.tag_id, a.breed, ROUND(AVG(t.temperature_c),1) AS avg_temp, ROUND(MAX(t.temperature_c),1) AS max_temp, ROUND(AVG(t.activity_index),1) AS avg_act,
            (SELECT COUNT(*) FROM alerts al WHERE al.entity_id = a.animal_id AND al.created_at BETWEEN ? AND ?) AS alerts,
            (SELECT COUNT(*) FROM health_records h WHERE h.animal_id = a.animal_id AND h.examined_at BETWEEN ? AND ?) AS exams
       FROM livestock a LEFT JOIN livestock_telemetry t ON t.animal_id = a.animal_id AND t.recorded_at BETWEEN ? AND ?
      WHERE a.status = 'active' GROUP BY a.animal_id ORDER BY a.tag_id`, [from, to, from, to, from, to]);
  const events = await q(`SELECT a.tag_id, b.event_type, b.detected_at FROM breeding_events b JOIN livestock a ON a.animal_id = b.animal_id
                           WHERE b.detected_at BETWEEN ? AND ? ORDER BY b.detected_at`, [from, to]);
  return [
    { heading: 'Herd health summary', columns: ['Tag', 'Breed', 'Avg temp °C', 'Max temp °C', 'Avg activity', 'Alerts', 'Vet exams'], rows: herd.map((h) => [h.tag_id, h.breed ?? '', h.avg_temp ?? '', h.max_temp ?? '', h.avg_act ?? '', h.alerts, h.exams]) },
    { heading: 'Breeding events', columns: ['Tag', 'Event', 'Detected at (UTC)'], rows: events.map((e) => [e.tag_id, e.event_type, new Date(e.detected_at).toISOString().slice(0, 16).replace('T', ' ')]) },
  ];
}

async function machinery(from, to, { includeCost }) {
  const machines = await q("SELECT machine_id, name, total_engine_hrs, hrs_at_last_service, service_interval_hrs FROM machinery WHERE status <> 'deleted' ORDER BY name");
  const rows = [];
  for (const m of machines) {
    const f = await fuelSummary(m.machine_id, from, to);
    rows.push([m.name, f.engine_hours, f.idle_hours, `${f.idle_share_pct}%`, f.fuel_used_pct_points, f.pct_points_per_engine_hour ?? '', f.litres_logged, n1(m.total_engine_hrs - m.hrs_at_last_service)]);
  }
  const sections = [{ heading: 'Machinery utilisation and fuel', columns: ['Machine', 'Engine hrs', 'Idle hrs', 'Idle share', 'Fuel used (% pts)', '% pts / engine hr', 'Litres logged', 'Hrs since service'], rows }];
  if (includeCost) {
    const m = await q(`SELECT ma.name, mr.service_type, mr.completed_at, mr.cost_kes FROM maintenance_records mr JOIN machinery ma ON ma.machine_id = mr.machine_id
                        WHERE mr.completed_at BETWEEN ? AND ? ORDER BY mr.completed_at`, [from, to]);
    sections.push({ heading: 'Maintenance completed (KES)', columns: ['Machine', 'Service', 'Completed (UTC)', 'Cost KES'], rows: m.map((r) => [r.name, r.service_type ?? '', new Date(r.completed_at).toISOString().slice(0, 10), r.cost_kes ?? '']) });
  }
  return sections;
}

async function environment(from, to) {
  const st = await q(
    `SELECT s.structure_name, s.structure_type, COUNT(c.recorded_at) AS n, ROUND(MIN(c.temperature_c),1) AS tmin, ROUND(AVG(c.temperature_c),1) AS tavg, ROUND(MAX(c.temperature_c),1) AS tmax,
            ROUND(AVG(c.humidity_pct),1) AS havg, ROUND(MAX(c.gas_ppm),0) AS gmax,
            (SELECT COUNT(*) FROM alerts a WHERE a.entity_id = CAST(s.structure_id AS CHAR) COLLATE utf8mb4_0900_ai_ci AND a.source_module = 'structure' AND a.created_at BETWEEN ? AND ?) AS alerts
       FROM structures s LEFT JOIN climate_readings c ON c.structure_id = s.structure_id AND c.recorded_at BETWEEN ? AND ?
      GROUP BY s.structure_id ORDER BY s.structure_name`, [from, to, from, to]);
  return [{ heading: 'Structure climate summary', columns: ['Structure', 'Type', 'Readings', 'Min °C', 'Avg °C', 'Max °C', 'Avg humidity %', 'Max gas ppm', 'Alerts'],
    rows: st.map((s) => [s.structure_name, s.structure_type, s.n, s.tmin ?? '', s.tavg ?? '', s.tmax ?? '', s.havg ?? '', s.gmax ?? '', s.alerts]) }];
}

async function alertsSummary(from, to) {
  const rows = await q(
    `SELECT source_module, severity, COUNT(*) AS n,
            ROUND(AVG(TIMESTAMPDIFF(SECOND, created_at, acknowledged_at)) / 60, 1) AS avg_ack_min
       FROM alerts WHERE created_at BETWEEN ? AND ? GROUP BY source_module, severity ORDER BY source_module, severity`, [from, to]);
  return [{ heading: 'Alerts', columns: ['Module', 'Severity', 'Count', 'Avg minutes to acknowledge'], rows: rows.map((r) => [r.source_module, r.severity, r.n, r.avg_ack_min ?? '']) }];
}

async function production(from, to) {
  const [milk, harvests, sales, crops, milkDetails, harvestDetails, saleDetails] = await Promise.all([
    q(`SELECT a.tag_id, u.full_name, COUNT(*) AS entries, ROUND(SUM(m.litres),2) AS litres
         FROM milk_production m JOIN livestock a ON a.animal_id = m.animal_id
         JOIN users u ON u.user_id = m.recorded_by
        WHERE m.recorded_at BETWEEN ? AND ? GROUP BY a.animal_id, u.user_id ORDER BY a.tag_id, u.full_name`, [from, to]),
    q(`SELECT c.crop_name, c.variety, h.unit, COUNT(*) AS entries, ROUND(SUM(h.quantity),2) AS quantity
         FROM crop_harvests h JOIN cultivated_crops c ON c.crop_id = h.crop_id
        WHERE h.harvested_at BETWEEN ? AND ? GROUP BY c.crop_id, h.unit ORDER BY c.crop_name, h.unit`, [from, to]),
    q(`SELECT s.produce_type, COALESCE(c.crop_name, 'Milk') AS produce, s.unit, s.payment_method, s.payment_status, COUNT(*) AS sales,
              ROUND(SUM(s.quantity),2) AS quantity,
              ROUND(SUM(COALESCE(s.payment_amount_kes, s.quantity * s.unit_price_kes)),2) AS total_kes
         FROM produce_sales s LEFT JOIN cultivated_crops c ON c.crop_id = s.crop_id
        WHERE s.sold_at BETWEEN ? AND ?
        GROUP BY s.produce_type, c.crop_id, s.unit, s.payment_method, s.payment_status
        ORDER BY s.produce_type, produce, s.payment_method, s.payment_status`, [from, to]),
    q(`SELECT c.crop_name, c.variety, z.zone_name, c.planted_on, c.area_ha, c.status
         FROM cultivated_crops c LEFT JOIN zones z ON z.zone_id = c.zone_id ORDER BY c.status, c.crop_name`),
    q(`SELECT m.recorded_at, a.tag_id, m.litres, u.full_name, m.notes
         FROM milk_production m JOIN livestock a ON a.animal_id = m.animal_id JOIN users u ON u.user_id = m.recorded_by
        WHERE m.recorded_at BETWEEN ? AND ? ORDER BY m.recorded_at`, [from, to]),
    q(`SELECT h.harvested_at, c.crop_name, c.variety, h.quantity, h.unit, u.full_name, h.notes
         FROM crop_harvests h JOIN cultivated_crops c ON c.crop_id = h.crop_id JOIN users u ON u.user_id = h.recorded_by
        WHERE h.harvested_at BETWEEN ? AND ? ORDER BY h.harvested_at`, [from, to]),
    q(`SELECT s.sold_at, s.produce_type, COALESCE(c.crop_name, 'Milk') AS produce, s.quantity, s.unit, s.unit_price_kes, s.payment_method,
              s.payment_status, s.mpesa_receipt_number,
              COALESCE(s.payment_amount_kes, s.quantity * s.unit_price_kes) AS total_kes,
              s.buyer_name, s.buyer_phone, s.buyer_address, u.full_name AS sold_by
         FROM produce_sales s LEFT JOIN cultivated_crops c ON c.crop_id = s.crop_id JOIN users u ON u.user_id = s.sold_by
        WHERE s.sold_at BETWEEN ? AND ? ORDER BY s.sold_at`, [from, to]),
  ]);
  return [
    { heading: 'Milk production', columns: ['Cow tag', 'Recorded by', 'Entries', 'Litres'], rows: milk.map((m) => [m.tag_id, m.full_name, m.entries, m.litres]) },
    { heading: 'Crop harvests', columns: ['Crop', 'Variety', 'Entries', 'Quantity', 'Unit'], rows: harvests.map((h) => [h.crop_name, h.variety ?? '', h.entries, h.quantity, h.unit]) },
    { heading: 'Produce sales', columns: ['Type', 'Produce', 'Payment', 'Status', 'Sales', 'Quantity', 'Unit', 'Total KES'], rows: sales.map((s) => [s.produce_type, s.produce, s.payment_method, s.payment_status, s.sales, s.quantity, s.unit, s.total_kes]) },
    { heading: 'Cultivated crop register', columns: ['Crop', 'Variety', 'Field', 'Planted', 'Area ha', 'Status'], rows: crops.map((c) => [c.crop_name, c.variety ?? '', c.zone_name ?? '', String(c.planted_on).slice(0, 10), c.area_ha ?? '', c.status]) },
    { heading: 'Milk production entries', columns: ['Recorded at (UTC)', 'Cow tag', 'Litres', 'Worker', 'Notes'], rows: milkDetails.map((m) => [new Date(m.recorded_at).toISOString().slice(0, 16).replace('T', ' '), m.tag_id, m.litres, m.full_name, m.notes ?? '']) },
    { heading: 'Harvest entries', columns: ['Harvested at (UTC)', 'Crop', 'Variety', 'Quantity', 'Unit', 'Worker', 'Notes'], rows: harvestDetails.map((h) => [new Date(h.harvested_at).toISOString().slice(0, 16).replace('T', ' '), h.crop_name, h.variety ?? '', h.quantity, h.unit, h.full_name, h.notes ?? '']) },
    { heading: 'Produce sale entries and buyers', columns: ['Sold at (UTC)', 'Type', 'Produce', 'Quantity', 'Unit', 'Unit price KES', 'Total KES', 'Payment', 'Status', 'M-Pesa receipt', 'Buyer', 'Phone', 'Address', 'Sold by'], rows: saleDetails.map((s) => [new Date(s.sold_at).toISOString().slice(0, 16).replace('T', ' '), s.produce_type, s.produce, s.quantity, s.unit, s.unit_price_kes, s.total_kes, s.payment_method, s.payment_status, s.mpesa_receipt_number ?? '', s.buyer_name, s.buyer_phone ?? '', s.buyer_address ?? '', s.sold_by]) },
  ];
}

export async function buildReport(type, from, to, role) {
  const includeCost = role === 'Farm Administrator' || role === 'System Administrator';
  switch (type) {
    case 'weekly_performance':
      return { title: 'Weekly Farm Performance Report', sections: [
        ...(await workforce(from, to)), ...(await livestock(from, to)),
        ...(await machinery(from, to, { includeCost })), ...(await environment(from, to)), ...(await alertsSummary(from, to))] };
    case 'fuel_efficiency': return { title: 'Fuel Efficiency Report', sections: await machinery(from, to, { includeCost: false }) };
    case 'livestock': return { title: 'Livestock Productivity Report', sections: await livestock(from, to) };
    case 'environment': return { title: 'Environmental Trends Report', sections: [...(await environment(from, to)), ...(await alertsSummary(from, to))] };
    case 'milk_produce': return { title: 'Milk Produce Report', sections: (await production(from, to)).filter((s) => s.heading.startsWith('Milk ')) };
    case 'crop_produce': return { title: 'Crop Produce Report', sections: (await production(from, to)).filter((s) => ['Crop harvests', 'Cultivated crop register', 'Harvest entries'].includes(s.heading)) };
    case 'produce_sale': return { title: 'Produce Sale Report', sections: (await production(from, to)).filter((s) => ['Produce sales', 'Produce sale entries and buyers'].includes(s.heading)) };
    default: throw new Error('Unknown report type');
  }
}
