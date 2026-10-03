// Hue API v2 uses CIE xy. Device gamut clipping happens on the backend.
export function hexToXY(hex:string):[number,number] {
  const rgb=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c>0.04045?((c+0.055)/1.055)**2.4:c/12.92);
  const [r,g,b]=rgb;
  const x=r*0.664511+g*0.154324+b*0.162028;
  const y=r*0.283881+g*0.668433+b*0.047685;
  const z=r*0.000088+g*0.072310+b*0.986039;
  const sum=x+y+z;return sum>0?[x/sum,y/sum]:[0.3127,0.3290];
}
export function xyToHex(x:number,y:number):string {
  if(y<=0)return '#000000';
  const X=x/y,Y=1,Z=(1-x-y)/y;
  let rgb=[X*1.656492-Y*0.354851-Z*0.255038,-X*0.707196+Y*1.655397+Z*0.036152,X*0.051713-Y*0.121364+Z*1.011530].map(c=>Math.max(0,c));
  const max=Math.max(1,...rgb);rgb=rgb.map(c=>c/max).map(c=>c<=0.0031308?12.92*c:1.055*c**(1/2.4)-0.055);
  return '#'+rgb.map(c=>Math.round(Math.min(1,Math.max(0,c))*255).toString(16).padStart(2,'0')).join('');
}
