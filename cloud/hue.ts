export type HueSample = {
  light_id:string; minute:number; observed_at:number; available:boolean; connectivity:string;
  on:boolean|null; brightness:number|null; mirek:number|null; x:number|null; y:number|null; color_mode:string|null;
};
export const lightId = (v:unknown):v is string => typeof v==='string' && /^hue-[a-f0-9]{32}$/.test(v);
export function validateLight(value:unknown) {
  if(!value || typeof value!=='object')throw Error('invalid light');
  const r=value as Record<string,unknown>;
  if(!lightId(r.light_id)||!lightId(r.device_id))throw Error('invalid light id');
  for(const key of ['name','output_name'])if(typeof r[key]!=='string'||[...r[key] as string].length<1||[...r[key] as string].length>100||/[\x00-\x1f]/.test(r[key] as string))throw Error('invalid light name');
  return {light_id:r.light_id,device_id:r.device_id,name:r.name as string,output_name:r.output_name as string};
}
export function validateHueSample(value:unknown,ids:Set<string>,now:number):HueSample {
  if(!value || typeof value!=='object')throw Error('invalid Hue sample');
  const r=value as Record<string,unknown>;
  if(!lightId(r.light_id)||!ids.has(r.light_id))throw Error('unknown light');
  if(!Number.isInteger(r.minute)||Number(r.minute)%60!==0||Number(r.minute)<now-86400-3600||Number(r.minute)>now+120)throw Error('invalid minute');
  if(!Number.isInteger(r.observed_at)||Number(r.observed_at)<Number(r.minute)||Number(r.observed_at)>=Number(r.minute)+60)throw Error('invalid observed_at');
  if(typeof r.available!=='boolean'||typeof r.connectivity!=='string'||!['connected','disconnected','connectivity_issue','unidirectional_incoming','pending_discovery','unknown','bridge_unavailable'].includes(r.connectivity))throw Error('invalid availability');
  if(r.on!=null&&typeof r.on!=='boolean')throw Error('invalid on');
  if(r.available && (typeof r.on!=='boolean'||r.connectivity!=='connected'))throw Error('missing confirmed state');
  const bounded=(key:string,min:number,max:number,integer=false):number|null=>{
    const n=r[key];if(n==null)return null;
    if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))throw Error(`invalid ${key}`);
    return n;
  };
  const row:HueSample={light_id:r.light_id,minute:Number(r.minute),observed_at:Number(r.observed_at),available:r.available,connectivity:r.connectivity,on:r.on as boolean|null??null,brightness:bounded('brightness',0,100),mirek:bounded('mirek',1,1000,true),x:bounded('x',0,1),y:bounded('y',0,1),color_mode:r.color_mode as string|null??null};
  if((row.x===null)!==(row.y===null)||(row.x!==null&&row.y!==null&&row.x+row.y>1.000001))throw Error('invalid xy');
  if(row.color_mode!==null&&!['temperature','color'].includes(row.color_mode))throw Error('invalid color mode');
  if(!row.available&&[row.on,row.brightness,row.mirek,row.x,row.y,row.color_mode].some(v=>v!==null))throw Error('unavailable state must be null');
  return row;
}
export const insertHueSQL=`INSERT INTO hue_samples
 (light_id,minute,observed_at,received_at,available,connectivity,"on",brightness,mirek,x,y,color_mode)
 SELECT json_extract(value,'$.light_id'),json_extract(value,'$.minute'),json_extract(value,'$.observed_at'),?,
 json_extract(value,'$.available'),json_extract(value,'$.connectivity'),json_extract(value,'$.on'),json_extract(value,'$.brightness'),json_extract(value,'$.mirek'),json_extract(value,'$.x'),json_extract(value,'$.y'),json_extract(value,'$.color_mode')
 FROM json_each(?) WHERE 1 ON CONFLICT(light_id,minute) DO NOTHING`;
