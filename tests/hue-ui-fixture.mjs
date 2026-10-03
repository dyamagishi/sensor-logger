// Local-only browser fixture: never contacts a real Bridge or cloud service.
// npm run build && node tests/hue-ui-fixture.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const id=n=>'hue-'+String(n).padStart(32,'0');
const values={on:false,brightness:65,mirek:300,x:0.4,y:0.35,color_mode:'temperature'};
const output=(n,name,extra={})=>({id:id(n),name,dimming:true,color:true,temperature:[153,500],values:{...values},available:true,connectivity:'connected',observed_at:Math.floor(Date.now()/1000),...extra});
const devices=[{id:id(1),name:'寝室 <Hue>',present:true,selected:true,outputs:[output(2,'左'),output(3,'右',{dimming:false,color:false,temperature:null})]},{id:id(4),name:'リビング',present:true,selected:false,outputs:[output(5,'照明')]},{id:id(6),name:'以前の照明',present:false,selected:false,outputs:[output(7,'照明',{available:false,connectivity:'removed'})]}];
const hue=()=>({state:'online',error:null,last_poll:Math.floor(Date.now()/1000),devices});
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');let body={};if(req.method==='POST'){const chunks=[];for await(const c of req)chunks.push(c);body=JSON.parse(Buffer.concat(chunks).toString());}
  const json=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
  if(url.pathname==='/api/status')return json({now:Math.floor(Date.now()/1000),sensors:[{id:'a',name:'寝室センサー',kind:'meter',stale:false,temperature:24.5,humidity:50,battery:90,events:20,observed_at:Math.floor(Date.now()/1000)}],hue:hue(),collector:{state:'disabled'},cloud:{state:'online',pending:0,dropped:0}});
  if(url.pathname==='/api/history'||url.pathname==='/api/hue/history'){
    const days=Number(url.searchParams.get('days')??1),bucket=days===365?3600:60,to=Math.floor(Date.now()/60000)*60+60,from=to-days*86400;
    const samples=Array.from({length:Math.min(1440,days*86400/bucket)},(_,i)=>{const minute=to-(1440-i)*bucket,available=i%70>3,on=i%120<65;return {minute,observed_at:minute+1,temperature:24+Math.sin(i/100),humidity:50,available,on:available?on:null,brightness:available?50+20*Math.sin(i/80):null,mirek:available?300:null,x:available?0.4:null,y:available?0.35:null,on_fraction:available?0.65:null,available_count:available?55:0,unavailable_count:available?5:60};}).filter(r=>r.minute>=from);
    return json({samples,from,to,bucket_seconds:bucket,source:'cloud'});
  }
  if(url.pathname==='/api/hue/devices'&&req.method==='POST'){const d=devices.find(d=>d.id===body.device_id);if(d)d.selected=body.selected;return json({ok:true});}
  if(url.pathname==='/api/hue/devices')return json({state:'online',devices:devices.filter(d=>d.present),archive:devices.filter(d=>!d.selected)});
  if(url.pathname==='/api/hue/control'){
    const o=devices.flatMap(d=>d.outputs).find(o=>o.id===body.light_id);if(!o)return json({error:'not found'},404);
    await new Promise(resolve=>setTimeout(resolve,500));
    if(body.brightness!==undefined&&body.brightness===99)return json({error:'操作結果を確認できませんでした。'},502);
    if(body.on!==undefined)o.values.on=body.on;else o.values.on=true;
    if(body.brightness!==undefined)o.values.brightness=body.brightness;if(body.mirek)o.values.mirek=body.mirek;if(body.xy)[o.values.x,o.values.y]=body.xy;
    return json(hue());
  }
  try{if(url.pathname!=='/'&&!/^\/assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname))return json({error:'not found'},404);const file=url.pathname==='/'?'index.html':url.pathname.slice(1);const bytes=await readFile(new URL('../dist/'+file,import.meta.url));res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(bytes);}catch{json({error:'not found'},404);}
});
server.listen(18765,'127.0.0.1',()=>console.log('Hue browser fixture: http://127.0.0.1:18765'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
