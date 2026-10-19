import test from 'node:test';
import assert from 'node:assert/strict';
import { metricRange, timeLabels } from '../src/plot-axes.ts';

test('constant and narrow readings retain meaningful scale and margins', () => {
  for (const [metric, value, minimum] of [['temperature',28,2],['humidity',60,10],['co2',900,200]] as const) {
    const [lo,hi]=metricRange(metric,value,value);
    assert.ok(lo < value && hi > value);
    assert.ok(hi-lo >= minimum);
  }
});
test('humidity respects limits while retaining unusual observations', () => {
  assert.deepEqual(metricRange('humidity',0,100),[0,100]);
  const [lo,hi]=metricRange('humidity',-2,102);
  assert.ok(lo<=-2 && hi>=102);
  assert.deepEqual(metricRange('co2',Infinity,-Infinity),[0,2000]);
});
test('short periods distinguish times, long periods show the year', () => {
  const ticks=[Date.parse('2026-10-12T00:00:00+09:00')/1000,Date.parse('2026-10-12T12:00:00+09:00')/1000,Date.parse('2026-10-13T00:00:00+09:00')/1000];
  assert.equal(new Set(timeLabels(ticks,7*86400)).size,3);
  assert.ok(timeLabels(ticks,86400)[2].includes('10/13'));
  assert.ok(timeLabels(ticks,365*86400)[0].includes('2026'));
});
