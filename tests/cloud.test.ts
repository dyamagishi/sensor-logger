import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { validateSample, aggregateSQL, insertBatchSQL } from '../cloud/model.ts';

test('reject unregistered sensors, stale timestamps and missing measurements',()=>{
  const now=1800000000;
  const row={sensor_id:'a',minute:now,observed_at:now+1,temperature:21.5,co2:null};
  assert.equal(validateSample(row,new Set(['a']),now).temperature,21.5);
  assert.throws(()=>validateSample({...row,sensor_id:'other'},new Set(['a']),now));
  assert.throws(()=>validateSample({...row,minute:now-90060},new Set(['a']),now));
  assert.throws(()=>validateSample({...row,temperature:null},new Set(['a']),now));
  assert.throws(()=>validateSample({...row,co2:65535},new Set(['a']),now));
});

test('hourly aggregation repairs late data without counting duplicates',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../cloud/migrations/0001_initial.sql',import.meta.url),'utf8'));
  const insert=db.prepare('INSERT INTO samples(sensor_id,minute,observed_at,received_at,temperature,humidity,co2) VALUES(?,?,?,?,?,?,?) ON CONFLICT(sensor_id,minute) DO NOTHING');
  insert.run('a',3600,3601,3602,20,50,null);
  db.prepare(aggregateSQL).run(3600,7200);
  insert.run('a',3660,3661,8000,24,60,1000);
  insert.run('a',3660,3661,8001,24,60,1000);
  db.prepare(aggregateSQL).run(3600,7200);
  const row=db.prepare('SELECT * FROM hourly').get()!;
  assert.equal(row.temperature_avg,22);assert.equal(row.temperature_min,20);assert.equal(row.temperature_max,24);
  assert.equal(row.sample_count,2);assert.equal(row.co2_count,1);assert.equal(row.co2_avg,1000);
  db.close();
});


test('300 minute records use one bound JSON insert and preserve spikes',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../cloud/migrations/0001_initial.sql',import.meta.url),'utf8'));
  const rows=Array.from({length:300},(_,i)=>({sensor_id:'a',minute:3600+i*60,observed_at:3601+i*60,temperature:i===1?80:20,humidity:40,co2:null,battery:90,rssi:-60}));
  db.prepare(insertBatchSQL).run(30000,JSON.stringify(rows));
  db.prepare(insertBatchSQL).run(30001,JSON.stringify(rows));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM samples').get()!.n,300);
  assert.deepEqual(db.prepare('SELECT temperature FROM samples ORDER BY minute LIMIT 3').all().map(r=>r.temperature),[20,80,20]);
  db.close();
});
