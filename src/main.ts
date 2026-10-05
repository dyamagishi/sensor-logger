import './style.css';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { setupRegistration } from './registration';
import { setupHue, type HueStatus } from './hue';
import { AmbientRotation, CO2_NOTICE, isNight } from './ambient';
import { ambientView } from './ambient-view';
import { AmbientSlider } from './ambient-slider';
import './ambient.css';

type Metric = 'temperature'|'humidity'|'co2';
type Sensor = { id:string; name:string; kind:string; observed_at?:number; temperature?:number|null; humidity?:number|null; co2?:number|null; battery?:number|null; rssi?:number|null; stale:boolean; events:number };
type Row = { minute:number; temperature:number|null; humidity:number|null; co2:number|null };
type History = { samples:Row[]; source:string; cloud_error?:string; bucket_seconds:number; from:number; to:number };
type Status = { now:number; sensors:Sensor[]; hue?:HueStatus; collector:{state:string;error?:string}; cloud:{state:string;pending:number;dropped:number;last_sent?:number;next_send_at?:number} };
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = ambientView;
const cards = document.querySelector<HTMLDivElement>('#sensors')!;
const hue=setupHue(document.querySelector<HTMLElement>('#hue-controls')!);
const histories = new Map<string,History>();
const weekHistories = new Map<string,History>();
const weekErrors = new Set<string>();
let weekLoading=false;
const sparkCache=new WeakMap<History,Map<string,string>>();
let trendRevision=0;
let renderedTrends='';
const allMetrics:Metric[]=['temperature','humidity','co2'];
let visibleMetrics=new Set<Metric>(allMetrics);
try { const saved=JSON.parse(localStorage.getItem('home-sensors.graphs')??'null'); if(Array.isArray(saved))visibleMetrics=new Set(saved.filter((m:Metric)=>allMetrics.includes(m))); } catch {}
document.querySelectorAll<HTMLInputElement>('[data-show]').forEach(input=>{
  input.checked=visibleMetrics.has(input.dataset.show as Metric);
  input.onchange=()=>{const metric=input.dataset.show as Metric; if(input.checked)visibleMetrics.add(metric);else visibleMetrics.delete(metric);try{localStorage.setItem('home-sensors.graphs',JSON.stringify([...visibleMetrics]));}catch{}render();};
});
let status:Status|undefined;
let activeSensor:string|undefined;
let activeDays=1;
let detailMetrics=new Set<Metric>();
let plots:uPlot[]=[];
let historySequence=0;
let lastOk=0;
let disconnected=false;
const colors:Record<Metric,string> = {temperature:'#e4b886',humidity:'#86b9cd',co2:'#acd0a1'};
const labels:Record<Metric,string> = {temperature:'温度',humidity:'湿度',co2:'CO₂'};
const units:Record<Metric,string> = {temperature:'℃',humidity:'%',co2:'ppm'};
const escape = (v:string) => v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const value = (v:number|null|undefined, digits=0) => v==null?'—':v.toLocaleString('ja-JP',{minimumFractionDigits:digits,maximumFractionDigits:digits});
const age = (timestamp?:number) => { if (!timestamp) return '受信待ち'; const seconds=Math.max(0,Math.floor(Date.now()/1000-timestamp)); return seconds<60?`${seconds}秒前`:seconds<3600?`${Math.floor(seconds/60)}分前`:`${Math.floor(seconds/3600)}時間前`; };

