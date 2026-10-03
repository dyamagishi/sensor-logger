import './style.css';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { setupRegistration } from './registration';
import { setupHue, type HueStatus } from './hue';

type Metric = 'temperature'|'humidity'|'co2';
type Sensor = { id:string; name:string; kind:string; observed_at?:number; temperature?:number|null; humidity?:number|null; co2?:number|null; battery?:number|null; rssi?:number|null; stale:boolean; events:number };
type Row = { minute:number; temperature:number|null; humidity:number|null; co2:number|null };
type History = { samples:Row[]; source:string; cloud_error?:string; bucket_seconds:number; from:number; to:number };
type Status = { now:number; sensors:Sensor[]; hue?:HueStatus; collector:{state:string;error?:string}; cloud:{state:string;pending:number;dropped:number;last_sent?:number;next_send_at?:number} };
const icon = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 16 16 6l11 10M9 14v12h14V14M13 26v-8h6v8"/></svg>`;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<main class="dashboard"><header><div class="brand"><div class="brand-mark">${icon}</div><div><p class="eyebrow">HOME / ENVIRONMENT</p><h1>おうちの空気<span>いつもの場所を、ひと目で。</span></h1></div></div><div class="clock"><time id="clock">--:--</time><span id="date"></span></div></header><div class="section-label"><span><i class="live-dot"></i>いまのようす</span><span id="summary">センサーを確認しています</span></div><div class="graph-options" role="group" aria-label="表示するグラフ"><span>24時間グラフ</span><label><input type="checkbox" data-show="temperature" checked>温度</label><label><input type="checkbox" data-show="humidity" checked>湿度</label><label><input type="checkbox" data-show="co2" checked>CO₂</label><span class="selection-hint">複数選択可</span></div><div id="battery-alerts"></div><section id="sensors" class="sensor-grid" aria-label="センサー一覧"><div class="empty">センサーに接続しています…</div></section><footer><div id="connection">接続を確認しています</div><div class="footer-actions"><span id="refresh"></span><button id="fullscreen" aria-label="全画面表示">⛶ <span>全画面</span></button></div></footer></main><dialog id="detail"><div class="detail-head"><div><p class="eyebrow">HISTORY / 記録</p><h2 id="detail-name"></h2></div><button id="close" aria-label="閉じる">✕</button></div><div class="detail-controls"><div id="periods" class="segmented"><button data-days="1" class="active">24時間</button><button data-days="7">7日</button><button data-days="30">30日</button><button data-days="365">1年</button></div><div id="metrics" class="graph-options detail-options" role="group" aria-label="履歴に表示するグラフ"><label><input type="checkbox" data-detail-metric="temperature">温度</label><label><input type="checkbox" data-detail-metric="humidity">湿度</label><label><input type="checkbox" data-detail-metric="co2">CO₂</label></div></div><div id="plot"></div><p id="history-message"></p></dialog>`;
const cards = document.querySelector<HTMLDivElement>('#sensors')!;
const hue=setupHue();
const histories = new Map<string,History>();
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
const colors:Record<Metric,string> = {temperature:'#e4b886',humidity:'#86b9cd',co2:'#acd0a1'};
const labels:Record<Metric,string> = {temperature:'温度',humidity:'湿度',co2:'CO₂'};
const units:Record<Metric,string> = {temperature:'℃',humidity:'%',co2:'ppm'};
const escape = (v:string) => v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const value = (v:number|null|undefined, digits=0) => v==null?'—':v.toLocaleString('ja-JP',{minimumFractionDigits:digits,maximumFractionDigits:digits});
const age = (timestamp?:number) => { if (!timestamp) return '受信待ち'; const seconds=Math.max(0,Math.floor(Date.now()/1000-timestamp)); return seconds<60?`${seconds}秒前`:seconds<3600?`${Math.floor(seconds/60)}分前`:`${Math.floor(seconds/3600)}時間前`; };

