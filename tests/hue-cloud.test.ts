import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { validateHueSample,validateLight,insertHueSQL,aggregateHueSQL,hueRequest } from '../cloud/hue.ts';

const id='hue-'+'a'.repeat(32),device='hue-'+'b'.repeat(32);
const sample=(minute:number,extra={})=>({light_id:id,minute,observed_at:minute+1,available:true,connectivity:'connected',on:true,brightness:40,mirek:250,x:0.3,y:0.3,color_mode:'temperature',...extra});
function database(){const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../cloud/migrations/0003_hue.sql',import.meta.url),'utf8'));return db;}
test('Hue observations distinguish off, unavailable and unsupported; reject fabricated state',()=>{
  const now=1800000000,ids=new Set([id]);
  assert.equal(validateHueSample(sample(now,{on:false}),ids,now).brightness,40);
  const gap=sample(now,{available:false,connectivity:'bridge_unavailable',on:null,brightness:null,mirek:null,x:null,y:null,color_mode:null});
  assert.equal(validateHueSample(gap,ids,now).on,null);
  for(const invalid of [sample(now,{light_id:device}),sample(now,{available:false}),sample(now,{connectivity:'disconnected'}),sample(now,{brightness:101}),sample(now,{mirek:0}),sample(now,{x:0.9,y:0.9}),sample(now,{x:null}),sample(now-90060),sample(now,{observed_at:now+60})])assert.throws(()=>validateHueSample(invalid,ids,now));
  assert.equal(validateLight({light_id:id,device_id:device,name:'寝室',output_name:'照明'}).name,'寝室');
  assert.throws(()=>validateLight({light_id:id,device_id:device,name:'\n',output_name:'照明'}));
});
test('Hue hourly aggregates exclude off brightness and gaps, repair late data, retain last valid colors',()=>{
  const db=database();const insert=db.prepare(insertHueSQL),aggregate=db.prepare(aggregateHueSQL);
  const rows=[sample(3600,{brightness:20,mirek:250,x:0.2,y:0.2}),sample(3660,{on:false,brightness:100,mirek:null,x:0.4,y:0.3,color_mode:'color'}),sample(3720,{available:false,connectivity:'disconnected',on:null,brightness:null,mirek:null,x:null,y:null,color_mode:null})];
  insert.run(8000,JSON.stringify(rows));aggregate.run(3600,7200);insert.run(8001,JSON.stringify(rows));
  let r=db.prepare('SELECT * FROM hue_hourly').get()!;assert.equal(r.on_fraction,0.5);assert.equal(r.brightness,20);assert.equal(r.available_count,2);assert.equal(r.unavailable_count,1);assert.equal(r.mirek,250);assert.equal(r.x,0.4);
  insert.run(8002,JSON.stringify([sample(3780,{brightness:60,mirek:300,x:0.25,y:0.35})]));aggregate.run(3600,7200);
  r=db.prepare('SELECT * FROM hue_hourly').get()!;assert.equal(r.sample_count,4);assert.equal(r.on_fraction,2/3);assert.equal(r.brightness,40);assert.equal(r.brightness_min,20);assert.equal(r.brightness_max,60);assert.equal(r.mirek,300);assert.equal(r.x,0.25);
  insert.run(8003,JSON.stringify([sample(7200,{available:false,connectivity:'bridge_unavailable',on:null,brightness:null,mirek:null,x:null,y:null,color_mode:null})]));aggregate.run(7200,10800);
  assert.equal(db.prepare('SELECT on_fraction FROM hue_hourly WHERE hour=7200').get()!.on_fraction,null);db.close();
});
// Exercise the endpoint contract against SQLite using the project's D1 SQL shapes.
test('Hue cloud endpoints register, ingest idempotently and return booleans, including archived history',async()=>{
  const db=database();
  const binding={prepare(sql:string){return {bind(...params:unknown[]){const stmt=db.prepare(sql);return {run:async()=>stmt.run(...params as never[]),all:async()=>({results:stmt.all(...params as never[])}),first:async()=>stmt.get(...params as never[])??null,sql,params};},all:async()=>({results:db.prepare(sql).all()})};},async batch(statements:{sql:string;params:unknown[]}[]){db.exec('BEGIN');try{for(const s of statements)db.prepare(s.sql).run(...s.params as never[]);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}};
  const request=async(path:string,body?:unknown)=>hueRequest(new Request('https://example.test'+path,{method:body?'POST':'GET'}),binding as D1Database,async()=>body,1800000000);
  const light={light_id:id,device_id:device,name:'寝室',output_name:'照明'};
  assert.equal((await request('/api/v1/hue/samples',{samples:[sample(1800000000)]})).status,400);
  assert.deepEqual(await (await request('/api/v1/hue/lights',{lights:[light]})).json(),{light_ids:[id]});
  for(let i=0;i<2;i++)assert.equal((await request('/api/v1/hue/samples',{samples:[sample(1800000000,{on:false})]})).status,200);
  const response=await request(`/api/v1/hue/history?light_id=${id}&from=1800000000&to=1800000060`);const data=await response.json() as {samples:{on:boolean;available:boolean}[]};assert.equal(data.samples.length,1);assert.equal(data.samples[0].on,false);assert.equal(data.samples[0].available,true);
  const hourly=await request(`/api/v1/hue/history?light_id=${id}&from=1800000000&to=1800003600&resolution=hour`);assert.equal((await hourly.json() as {samples:unknown[]}).samples.length,1);
  assert.equal((await request(`/api/v1/hue/history?light_id=${id}&from=0&to=1800000000`)).status,400);db.close();
});
