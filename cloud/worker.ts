import { validateSample, aggregateSQL, insertBatchSQL, type Sample } from './model';
type Secrets = { INGEST_TOKEN: string; READ_TOKEN: string };
const DAY = 86400;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

async function authorized(request: Request, secret: string | undefined) {
  if (!secret) return false;
  const provided = request.headers.get('Authorization') ?? '';
  const encoder = new TextEncoder();
  const [a,b] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(provided)), crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${secret}`))]);
  // 固定長ハッシュを全バイト比較する。認証値の一致位置で早期終了しない。
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let diff = 0;
  for (let i=0;i<aa.length;i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

async function readBody(request: Request) {
  if (!request.body) throw Error('missing body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 524288) throw Error('body too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request: Request, env: Env & Secrets): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, service: 'home-sensors' });
    const write = url.pathname === '/api/v1/samples' && request.method === 'POST';
    const register = url.pathname === '/api/v1/sensors' && request.method === 'POST';
    if (!await authorized(request, write || register ? env.INGEST_TOKEN : env.READ_TOKEN)) return json({ error: 'unauthorized' }, 401);
    const now = Math.floor(Date.now()/1000);
    if (register) {
      let requested: string[];
      try {
        const body = await readBody(request);
        if (!Array.isArray(body.sensor_ids) || body.sensor_ids.length<1 || body.sensor_ids.length>32 || body.sensor_ids.some((id:unknown)=>typeof id!=='string'||!/^sb-[0-9a-f]{16}$/.test(id))) throw Error('invalid sensor ids');
        requested = [...new Set<string>(body.sensor_ids)];
      } catch { return json({error:'invalid registration'},400); }
      // 登録操作だけで書き換える。計測ごとにレジストリを書き込まない。
      await env.DB.prepare(`INSERT INTO registered_sensors(sensor_id,registered_at)
        SELECT value,? FROM json_each(?) WHERE 1 ON CONFLICT(sensor_id) DO NOTHING`).bind(now,JSON.stringify(requested)).run();
      return json({sensor_ids:requested});
    }
    const ids = new Set(env.SENSOR_IDS.split(','));
    if (write || (url.pathname==='/api/v1/history' && request.method==='GET')) {
      const registered = await env.DB.prepare('SELECT sensor_id FROM registered_sensors').all<{sensor_id:string}>();
      registered.results.forEach(row=>ids.add(row.sensor_id));
    }
    if (write) {
      let samples: Sample[];
      try {
        const body = await readBody(request);
        if (!Array.isArray(body.samples) || body.samples.length < 1 || body.samples.length > 1000) throw Error('expected 1..1000 samples');
        samples = body.samples.map((v: unknown) => validateSample(v, ids, now));
      } catch (error) { return json({ error: String(error) }, 400); }
      const insert = env.DB.prepare(insertBatchSQL).bind(now,JSON.stringify(samples));
      // 再送は無視し、遅延到着した時刻の集計を同じトランザクションで修復する。
      const hours = [...new Set(samples.map(r => Math.floor(r.minute/3600)*3600))];
      await env.DB.batch([insert, ...hours.map(h => env.DB.prepare(aggregateSQL).bind(h,h+3600))]);
      return json({ accepted: samples.length });
    }
    if (url.pathname === '/api/v1/history' && request.method === 'GET') {
      const sensor = url.searchParams.get('sensor_id') ?? '';
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      const resolution = url.searchParams.get('resolution') ?? 'minute';
      if (!ids.has(sensor) || !Number.isInteger(from) || !Number.isInteger(to) || to <= from || !['minute','hour'].includes(resolution) || (to-from) > (resolution==='minute'?31:366)*DAY) return json({ error: 'invalid range' },400);
      if (resolution === 'hour') {
        const data = await env.DB.prepare(`SELECT hour AS minute,temperature_avg AS temperature,humidity_avg AS humidity,co2_avg AS co2,temperature_min,temperature_max,humidity_min,humidity_max,co2_min,co2_max,temperature_count,humidity_count,co2_count,sample_count FROM hourly WHERE sensor_id=? AND hour>=? AND hour<? ORDER BY hour LIMIT 9000`).bind(sensor,from,to).all();
        return json({ samples: data.results, resolution });
      }
      // 保存した1分の値をそのまま返す。範囲を広げても平均化・点数制限しない。
      const data = await env.DB.prepare(`SELECT minute,temperature,humidity,co2 FROM samples WHERE sensor_id=? AND minute>=? AND minute<? ORDER BY minute`).bind(sensor,from,to).all();
      return json({ samples: data.results, resolution, bucket_seconds: 60 });
    }
    return json({ error: 'not found' },404);
  },
  async scheduled(_event: ScheduledController, env: Env) {
    const now = Math.floor(Date.now()/1000);
    // 削除も分割し、長期停止後でも1回のCron処理量を制限する。
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM samples WHERE (sensor_id,minute) IN (SELECT sensor_id,minute FROM samples WHERE minute<? LIMIT 50000)`).bind(now-90*DAY),
      env.DB.prepare(`DELETE FROM hourly WHERE (sensor_id,hour) IN (SELECT sensor_id,hour FROM hourly WHERE hour<? LIMIT 10000)`).bind(now-5*365*DAY)
    ]);
  }
};