function spark(history:History|undefined, metric:Metric) {
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
  return `<svg class="spark" viewBox="0 0 400 66" preserveAspectRatio="none" aria-label="直近24時間の${labels[metric]}推移"><path class="baseline" d="M4 60H396"/><path d="${d}" style="stroke:${colors[metric]}"/><circle cx="${4+(last.minute-from)/(to-from)*392}" cy="${55-(last[metric]!-min)/range*42}" r="2.5" fill="${colors[metric]}"/></svg>`;
}

function render() {
  if(!status)return;
  const active=status.sensors.filter(s=>!s.stale).length;
  document.querySelector('#summary')!.textContent=`${active} / ${status.sensors.length} 台 受信中`;
  cards.style.setProperty('--count',String(status.sensors.length));
  cards.classList.toggle('many',status.sensors.length>3);
  cards.innerHTML=status.sensors.map((s,index)=>{
    const hist=histories.get(s.id);
    const metrics=allMetrics.filter(m=>visibleMetrics.has(m)&&(m!=='co2'||s.kind==='co2'));
    const batteryLevel=s.battery==null?'unknown':s.battery<=10?'critical':s.battery<=20?'low':'normal';
    const batteryText=s.battery==null?'電池残量不明':`電池 ${s.battery}%`;
    const batteryNote=batteryLevel==='critical'?'電池を交換してください':batteryLevel==='low'?'電池残量が少なくなっています':'';
    const graphs=metrics.map(metric=>{
      const vals=(hist?.samples??[]).map(r=>r[metric]).filter((n):n is number=>n!=null);
      const extent=vals.length?`${value(Math.min(...vals),metric==='temperature'?1:0)} – ${value(Math.max(...vals),metric==='temperature'?1:0)} ${units[metric]}`:'記録待ち';
      return `<div class="mini-graph" data-graph="${metric}"><div class="trend-label"><span style="color:${colors[metric]}">${labels[metric]}</span><span>${extent} ↗</span></div>${spark(hist,metric)}</div>`;
    }).join('');
    return `<button class="sensor-card ${s.kind} battery-${batteryLevel} ${s.stale?'stale':''}" data-sensor="${escape(s.id)}" aria-label="${escape(s.name)}の履歴を見る"><div class="card-heading"><div><p class="eyebrow">SENSOR / ${String(index+1).padStart(2,'0')}</p><h2>${escape(s.name)}</h2></div><span class="sensor-status"><i></i>${s.stale?'未受信':'受信中'}</span></div>${batteryNote?`<div class="battery-notice ${batteryLevel}"><span aria-hidden="true">▰</span><strong>${batteryText}</strong><span>${batteryNote}</span></div>`:''}<div class="reading-pair"><div class="reading temperature"><span class="metric-label">温度</span><div><strong>${value(s.temperature,1)}</strong><span class="unit">℃</span></div></div><div class="reading humidity"><span class="metric-label">湿度</span><div><strong>${value(s.humidity)}</strong><span class="unit">%</span></div></div></div>${s.kind==='co2'?`<div class="co2-reading"><div class="metric-label">CO₂ <span>二酸化炭素</span></div><div><strong>${value(s.co2)}</strong><span class="unit">ppm</span></div></div>`:`<div class="quiet-note"><span class="leaf">◌</span><span>温度と湿度を、ゆっくり記録。</span></div>`}<div class="trend multi-trend">${graphs||'<div class="graphs-hidden">グラフ非表示 · 上のチェックで選べます</div>'}</div><div class="card-footer"><span>受信 ${age(s.observed_at)}</span><span class="battery-label ${batteryLevel}">${batteryText}${batteryLevel==='low'?' · 残量注意':batteryLevel==='critical'?' · 要交換':''}<span class="rssi"> / ${s.rssi??'—'} dBm</span></span></div></button>`;
  }).join('');
  cards.querySelectorAll<HTMLButtonElement>('[data-sensor]').forEach(button=>button.onclick=(event)=>{
    const metric=(event.target as Element).closest<HTMLElement>('[data-graph]')?.dataset.graph as Metric|undefined;
    openDetail(button.dataset.sensor!,metric);
  });
  const low=status.sensors.filter(s=>s.battery!=null&&s.battery<=20);
  document.querySelector('#battery-alerts')!.innerHTML=low.length?`<div class="battery-summary ${low.some(s=>s.battery!<=10)?'critical':'low'}"><strong>電池を確認</strong><span>${low.map(s=>`${escape(s.name)} ${s.battery}%${s.stale?'（最終受信時）':''}`).join(' ／ ')}</span></div>`:'';
  const cloudText:Record<string,string>={online:'クラウド保存は1時間ごと',buffering:'記録中・クラウド保存は1時間ごと',connecting:'クラウド接続待ち',offline:'クラウド未接続',unconfigured:'クラウド設定待ち'};
  const c=status.cloud;
  document.querySelector('#connection')!.innerHTML=`<span class="connection-dot ${c.state==='online'?'ok':''}"></span>${cloudText[c.state]??c.state}${c.pending?`<span class="subtle">・${c.pending}件 本体に蓄積</span>`:''}${c.next_send_at?`<span class="subtle">・次回 ${new Date(c.next_send_at*1000).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'})}</span>`:''}${c.dropped?`<span class="warning">・${c.dropped}件 欠測</span>`:''}${status.collector.state==='error'?'<span class="warning">・Bluetooth再接続中</span>':''}`;
  document.querySelector('#refresh')!.textContent='自動更新 5秒';
}

async function fetchHistory(sensor:string,days=1):Promise<History> {
  const response=await fetch(`/api/history?sensor_id=${encodeURIComponent(sensor)}&days=${days}`,{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('履歴を取得できません');
  return response.json();
}

async function updateHistories() {
  if(!status)return;
  await Promise.allSettled(status.sensors.map(async s=>{histories.set(s.id,await fetchHistory(s.id));}));
  render();
}

async function poll() {
  try {
    const response=await fetch('/api/status',{signal:AbortSignal.timeout(4000)});
    if(!response.ok)throw Error();
    const first=!status;
    status=await response.json();lastOk=Date.now();render();hue.update(status?.hue);
    if(first)void updateHistories();
  } catch {
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
function openDetail(id:string,metric?:Metric) {
  activeSensor=id;activeDays=1;detailMetrics=new Set([...visibleMetrics].filter(m=>m!=='co2'||status?.sensors.find(s=>s.id===id)?.kind==='co2'));try{const saved=JSON.parse(localStorage.getItem('home-sensors.detail.'+id)??'null');if(Array.isArray(saved))detailMetrics=new Set(saved.filter((m:Metric)=>allMetrics.includes(m)&&(m!=='co2'||status?.sensors.find(s=>s.id===id)?.kind==='co2')));}catch{}if(metric)detailMetrics.add(metric);
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
document.querySelector('#fullscreen')!.addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{document.querySelector('#refresh')!.textContent='ブラウザの全画面機能をご利用ください';}});
window.addEventListener('resize',()=>{plots.forEach(plot=>plot.setSize({width:document.querySelector<HTMLElement>('#plot')!.clientWidth,height:detailMetrics.size>1?200:Math.min(340,innerHeight*0.43)}));});
function clock(){const d=new Date();document.querySelector('#clock')!.textContent=d.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'});document.querySelector('#date')!.textContent=d.toLocaleDateString('ja-JP',{month:'long',day:'numeric',weekday:'long',timeZone:'Asia/Tokyo'});}
clock();setInterval(clock,1000);setInterval(()=>void updateHistories(),60000);void poll();

setupRegistration(async()=>{
  const response=await fetch('/api/status');
  if(response.ok){status=await response.json();render();void updateHistories();}
});