export const aggregateHueSQL=`INSERT INTO hue_hourly
 (light_id,hour,on_fraction,brightness,brightness_min,brightness_max,mirek,x,y,available_count,unavailable_count,sample_count)
 SELECT s.light_id,CAST(s.minute/3600 AS INTEGER)*3600,
 AVG(CASE WHEN s.available=1 THEN s."on" END),
 AVG(CASE WHEN s.available=1 AND s."on"=1 THEN s.brightness END),
 MIN(CASE WHEN s.available=1 AND s."on"=1 THEN s.brightness END),
 MAX(CASE WHEN s.available=1 AND s."on"=1 THEN s.brightness END),
 (SELECT t.mirek FROM hue_samples t WHERE t.light_id=s.light_id AND t.minute>=CAST(s.minute/3600 AS INTEGER)*3600 AND t.minute<CAST(s.minute/3600 AS INTEGER)*3600+3600 AND t.available=1 AND t.mirek IS NOT NULL ORDER BY t.minute DESC LIMIT 1),
 (SELECT t.x FROM hue_samples t WHERE t.light_id=s.light_id AND t.minute>=CAST(s.minute/3600 AS INTEGER)*3600 AND t.minute<CAST(s.minute/3600 AS INTEGER)*3600+3600 AND t.available=1 AND t.x IS NOT NULL AND t.y IS NOT NULL ORDER BY t.minute DESC LIMIT 1),
 (SELECT t.y FROM hue_samples t WHERE t.light_id=s.light_id AND t.minute>=CAST(s.minute/3600 AS INTEGER)*3600 AND t.minute<CAST(s.minute/3600 AS INTEGER)*3600+3600 AND t.available=1 AND t.x IS NOT NULL AND t.y IS NOT NULL ORDER BY t.minute DESC LIMIT 1),
 SUM(s.available),SUM(1-s.available),COUNT(*)
 FROM hue_samples s WHERE s.minute>=? AND s.minute<? GROUP BY s.light_id,CAST(s.minute/3600 AS INTEGER)
 ON CONFLICT(light_id,hour) DO UPDATE SET on_fraction=excluded.on_fraction,brightness=excluded.brightness,brightness_min=excluded.brightness_min,brightness_max=excluded.brightness_max,mirek=excluded.mirek,x=excluded.x,y=excluded.y,available_count=excluded.available_count,unavailable_count=excluded.unavailable_count,sample_count=excluded.sample_count`;

export async function hueRequest(request:Request,db:D1Database,body:()=>Promise<unknown>,now:number):Promise<Response> {
  const url=new URL(request.url);
  const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
  if(url.pathname==='/api/v1/hue/lights'&&request.method==='POST') {
    let lights:ReturnType<typeof validateLight>[];
    try {
      const b=await body() as {lights:unknown[]};
      if(!Array.isArray(b.lights)||!b.lights.length||b.lights.length>512)throw Error();
      lights=b.lights.map(validateLight);
      if(new Set(lights.map(l=>l.light_id)).size!==lights.length)throw Error();
    }catch{return json({error:'invalid light registration'},400);}
    await db.prepare(`INSERT INTO hue_lights(light_id,device_id,name,output_name,registered_at)
      SELECT json_extract(value,'$.light_id'),json_extract(value,'$.device_id'),json_extract(value,'$.name'),json_extract(value,'$.output_name'),? FROM json_each(?) WHERE 1
      ON CONFLICT(light_id) DO UPDATE SET name=excluded.name,output_name=excluded.output_name`).bind(now,JSON.stringify(lights)).run();
    return json({light_ids:lights.map(l=>l.light_id)});
  }
  if(url.pathname==='/api/v1/hue/samples'&&request.method==='POST') {
    const registry=await db.prepare('SELECT light_id FROM hue_lights').all<{light_id:string}>();
    const ids=new Set(registry.results.map(r=>r.light_id));
    let samples:HueSample[];
    try {
      const b=await body() as {samples:unknown[]};
      if(!Array.isArray(b.samples)||!b.samples.length||b.samples.length>1000)throw Error();
      samples=b.samples.map(v=>validateHueSample(v,ids,now));
    }catch{return json({error:'invalid Hue samples'},400);}
    const hours=[...new Set(samples.map(r=>Math.floor(r.minute/3600)*3600))];
    await db.batch([db.prepare(insertHueSQL).bind(now,JSON.stringify(samples)),...hours.map(h=>db.prepare(aggregateHueSQL).bind(h,h+3600))]);
    return json({accepted:samples.length});
  }
  if(url.pathname==='/api/v1/hue/history'&&request.method==='GET') {
    const id=url.searchParams.get('light_id');const from=Number(url.searchParams.get('from')),to=Number(url.searchParams.get('to'));const resolution=url.searchParams.get('resolution')??'minute';
    if(!lightId(id)||!url.searchParams.has('from')||!url.searchParams.has('to')||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<=from||!['minute','hour'].includes(resolution)||to-from>(resolution==='minute'?31:366)*86400)return json({error:'invalid range'},400);
    if(!await db.prepare('SELECT light_id FROM hue_lights WHERE light_id=?').bind(id).first())return json({error:'unknown light'},400);
    if(resolution==='hour') {
      const data=await db.prepare('SELECT hour AS minute,on_fraction,brightness,brightness_min,brightness_max,mirek,x,y,available_count,unavailable_count,sample_count FROM hue_hourly WHERE light_id=? AND hour>=? AND hour<? ORDER BY hour').bind(id,from,to).all();
      return json({samples:data.results,bucket_seconds:3600});
    }
    const data=await db.prepare('SELECT minute,observed_at,available,connectivity,"on",brightness,mirek,x,y,color_mode FROM hue_samples WHERE light_id=? AND minute>=? AND minute<? ORDER BY minute').bind(id,from,to).all<Record<string,unknown>>();
    return json({samples:data.results.map(r=>({...r,available:r.available===1,on:r.on==null?null:r.on===1})),bucket_seconds:60});
  }
  return json({error:'not found'},404);
}