function spark(history:History|undefined, metric:Metric, days=1) {
  const key=`${metric}:${days}`;
  const cached=history&&sparkCache.get(history)?.get(key);
  if(cached)return cached;
  const rows=history?.samples ?? [];
  const vals=rows.map(r=>r[metric]).filter((n):n is number=>n!=null);
  if(!vals.length) return '<div class="spark-empty">記録を集めています</div>';
  const min=Math.min(...vals), max=Math.max(...vals), range=Math.max(max-min,metric==='co2'?100:metric==='temperature'?1:5);
  const from=history!.from, to=history!.to;
  let d='', previous:number|undefined;
  for(const row of rows) {
    const n=row[metric]; if(n==null) { previous=undefined;continue; }
    const x=4+(row.minute-from)/(to-from)*392;
    const y=55-(n-min)/range*42;
    d+=`${previous===undefined||row.minute-previous>history!.bucket_seconds*1.5?'M':'L'}${x.toFixed(2)},${y.toFixed(2)} `;
    previous=row.minute;
  }
  const points=rows.filter(r=>r[metric]!=null);
  const last=points[points.length-1];
  const svg=`<svg class="spark" viewBox="0 0 400 66" preserveAspectRatio="none" aria-label="直近${days===1?'24時間':`${days}日間`}の${labels[metric]}推移"><path class="baseline" d="M4 60H396"/><path d="${d}" style="stroke:${colors[metric]}"/><circle cx="${4+(last.minute-from)/(to-from)*392}" cy="${55-(last[metric]!-min)/range*42}" r="2.5" fill="${colors[metric]}"/></svg>`;
  const entries=sparkCache.get(history!)??new Map<string,string>();
  entries.set(key,svg);sparkCache.set(history!,entries);
  return svg;
}

