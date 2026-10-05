import test from 'node:test';
import assert from 'node:assert/strict';
import { AmbientRotation, CO2_NOTICE, IDLE_DELAY, isNight, PAGE_DURATIONS, slideDirection } from '../src/ambient.ts';

test('slide direction follows the loop, including trends/current in both directions',()=>{
  assert.equal(slideDirection(0,1,3),1);
  assert.equal(slideDirection(1,2,3),1);
  assert.equal(slideDirection(2,0,3),1);
  assert.equal(slideDirection(0,2,3),-1);
  assert.equal(slideDirection(2,1,3),-1);
  assert.equal(slideDirection(1,0,3),-1);
  assert.equal(slideDirection(0,0,3),0);
});

test('current values 30 minutes, clock 20 seconds, trends 20 seconds', () => {
  const rotation = new AmbientRotation(0);
  assert.equal(rotation.tick(PAGE_DURATIONS[0] - 1), false);
  assert.equal(rotation.tick(1_800_000), true);
  assert.equal(rotation.page, 1);
  assert.equal(rotation.tick(1_819_999), false);
  assert.equal(rotation.tick(1_820_000), true);
  assert.equal(rotation.page, 2);
  assert.equal(rotation.tick(1_840_000), true);
  assert.equal(rotation.page, 0);
});

test('interaction and open dialogs suspend rotation, idle resumes with a fresh duration', () => {
  const rotation = new AmbientRotation(0);
  rotation.select(1, 0);
  rotation.interact(19_000);
  assert.equal(rotation.tick(20_000), false);
  assert.equal(rotation.tick(300_000, true), false);
  assert.equal(rotation.tick(300_000 + IDLE_DELAY - 1), false);
  assert.equal(rotation.tick(300_000 + IDLE_DELAY), false);
  assert.equal(rotation.tick(300_000 + IDLE_DELAY + 20_000), true);
  assert.equal(rotation.page, 2);
});

test('manual swipes wrap and suspended tabs do not cause catch-up transitions', () => {
  const rotation = new AmbientRotation(0);
  rotation.select(-1, 0);
  assert.equal(rotation.page, 2);
  rotation.select(3, 0);
  assert.equal(rotation.page, 0);
  assert.equal(rotation.tick(86_400_000, true), false);
  assert.equal(rotation.tick(86_400_000 + IDLE_DELAY), false);
  assert.equal(rotation.page, 0);
});

test('night is midnight through 06:59 Japan time, independent of device timezone', () => {
  assert.equal(isNight(new Date('2026-10-05T14:59:59Z')), false);
  assert.equal(isNight(new Date('2026-10-05T15:00:00Z')), true);
  assert.equal(isNight(new Date('2026-10-05T21:59:59Z')), true);
  assert.equal(isNight(new Date('2026-10-05T22:00:00Z')), false);
  assert.equal(CO2_NOTICE, 1500);
});
