export type Sample = { sensor_id: string; minute: number; observed_at: number; temperature: number | null; humidity: number | null; co2: number | null; battery: number | null; rssi: number | null };
const DAY = 86400;
export function validateSample(value: unknown, ids: Set<string>, now: number): Sample {
  if (!value || typeof value !== 'object') throw Error('invalid sample');
  const row = value as Record<string, unknown>;
  if (typeof row.sensor_id !== 'string' || !ids.has(row.sensor_id)) throw Error('unknown sensor');
  if (!Number.isInteger(row.minute) || Number(row.minute) % 60 !== 0 || Number(row.minute) < now - DAY - 3600 || Number(row.minute) > now + 120) throw Error('invalid minute');
  if (!Number.isInteger(row.observed_at) || Number(row.observed_at) < Number(row.minute) || Number(row.observed_at) >= Number(row.minute) + 60) throw Error('invalid observed_at');
  const result: Record<string, unknown> = { sensor_id: row.sensor_id, minute: row.minute, observed_at: row.observed_at };
  const bounds: Record<string, [number, number]> = { temperature: [-50, 100], humidity: [0, 100], co2: [1, 9999], battery: [0, 100], rssi: [-127, 20] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const n = row[key];
    if (n === null || n === undefined) result[key] = null;
    else if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (['co2','battery','rssi'].includes(key) && !Number.isInteger(n))) throw Error(`invalid ${key}`);
    else result[key] = n;
  }
  if (['temperature','humidity','co2'].every(k => result[k] === null)) throw Error('no measurement');
  return result as Sample;
}

export const aggregateSQL = `INSERT INTO hourly
 (sensor_id,hour,temperature_avg,temperature_min,temperature_max,temperature_count,humidity_avg,humidity_min,humidity_max,humidity_count,co2_avg,co2_min,co2_max,co2_count,sample_count)
 SELECT sensor_id, CAST(minute/3600 AS INTEGER)*3600,
 AVG(temperature),MIN(temperature),MAX(temperature),COUNT(temperature),
 AVG(humidity),MIN(humidity),MAX(humidity),COUNT(humidity),
 AVG(co2),MIN(co2),MAX(co2),COUNT(co2),COUNT(*)
 FROM samples WHERE minute>=? AND minute<?
 GROUP BY sensor_id, CAST(minute/3600 AS INTEGER)
 ON CONFLICT(sensor_id,hour) DO UPDATE SET
 temperature_avg=excluded.temperature_avg,temperature_min=excluded.temperature_min,temperature_max=excluded.temperature_max,temperature_count=excluded.temperature_count,
 humidity_avg=excluded.humidity_avg,humidity_min=excluded.humidity_min,humidity_max=excluded.humidity_max,humidity_count=excluded.humidity_count,
 co2_avg=excluded.co2_avg,co2_min=excluded.co2_min,co2_max=excluded.co2_max,co2_count=excluded.co2_count,sample_count=excluded.sample_count`;

// JSONを1パラメーターで渡し、1時間分を1 SQLで保存する。
export const insertBatchSQL = `INSERT INTO samples
(sensor_id,minute,observed_at,received_at,temperature,humidity,co2,battery,rssi)
SELECT json_extract(value,'$.sensor_id'),json_extract(value,'$.minute'),json_extract(value,'$.observed_at'),?,
json_extract(value,'$.temperature'),json_extract(value,'$.humidity'),json_extract(value,'$.co2'),json_extract(value,'$.battery'),json_extract(value,'$.rssi')
FROM json_each(?) WHERE 1 ON CONFLICT(sensor_id,minute) DO NOTHING`;