function render() {
  if(!status)return;
  const active=status.sensors.filter(s=>!sensorStale(s)).length;
  document.querySelector('#summary')!.textContent=`${active} / ${status.sensors.length} 台 受信中`;
  cards.style.setProperty('--count',String(status.sensors.length));
  cards.classList.toggle('many',status.sensors.length>2);
  // Retain the button nodes across polls so keyboard focus and touch targets survive.
  const existing=new Map(Array.from(cards.querySelectorAll<HTMLButtonElement>('[data-sensor]')).map(b=>[b.dataset.sensor!,b]));
  cards.querySelector('.ambient-empty')?.remove();
  for(const s of status.sensors) {
    let button=existing.get(s.id);
    if(!button){button=document.createElement('button');button.dataset.sensor=s.id;button.onclick=()=>openDetail(s.id);cards.appendChild(button);}
    existing.delete(s.id);
    button.className=`ambient-sensor ${sensorStale(s)?'stale':''}`;
    button.setAttribute('aria-label',`${s.name}の履歴を見る`);
    button.innerHTML=`<div class="ambient-sensor-name"><h2>${escape(s.name)}</h2><span>${sensorStale(s)?'受信待ち':'直近24時間'}</span></div><div class="ambient-readings">${allMetrics.filter(m=>m!=='co2'||s.kind==='co2').map(m=>`<div class="ambient-reading ${m}"><div class="ambient-reading-value"><span class="ambient-metric-label">${labels[m]}</span><div><strong>${value(s[m],m==='temperature'?1:0)}</strong><span class="ambient-unit">${units[m]}</span></div></div><div class="ambient-reading-graph">${spark(histories.get(s.id),m)}</div></div>`).join('')}</div><span class="ambient-card-hint">${sensorStale(s)?'最終受信値 · ':''}タップして記録を見る <span aria-hidden="true">↗</span></span>`;
  }
  existing.forEach(b=>b.remove());
  if(!status.sensors.length)cards.innerHTML='<div class="ambient-empty">センサーが未登録です。「照明・設定」から追加できます。</div>';
  document.querySelector('#sensor-health')!.innerHTML=status.sensors.map(s=>`<p><strong>${escape(s.name)}</strong><span>${sensorStale(s)?'受信停止':'受信中'} · ${age(s.observed_at)} · 電池 ${value(s.battery)}% · ${value(s.rssi)} dBm</span></p>`).join('');
  renderTrends();
  renderNotices();
  const compact=status.sensors.map(s=>`<span><b>${escape(s.name)}</b>${value(s.temperature,1)}° · ${value(s.humidity)}%${s.kind==='co2'?` · ${value(s.co2)} ppm`:''}${sensorStale(s)?' · 最終値':''}</span>`).join('');
  document.querySelectorAll('[data-compact]').forEach(el=>el.innerHTML=compact);
  const low=status.sensors.filter(s=>s.battery!=null&&s.battery<=20);
  document.querySelector('#battery-alerts')!.innerHTML=low.length?`<div class="battery-summary ${low.some(s=>s.battery!<=10)?'critical':'low'}"><strong>電池を確認</strong><span>${low.map(s=>`${escape(s.name)} ${s.battery}%${s.stale?'（最終受信時）':''}`).join(' ／ ')}</span></div>`:'';
  const cloudText:Record<string,string>={online:'クラウド保存は1時間ごと',buffering:'記録中・クラウド保存は1時間ごと',connecting:'クラウド接続待ち',offline:'クラウド未接続',unconfigured:'クラウド設定待ち'};
  const c=status.cloud;
  document.querySelector('#connection')!.innerHTML=`<span class="connection-dot ${c.state==='online'?'ok':''}"></span>${cloudText[c.state]??c.state}${c.pending?`<span class="subtle">・${c.pending}件 本体に蓄積</span>`:''}${c.next_send_at?`<span class="subtle">・次回 ${new Date(c.next_send_at*1000).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'})}</span>`:''}${c.dropped?`<span class="warning">・${c.dropped}件 欠測</span>`:''}${status.collector.state==='error'?'<span class="warning">・Bluetooth再接続中</span>':''}`;
  document.querySelector('#refresh')!.textContent='自動更新 5秒';
}

function sensorStale(sensor:Sensor) {
  return sensor.stale||!sensor.observed_at||Date.now()/1000-sensor.observed_at>=180;
}

function renderNotices() {
  const notices:string[]=[];
  if(disconnected)notices.push('接続できません · 表示は最終受信値です');
  if(status){
    const stale=status.sensors.filter(sensorStale);
    if(stale.length)notices.push(`${stale.map(s=>s.name).join('・')} · 受信停止`);
    const high=status.sensors.filter(s=>s.co2!=null&&s.co2>=CO2_NOTICE);
    if(high.length)notices.push(`${high.map(s=>s.name).join('・')} · CO₂ 1,500 ppm以上 / 換気の目安${disconnected||high.some(sensorStale)?'（最終受信値）':''}`);
    if(status.collector.state==='error')notices.push('Bluetooth再接続中');
  }
  document.querySelectorAll<HTMLElement>('[data-notice]').forEach(el=>{const text=notices.join('　／　');if(el.textContent!==text)el.textContent=text;el.hidden=!text;});
}

function renderTrends() {
  if(!status)return;
  const key=JSON.stringify([status.sensors.map(s=>[s.id,s.name,s.kind]),[...visibleMetrics],trendRevision]);
  if(key===renderedTrends)return;
  renderedTrends=key;
  const root=document.querySelector<HTMLElement>('#ambient-trends')!;
  root.style.setProperty('--count',String(status.sensors.length));
  root.innerHTML=status.sensors.map(s=>{
    const hist=weekHistories.get(s.id);
    const graphs=allMetrics.filter(m=>visibleMetrics.has(m)&&(m!=='co2'||s.kind==='co2')).map(m=>{
      const vals=(hist?.samples??[]).map(r=>r[m]).filter((n):n is number=>n!=null);
      const extent=vals.length?`${value(Math.min(...vals),m==='temperature'?1:0)} – ${value(Math.max(...vals),m==='temperature'?1:0)} ${units[m]}`:'記録待ち';
      return `<button class="ambient-graph" data-sensor="${escape(s.id)}" data-graph="${m}" aria-label="${escape(s.name)}の7日間の${labels[m]}履歴を見る"><div class="trend-label"><span style="color:${colors[m]}">${labels[m]}</span><span>${extent}</span></div>${spark(hist,m,7)}</button>`;
    }).join('');
    const day=(time:number)=>new Date(time*1000).toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric'});
    const note=weekErrors.has(s.id)?hist?'取得済みの記録を表示中':'履歴を取得できません':hist?.source==='memory'?'本体に残っている記録のみ':hist?.source==='cached'||hist?.cloud_error?'取得済みの記録を表示中':'';
    return `<section class="ambient-trend-sensor"><h2>${escape(s.name)}</h2>${graphs||'<p class="ambient-empty">グラフは設定で選べます</p>'}${hist?`<div class="ambient-trend-axis"><span>${day(hist.from)}</span><span>${day(hist.to)}</span></div>`:''}${note?`<p class="ambient-history-note">${note}</p>`:''}</section>`;
  }).join('')||'<div class="ambient-empty">センサーが未登録です</div>';
}
document.querySelector('#ambient-trends')!.addEventListener('click',event=>{
  const button=(event.target as Element).closest<HTMLButtonElement>('[data-sensor]');
  if(button)openDetail(button.dataset.sensor!,button.dataset.graph as Metric,7);
});

async function fetchHistory(sensor:string,days=1):Promise<History> {
  const response=await fetch(`/api/history?sensor_id=${encodeURIComponent(sensor)}&days=${days}`,{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('履歴を取得できません');
  return response.json();
}

async function updateHistories() {
  if(!status)return;
  await Promise.allSettled(status.sensors.map(async s=>{histories.set(s.id,await fetchHistory(s.id));}));
  trendRevision++;
  render();
}

async function updateWeekHistories() {
  if(!status||weekLoading)return;
  weekLoading=true;
  try {
    // Avoid simultaneous week-long cloud requests on the router.
    for(const sensor of status.sensors) {
      try {weekHistories.set(sensor.id,await fetchHistory(sensor.id,7));weekErrors.delete(sensor.id);}
      catch {weekErrors.add(sensor.id);}
      trendRevision++;renderTrends();
    }
  } finally {weekLoading=false;}
}

async function poll() {
  try {
    const response=await fetch('/api/status',{signal:AbortSignal.timeout(4000)});
    if(!response.ok)throw Error();
    const first=!status;
    status=await response.json();lastOk=Date.now();disconnected=false;render();hue.update(status?.hue);
    if(first){void updateHistories();void updateWeekHistories();}
  } catch {
    disconnected=true;renderNotices();
    hue.disconnected();
    document.querySelector('#connection')!.textContent='NanoPiに接続できません。表示は最終受信時の値です。';
    cards.classList.add('disconnected');
    document.querySelector('#refresh')!.textContent=lastOk?`最終接続 ${age(lastOk/1000)}`:'再接続待ち';
  } finally {
    if(Date.now()-lastOk<5000)cards.classList.remove('disconnected');
    window.setTimeout(poll,5000);
  }
}

const dialog=document.querySelector<HTMLDialogElement>('#detail')!;
function openDetail(id:string,metric?:Metric,days=1) {
  showPage(0);rotation.interact();
  activeSensor=id;activeDays=days;detailMetrics=new Set([...visibleMetrics].filter(m=>m!=='co2'||status?.sensors.find(s=>s.id===id)?.kind==='co2'));try{const saved=JSON.parse(localStorage.getItem('home-sensors.detail.'+id)??'null');if(Array.isArray(saved))detailMetrics=new Set(saved.filter((m:Metric)=>allMetrics.includes(m)&&(m!=='co2'||status?.sensors.find(s=>s.id===id)?.kind==='co2')));}catch{}if(metric)detailMetrics.add(metric);
  document.querySelector('#detail-name')!.textContent=status?.sensors.find(s=>s.id===id)?.name??id;
  dialog.showModal();void drawDetail();
}
async function drawDetail() {
  if(!activeSensor)return;
  const seq=++historySequence;
  document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach(b=>b.classList.toggle('active',Number(b.dataset.days)===activeDays));
  document.querySelectorAll<HTMLInputElement>('[data-detail-metric]').forEach(b=>{b.checked=detailMetrics.has(b.dataset.detailMetric as Metric);b.parentElement!.hidden=b.dataset.detailMetric==='co2'&&status?.sensors.find(s=>s.id===activeSensor)?.kind!=='co2';});
  const msg=document.querySelector('#history-message')!;
  msg.textContent='履歴を読み込んでいます…';
  try {
    const hist=await fetchHistory(activeSensor,activeDays);
    if(seq!==historySequence||!dialog.open)return;
    plots.forEach(p=>p.destroy());plots=[];
    const root=document.querySelector<HTMLDivElement>('#plot')!;root.replaceChildren();
    for(const activeMetric of allMetrics.filter(m=>detailMetrics.has(m))) {
    const xs:number[]=[],ys:(number|null)[]=[];
    let prev:number|undefined;
    for(const row of hist.samples) {
      if(prev!==undefined&&row.minute-prev>hist.bucket_seconds*1.5){xs.push(prev+hist.bucket_seconds);ys.push(null);}
      xs.push(row.minute);ys.push(row[activeMetric]);prev=row.minute;
    }
    const section=document.createElement('section');section.className='detail-chart';
    const heading=document.createElement('h3');heading.textContent=labels[activeMetric]+' / '+units[activeMetric];heading.style.color=colors[activeMetric];section.appendChild(heading);
    const el=document.createElement('div');section.appendChild(el);root.appendChild(section);
    plots.push(new uPlot({width:el.clientWidth,height:detailMetrics.size>1?200:Math.min(340,innerHeight*0.43),tzDate:ts=>uPlot.tzDate(new Date(ts*1000),'Asia/Tokyo'),cursor:{drag:{x:true,y:false}},legend:{show:true},series:[{label:'日時',value:'{YYYY}/{M}/{D} {HH}:{mm}'},{label:labels[activeMetric],stroke:colors[activeMetric],width:2,spanGaps:false,points:{show:xs.length<10},value:(_u,n)=>n==null?'—':`${value(n,activeMetric==='temperature'?1:0)} ${units[activeMetric]}`}],axes:[{values:(_u,ticks)=>ticks.map(ts=>(activeDays===1?new Date(ts*1000).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'})+'\n':'')+new Date(ts*1000).toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric'})),stroke:'#93a5ad',grid:{stroke:'#26363f'},font:'12px sans-serif'},{stroke:'#93a5ad',grid:{stroke:'#26363f'},size:60,font:'12px sans-serif'}],scales:{x:{time:true,range:()=>[hist.from,hist.to]},y:{auto:true}}},[xs,ys],el));
    }
    if(!detailMetrics.size){msg.textContent='表示するグラフをチェックしてください。';return;}
    const messages=[activeDays===365?'1時間集計（長期保存）を表示しています。':'1分ごとの記録を間引かず表示しています。',hist.samples.length?'欠測区間は線をつないでいません。':'この期間の記録はまだありません。'];
    if(hist.source==='memory')messages.push('現在は本体のメモリ内の記録を表示しています。');
    if(hist.source==='cached'||hist.cloud_error)messages.push('クラウドに接続できないため、取得済みの記録を表示しています。');
    msg.textContent=messages.join(' ');
  } catch { if(seq===historySequence)msg.textContent='履歴を取得できませんでした。時間をおいて再度お試しください。'; }
}
document.querySelector('#close')!.addEventListener('click',()=>dialog.close());
dialog.addEventListener('close',()=>{historySequence++;plots.forEach(p=>p.destroy());plots=[];});
document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach(b=>b.onclick=()=>{activeDays=Number(b.dataset.days);void drawDetail();});
document.querySelectorAll<HTMLInputElement>('[data-detail-metric]').forEach(b=>b.onchange=()=>{const m=b.dataset.detailMetric as Metric;if(b.checked)detailMetrics.add(m);else detailMetrics.delete(m);try{localStorage.setItem('home-sensors.detail.'+activeSensor,JSON.stringify([...detailMetrics]));}catch{}void drawDetail();});
const standalone=window.matchMedia('(display-mode: standalone)').matches||(navigator as Navigator&{standalone?:boolean}).standalone===true;
if(standalone)document.querySelector<HTMLButtonElement>('#fullscreen')!.hidden=true;
document.querySelector('#fullscreen')!.addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{document.querySelector('#refresh')!.textContent='ブラウザの全画面機能をご利用ください';}});
window.addEventListener('resize',()=>{plots.forEach(plot=>plot.setSize({width:document.querySelector<HTMLElement>('#plot')!.clientWidth,height:detailMetrics.size>1?200:Math.min(340,innerHeight*0.43)}));});
const rotation=new AmbientRotation();
const stage=document.querySelector<HTMLElement>('.ambient')!;
const slider=new AmbientSlider(Array.from(document.querySelectorAll<HTMLElement>('.ambient-page')));
const management=document.querySelector<HTMLDialogElement>('#management')!;
function showPage(page:number,direction?:number) {
  rotation.select(page);
  slider.select(rotation.page,direction);
}
document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button=>button.onclick=()=>{rotation.interact();showPage(Number(button.dataset.page));});
document.querySelectorAll<HTMLButtonElement>('[data-manage-screen]').forEach(button=>button.onclick=()=>{showPage(0);management.showModal();});
document.querySelector('[data-close-management]')!.addEventListener('click',()=>management.close());
let touchStart:{x:number;y:number}|undefined;
let swiped=false;
stage.addEventListener('touchstart',event=>{rotation.interact();if(event.touches.length!==1){touchStart=undefined;return;}const t=event.touches[0];touchStart={x:t.clientX,y:t.clientY};swiped=false;},{passive:true});
stage.addEventListener('touchend',event=>{
  if(!touchStart)return;
  const t=event.changedTouches[0],dx=t.clientX-touchStart.x,dy=t.clientY-touchStart.y;
  touchStart=undefined;
  if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5){swiped=true;rotation.interact();const direction=dx<0?1:-1;showPage(rotation.page+direction,direction);}
},{passive:true});
stage.addEventListener('touchcancel',()=>{touchStart=undefined;});
stage.addEventListener('click',event=>{
  if(swiped){event.preventDefault();event.stopPropagation();swiped=false;return;}
  if(!(event.target as Element).closest('button'))showPage(0);
},true);
for(const type of ['pointerdown','keydown','input'])document.addEventListener(type,()=>rotation.interact(),true);
document.addEventListener('close',()=>rotation.interact(),true);
document.addEventListener('visibilitychange',()=>{rotation.interact();if(!document.hidden){clock();renderNotices();}});
function clock(){
  const d=new Date();
  document.querySelectorAll('[data-clock]').forEach(el=>el.textContent=d.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'}));
  document.querySelectorAll('[data-date]').forEach(el=>el.textContent=d.toLocaleDateString('ja-JP',{month:'long',day:'numeric',weekday:'long',timeZone:'Asia/Tokyo'}));
  document.documentElement.classList.toggle('ambient-night',isNight(d));
}
showPage(0);clock();
setInterval(()=>{clock();renderNotices();if(rotation.tick(Date.now(),document.hidden||!!document.querySelector('dialog[open]')))showPage(rotation.page,1);},1000);
setInterval(()=>void updateHistories(),60000);
setInterval(()=>void updateWeekHistories(),300000);void poll();

setupRegistration(async()=>{
  const response=await fetch('/api/status');
  if(response.ok){status=await response.json();render();void updateHistories();void updateWeekHistories();}
},document.querySelector<HTMLElement>('#registration-actions')!);
