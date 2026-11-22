import { q } from '../db.js';

/** Fuel and idling summary for one machine from its telemetry (10-minute readings). */
export async function fuelSummary(machineId, from, to) {
  const rows = await q(
    `SELECT recorded_at, ignition_on, speed_kmh, engine_hours, fuel_level_pct FROM machinery_telemetry
      WHERE machine_id = ? AND recorded_at BETWEEN ? AND ? ORDER BY recorded_at`, [machineId, from, to]);
  let fuelUsedPct = 0, idleReadings = 0, runReadings = 0, refuels = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.ignition_on) { runReadings++; if ((r.speed_kmh ?? 0) < 1) idleReadings++; }
    if (i > 0 && rows[i - 1].fuel_level_pct != null && r.fuel_level_pct != null) {
      const d = rows[i - 1].fuel_level_pct - r.fuel_level_pct;
      if (d > 0) fuelUsedPct += d; else if (d < -5) refuels++;
    }
  }
  const hrs = rows.map((r) => Number(r.engine_hours)).filter((n) => !Number.isNaN(n));
  const engineHours = hrs.length ? Math.max(...hrs) - Math.min(...hrs) : 0;
  const [fl] = await q('SELECT COALESCE(SUM(litres),0) AS litres FROM fuel_logs WHERE machine_id = ? AND logged_at BETWEEN ? AND ?', [machineId, from, to]);
  return {
    readings: rows.length,
    engine_hours: Number(engineHours.toFixed(1)),
    idle_hours: Number(((idleReadings * 10) / 60).toFixed(1)),
    idle_share_pct: runReadings ? Math.round((idleReadings / runReadings) * 100) : 0,
    fuel_used_pct_points: Number(fuelUsedPct.toFixed(1)),
    pct_points_per_engine_hour: engineHours > 0 ? Number((fuelUsedPct / engineHours).toFixed(2)) : null,
    refuels,
    litres_logged: Number(fl.litres),
  };
}
