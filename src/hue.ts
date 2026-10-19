import uPlot from 'uplot';
import { metricRange, timeAxis, valueAxis } from './plot-axes';
import { hexToXY, xyToHex } from './hue-color';

type Values={on:boolean|null;brightness:number|null;mirek:number|null;x:number|null;y:number|null;color_mode:string|null};
type Output={id:string;name:string;dimming:boolean;color:boolean;temperature:[number,number]|null;values:Values;available:boolean;connectivity:string;observed_at:number|null};
type Device={id:string;name:string;selected:boolean;present:boolean;outputs:Output[]};
export type HueStatus={state:string;error:string|null;last_poll:number|null;devices:Device[]};
type Row=Values&{minute:number;available?:boolean;on_fraction?:number|null;available_count?:number;unavailable_count?:number;sample_count?:number};
type History={samples:Row[];from:number;to:number;bucket_seconds:number;source:string;cloud_error?:string};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const display=(n:number|null|undefined,digits=0)=>n==null?'—':n.toLocaleString('ja-JP',{maximumFractionDigits:digits});
const timestamp=(n:number)=>new Date(n*1000).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
const kelvin=(mirek:number|null)=>mirek?1_000_000/mirek:null;
function confirmed(row:Row,hour:boolean){return hour?(row.available_count??0)>0:row.available===true;}
function point(row:Row,metric:string,hour:boolean):number|null {
  if(!confirmed(row,hour))return null;
  if(metric==='on')return hour?row.on_fraction==null?null:row.on_fraction*100:row.on==null?null:row.on?100:0;
  if(metric==='brightness')return hour?row.brightness:row.on?row.brightness:null;
  return hour||row.on?kelvin(row.mirek):null;
}
function band(hist:History|undefined) {
  if(!hist?.samples.length)return '<div class="spark-empty">記録を集めています</div>';
  const blocks:{from:number;to:number;on:boolean}[]=[];
  for(const r of hist.samples){if(!r.available||r.on==null)continue;const last=blocks.at(-1);if(last&&last.on===r.on&&last.to===r.minute){last.to=r.minute+60;}else blocks.push({from:r.minute,to:r.minute+60,on:r.on});}
  return `<svg class="hue-band" viewBox="0 0 400 18" preserveAspectRatio="none" role="img" aria-label="24時間の点灯状態。黄は点灯、青灰は消灯、背景は不明"><rect width="400" height="18" fill="#102027"/>${blocks.map(b=>`<rect x="${(b.from-hist.from)/(hist.to-hist.from)*400}" width="${(b.to-b.from)/(hist.to-hist.from)*400}" height="18" fill="${b.on?'#e4b886':'#49616c'}"/>`).join('')}</svg>`;
}
function spark(hist:History|undefined) {
  if(!hist?.samples.length)return '';
  let path='',prev:number|undefined;
  for(const r of hist.samples){const n=point(r,'brightness',false);if(n==null){prev=undefined;continue;}path+=`${prev==null||r.minute-prev>90?'M':'L'}${((r.minute-hist.from)/(hist.to-hist.from)*392+4).toFixed(2)},${(55-n*0.45).toFixed(2)} `;prev=r.minute;}
  return `<svg class="spark" viewBox="0 0 400 66" preserveAspectRatio="none" aria-label="点灯中の明るさ 0〜100%"><path class="baseline" d="M4 60H396"/><path d="${path}" style="stroke:#e4b886"/></svg><div class="hue-axis"><span>${timestamp(hist.from).split(' ')[1]??'24時間前'}</span><span>現在</span></div>`;
}
export function setupHue(container?:HTMLElement) {
  const section=document.createElement('section');section.className='hue-section';section.setAttribute('aria-label','Hue照明');
  section.innerHTML=`<div class="section-label"><span>照明 / HUE</span><div class="hue-actions"><button class="add-sensor" data-manage>照明を選択</button><button class="add-sensor" data-archive>過去の履歴</button></div></div><p class="hue-message" role="status"></p><div class="hue-grid"></div>`;
  if(container)container.appendChild(section);
  else document.querySelector('footer')!.parentElement!.insertBefore(section,document.querySelector('footer'));
  const grid=section.querySelector<HTMLDivElement>('.hue-grid')!;
  const manage=document.createElement('dialog');manage.className='hue-dialog';manage.innerHTML=`<div class="detail-head"><h2>照明を選択</h2><button data-close aria-label="閉じる">✕</button></div><p class="registration-intro">個々のデバイスを選択します。名前はHue側に追従します。登録解除後も過去の履歴は保存期限まで残ります。</p><div data-list></div><p data-message role="status"></p>`;document.body.appendChild(manage);
  const detail=document.createElement('dialog');detail.className='hue-dialog';detail.innerHTML=`<div class="detail-head"><h2 data-name></h2><button data-close aria-label="閉じる">✕</button></div><div class="segmented" data-periods>${[[1,'24時間'],[7,'7日'],[30,'30日'],[365,'1年']].map(([n,s])=>`<button data-hue-days="${n}">${s}</button>`).join('')}</div><div data-charts></div><div data-color class="hue-color-readout"></div><p data-message role="status"></p>`;document.body.appendChild(detail);
  manage.querySelector<HTMLButtonElement>('[data-close]')!.onclick=()=>manage.close();detail.querySelector<HTMLButtonElement>('[data-close]')!.onclick=()=>detail.close();
  let current:HueStatus|undefined;let histories=new Map<string,History>();const busy=new Set<string>();const messages=new Map<string,string>();let plots:uPlot[]=[];let active:string|undefined;let days=1;let seq=0;let lastHistory=0;let loading=false;
  const api=async<T>(path:string,body?:unknown):Promise<T>=>{const response=await fetch(path,{signal:AbortSignal.timeout(40000),...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Home-Sensors':'1'},body:JSON.stringify(body)})});const data:unknown=await response.json();if(!response.ok)throw Error((data as {error?:string}).error??'操作できませんでした');return data as T;};
  const fetchHistory=(id:string,period=1):Promise<History>=>api<History>(`/api/hue/history?light_id=${encodeURIComponent(id)}&days=${period}`);
  function render(force=false) {
    if(!current)return;
    section.querySelector('.hue-message')!.textContent=current.state==='unconfigured'?'Hueは未設定です。管理者用CLIで接続設定を生成してください。':current.error??'状態取得・記録は1分ごと。明るさや色を変更すると点灯します。';
    section.querySelector<HTMLButtonElement>('[data-manage]')!.disabled=current.state!=='online';
    if(!force&&(busy.size>0||(grid.contains(document.activeElement)&&document.activeElement instanceof HTMLInputElement)))return;
    const selected=current.devices.filter(d=>d.selected);
    grid.innerHTML=selected.length?selected.map(d=>`<article class="sensor-card hue-card"><div class="card-heading"><div><p class="eyebrow">LIGHT / HUE</p><h2>${escape(d.name)}</h2></div></div>${d.outputs.filter(o=>o.connectivity!=='removed').map(o=>{
      const inactive=!o.available||current!.state!=='online';const v=o.values;const ct=o.temperature;const id=o.id;
      return `<section class="hue-output" data-output="${id}"><h3>${d.outputs.length>1?escape(o.name):'現在の状態'}</h3><div class="hue-current"><strong>${v.on==null?'不明':v.on?'点灯':'消灯'}</strong><span>${inactive?'取得不可 · 最終確認値':'確認済み'}${o.observed_at?` · ${escape(timestamp(o.observed_at))}`:''}</span></div><div class="hue-controls"><button data-toggle="${id}" ${inactive?'disabled':''}>${v.on?'消灯する':'点灯する'}</button>${o.dimming?`<label>明るさ <output>${display(v.brightness)}%</output><input aria-label="${escape(d.name)} ${escape(o.name)}の明るさ" data-brightness="${id}" type="range" min="0" max="100" step="1" value="${v.brightness??50}" ${inactive?'disabled':''}></label>`:''}${ct?`<label>色温度 <output>${display(kelvin(v.mirek))} K</output><input aria-label="${escape(d.name)} ${escape(o.name)}の色温度" data-temperature="${id}" type="range" min="${Math.ceil(1_000_000/ct[1])}" max="${Math.floor(1_000_000/ct[0])}" step="1" value="${kelvin(v.mirek)??1_000_000/ct[1]}" ${inactive?'disabled':''}></label>`:''}${o.color?`<label>色 <input aria-label="${escape(d.name)} ${escape(o.name)}の色" data-color="${id}" type="color" value="${v.x!=null&&v.y!=null?xyToHex(v.x,v.y):'#ffffff'}" ${inactive?'disabled':''}></label>`:''}</div><p class="hue-command-message" role="status">${escape(messages.get(id)??'')}</p><div class="trend-label"><span>24時間 · 点灯／消灯／不明</span><button data-history="${id}">履歴を見る</button></div>${band(histories.get(id))}${o.dimming?spark(histories.get(id)):''}</section>`;
    }).join('')}</article>`).join(''):'<div class="empty">照明を選択すると、状態の表示と1分ごとの記録を開始します。</div>';
    grid.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach(b=>b.onclick=()=>{const o=current!.devices.flatMap(d=>d.outputs).find(o=>o.id===b.dataset.toggle)!;void command(o.id,{on:!o.values.on});});
    grid.querySelectorAll<HTMLInputElement>('[data-brightness]').forEach(i=>{i.oninput=()=>{i.previousElementSibling!.textContent=`${i.value}%`;};i.onchange=()=>void command(i.dataset.brightness!,{brightness:Number(i.value)});});
    grid.querySelectorAll<HTMLInputElement>('[data-temperature]').forEach(i=>{i.oninput=()=>{i.previousElementSibling!.textContent=`${i.value} K`;};i.onchange=()=>{const o=current!.devices.flatMap(d=>d.outputs).find(o=>o.id===i.dataset.temperature)!;const [min,max]=o.temperature!;void command(o.id,{mirek:Math.min(max,Math.max(min,Math.round(1_000_000/Number(i.value))))});};});
    grid.querySelectorAll<HTMLInputElement>('[data-color]').forEach(i=>i.onchange=()=>void command(i.dataset.color!,{xy:hexToXY(i.value)}));
    grid.querySelectorAll<HTMLButtonElement>('[data-history]').forEach(b=>b.onclick=()=>openDetail(b.dataset.history!));
  }
  async function command(id:string,body:unknown) {
    if(busy.has(id))return;busy.add(id);messages.set(id,'操作結果を確認しています…');
    const el=grid.querySelector(`[data-output="${id}"]`)!;el.querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button').forEach(e=>e.disabled=true);el.querySelector('.hue-command-message')!.textContent=messages.get(id)!;
    try{current=await api<HueStatus>('/api/hue/control',{light_id:id,...body as object});messages.set(id,'状態を再取得しました。');}
    catch(e){messages.set(id,e instanceof Error?e.message:'操作できませんでした');try{current=(await api<{hue:HueStatus}>('/api/status')).hue;}catch{}}
    finally{busy.delete(id);render(true);}
  }
  async function updateHistories() {
    if(!current||loading)return;loading=true;lastHistory=Date.now();
    // Serial requests avoid a large simultaneous cloud-history fanout on the router.
    try{for(const o of current.devices.filter(d=>d.selected).flatMap(d=>d.outputs).filter(o=>o.connectivity!=='removed')){try{histories.set(o.id,await fetchHistory(o.id));}catch{}}}finally{loading=false;render();}
  }
  async function showManagement(archive=false) {
    manage.querySelector('h2')!.textContent=archive?'過去の照明履歴':'照明を選択';manage.showModal();
    const list=manage.querySelector<HTMLElement>('[data-list]')!,msg=manage.querySelector('[data-message]')!;list.replaceChildren();msg.textContent='一覧を取得しています…';
    try {
      const data=await api('/api/hue/devices') as {devices:Device[];archive:Device[]};
      const devices=archive?data.archive:data.devices;
      list.innerHTML=devices.map(d=>`<div class="hue-registration-row"><div><strong>${escape(d.name)}</strong><small>${d.outputs.length} 出力 ${d.present?'':'· Bridge上にありません'}</small></div>${archive?d.outputs.map(o=>`<button data-archived="${o.id}">${escape(o.name)}の履歴</button>`).join(''):`<label><input type="checkbox" data-select="${d.id}" ${current?.devices.some(r=>r.id===d.id&&r.selected)?'checked':''}>表示・記録</label>`}</div>`).join('');
      msg.textContent=devices.length?'':'該当する照明はありません。';
      list.querySelectorAll<HTMLInputElement>('[data-select]').forEach(i=>i.onchange=async()=>{i.disabled=true;try{await api('/api/hue/devices',{device_id:i.dataset.select,selected:i.checked});current=(await api<{hue:HueStatus}>('/api/status')).hue;msg.textContent='登録を更新しました。';render(true);lastHistory=0;}catch(e){i.checked=!i.checked;msg.textContent=String(e);}finally{i.disabled=false;}});
      list.querySelectorAll<HTMLButtonElement>('[data-archived]').forEach(b=>b.onclick=()=>{manage.close();openDetail(b.dataset.archived!);});
    }catch(e){msg.textContent=String(e);}
  }
  function openDetail(id:string){active=id;days=1;detail.showModal();void drawDetail();}
  async function drawDetail() {
    if(!active)return;const sequence=++seq;const id=active;
    const owner=current?.devices.find(d=>d.outputs.some(o=>o.id===id));detail.querySelector('[data-name]')!.textContent=owner?.name??'照明の履歴';
    detail.querySelectorAll<HTMLButtonElement>('[data-hue-days]').forEach(b=>b.classList.toggle('active',Number(b.dataset.hueDays)===days));
    const msg=detail.querySelector('[data-message]')!;msg.textContent='履歴を読み込んでいます…';
    try {
      const hist=await fetchHistory(id,days);if(sequence!==seq||!detail.open)return;
      plots.forEach(p=>p.destroy());plots=[];const root=detail.querySelector<HTMLElement>('[data-charts]')!;root.replaceChildren();const hour=hist.bucket_seconds===3600;
      const output=owner?.outputs.find(o=>o.id===id);
      const fields=[['on',hour?'点灯割合 / %':'点灯状態 / %','#e4b886'],...(output?.dimming?[['brightness','点灯中の明るさ / %','#acd0a1']]:[]),...(output?.temperature?[['temperature','色温度 / K','#86b9cd']]:[])];
      const xs:number[]=[],aligned:(Row|null)[]=[];let previous:number|undefined;
      for(const r of hist.samples){if(previous!=null&&r.minute-previous>hist.bucket_seconds*1.5){xs.push(previous+hist.bucket_seconds);aligned.push(null);}xs.push(r.minute);aligned.push(r);previous=r.minute;}
      const showColor=(index:number)=>{const r=aligned[index];const el=detail.querySelector<HTMLElement>('[data-color]')!;if(!r){el.textContent='選択時刻は欠測です。';return;}const valid=confirmed(r,hour);el.innerHTML=`<span>${escape(timestamp(r.minute))} · ${valid?'取得済み':'状態不明'}${hour?` · 取得 ${r.available_count??0} / 不明 ${r.unavailable_count??0}`:''}</span>${valid&&r.x!=null&&r.y!=null?`<span class="hue-swatch" style="background:${xyToHex(r.x,r.y)}"></span><span>xy ${display(r.x,4)}, ${display(r.y,4)}${r.on===false?'（消灯中の設定値）':''}</span>`:''}${valid&&r.mirek?`<span>${display(kelvin(r.mirek))} K</span>`:''}`;};
      for(const [metric,label,color] of fields){
        const block=document.createElement('section');block.className='detail-chart';const h=document.createElement('h3');h.textContent=label;block.appendChild(h);const el=document.createElement('div');block.appendChild(el);root.appendChild(block);
        plots.push(new uPlot({width:Math.max(250,root.clientWidth),height:200,tzDate:ts=>uPlot.tzDate(new Date(ts*1000),'Asia/Tokyo'),cursor:{sync:{key:'hue-detail'},drag:{x:true,y:false}},series:[{label:'日時',value:'{YYYY}/{M}/{D} {HH}:{mm}'},{label,stroke:color,width:2,spanGaps:false,points:{show:xs.length<10},paths:metric==='on'?uPlot.paths.stepped!({align:1}):undefined,value:(_u,n)=>n==null?'—':metric==='on'&&!hour?n?'点灯':'消灯':display(n,1)}],axes:[timeAxis(),metric==='on'&&!hour?{...valueAxis(''),values:(_u,ticks)=>ticks.map(n=>n===0?'消灯':n===100?'点灯':'')}:valueAxis(metric==='temperature'?'K':'%')],scales:{x:{time:true,auto:false},y:{range:metric==='temperature'?(_u,min,max)=>metricRange('kelvin',min,max):()=>[0,100]}},hooks:{ready:[u=>u.setScale('x',{min:hist.from,max:hist.to})],setCursor:[u=>{if(u.cursor.idx!=null)showColor(u.cursor.idx);}] }},[xs,aligned.map(r=>r?point(r,metric,hour):null)],el));
      }
      if(aligned.length)showColor(aligned.length-1);else detail.querySelector('[data-color]')!.textContent='';
      msg.textContent=[hour?'1時間集計。点灯割合は観測値の割合です。色・色温度は時間内の最後の有効値です。':'1分ごとの状態記録。消灯中の設定値は時刻選択で確認できます。','欠測は線をつなぎません。',hist.source==='memory'?'本体メモリの履歴を表示しています。':'',hist.cloud_error?'クラウドに接続できないため取得済みの履歴を表示しています。':''].join(' ');
    }catch(e){if(sequence===seq)msg.textContent=String(e);}
  }
  detail.querySelectorAll<HTMLButtonElement>('[data-hue-days]').forEach(b=>b.onclick=()=>{days=Number(b.dataset.hueDays);void drawDetail();});
  detail.addEventListener('close',()=>{seq++;plots.forEach(p=>p.destroy());plots=[];});
  window.addEventListener('resize',()=>{if(detail.open)plots.forEach(p=>p.setSize({width:Math.max(250,detail.querySelector<HTMLElement>('[data-charts]')!.clientWidth),height:200}));});
  section.querySelector<HTMLButtonElement>('[data-manage]')!.onclick=()=>void showManagement();section.querySelector<HTMLButtonElement>('[data-archive]')!.onclick=()=>void showManagement(true);
  return {update(state:HueStatus|undefined){if(!state)return;const changed=current?.devices.filter(d=>d.selected).map(d=>d.id).join()!==state.devices.filter(d=>d.selected).map(d=>d.id).join();current=state;render();if(changed||Date.now()-lastHistory>=60000)void updateHistories();},disconnected(){section.querySelector('.hue-message')!.textContent='NanoPiに接続できません。表示は最終確認時の値です。';grid.querySelectorAll<HTMLInputElement|HTMLButtonElement>('.hue-controls input,.hue-controls button').forEach(e=>e.disabled=true);}};
}
