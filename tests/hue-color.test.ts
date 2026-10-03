import test from 'node:test';
import assert from 'node:assert/strict';
import { hexToXY,xyToHex } from '../src/hue-color.ts';
test('Hue color conversion preserves primaries and keeps black finite',()=>{
  for(const color of ['#ff0000','#00ff00','#0000ff','#ffffff','#e08040']){
    const [x,y]=hexToXY(color);assert.ok(x>=0&&y>0&&x+y<=1);const result=xyToHex(x,y);
    // xy describes chromaticity, not brightness: normalize expected RGB luminance.
    const max=Math.max(...[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)));
    for(const i of [1,3,5])assert.ok(Math.abs(parseInt(result.slice(i,i+2),16)-parseInt(color.slice(i,i+2),16)*255/max)<5,`${color}: ${result}`);
  }
  assert.ok(hexToXY('#000000').every(Number.isFinite));assert.equal(xyToHex(0,0),'#000000');
});
