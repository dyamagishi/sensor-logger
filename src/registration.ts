type Device = { address:string; name:string; kind:string; registered:boolean; registered_name?:string; temperature:number|null; humidity:number|null; co2:number|null; battery:number|null; rssi:number|null; observed_at:number };
type Discovery = { devices:Device[]; scanning:boolean; until:number; collector_state:string };

export function setupRegistration(onAdded:()=>Promise<void>) {
  const button=document.createElement('button');button.id='add-sensor';button.className='add-sensor';button.textContent='＋ センサーを追加';
  document.querySelector('.graph-options')!.appendChild(button);
  const dialog=document.createElement('dialog');dialog.id='registration';dialog.setAttribute('aria-labelledby','registration-title');
  dialog.innerHTML=`<div class="detail-head"><div><p class="eyebrow">DEVICES / センサー</p><h2 id="registration-title">センサーを追加</h2></div><button type="button" id="registration-close" aria-label="追加画面を閉じる">✕</button></div>
  <p class="registration-intro">追加したいSwitchBotに電池を入れて、NanoPiの近くに置いてください。温湿度・CO₂を受信できる機器が表示されます。</p>
  <div class="discovery-toolbar"><span id="discovery-state" role="status"></span><button type="button" id="discovery-restart">もう一度探す</button></div>
  <div id="discovery-list" aria-label="見つかったセンサー"></div>
  <form id="registration-form" hidden><div class="selected-device"><span>追加する機器</span><strong id="selected-name"></strong><small id="selected-address"></small></div><label for="sensor-name">表示名・置き場所</label><input id="sensor-name" name="name" required maxlength="40" placeholder="例：リビング、玄関、ベランダ" autocomplete="off"><p class="field-hint">あとで見分けやすい名前を付けてください。</p><button type="submit" id="registration-submit">この名前で登録</button></form>
  <p id="registration-message" role="status" aria-live="polite"></p>`;
  document.body.appendChild(dialog);
  const list=dialog.querySelector<HTMLDivElement>('#discovery-list')!;
  const state=dialog.querySelector<HTMLSpanElement>('#discovery-state')!;
  const form=dialog.querySelector<HTMLFormElement>('form')!;
  const input=dialog.querySelector<HTMLInputElement>('input')!;
  const submit=dialog.querySelector<HTMLButtonElement>('#registration-submit')!;
  const message=dialog.querySelector<HTMLParagraphElement>('#registration-message')!;
  const restart=dialog.querySelector<HTMLButtonElement>('#discovery-restart')!;
  let selected:Device|undefined, devices:Device[]=[], timer:ReturnType<typeof setTimeout>|undefined, sequence=0, saving=false;
  async function api<T=unknown>(path:string,body?:object) {
    const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Home-Sensors':'1'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
    const data=await response.json() as T & {error?:string};
    if(!response.ok)throw Error(data.error??'操作できませんでした。もう一度お試しください。');
    return data;
  }
  function renderDevices() {
    const existing=new Map(Array.from(list.querySelectorAll<HTMLButtonElement>('[data-address]')).map(el=>[el.dataset.address!,el]));
    if(!devices.length){if(!list.querySelector('.discovery-empty'))list.innerHTML='<div class="discovery-empty">まだ見つかっていません。<br>電池を入れてから、しばらくお待ちください。</div>';return;}
    list.querySelector('.discovery-empty')?.remove();
    for(const d of devices){
      let el=existing.get(d.address);
      if(!el){el=document.createElement('button');el.type='button';el.className='discovered-device';el.dataset.address=d.address;el.innerHTML='<span><strong></strong><small></small><span class="discovered-values"></span></span><span class="device-action"></span>';list.appendChild(el);}
      existing.delete(d.address);el.disabled=d.registered;el.classList.toggle('selected',selected?.address===d.address);
      el.querySelector('strong')!.textContent=d.registered_name??d.name;
      el.querySelector('small')!.textContent=d.address+(d.rssi!=null?` · 電波 ${d.rssi} dBm`:'');
      el.querySelector('.discovered-values')!.textContent=[d.temperature!=null?`${d.temperature.toFixed(1)} ℃`:'',d.humidity!=null?`${d.humidity}%`:'',d.co2!=null?`${d.co2} ppm`:'',d.battery!=null?`電池 ${d.battery}%`:''].filter(Boolean).join('　');
      el.querySelector('.device-action')!.textContent=d.registered?'登録済み':selected?.address===d.address?'選択中':'選ぶ →';
    }
    existing.forEach(el=>el.remove());
  }
  async function discover(start=false) {
    const seq=++sequence;clearTimeout(timer);restart.disabled=true;
    if(start)state.textContent='周囲のセンサーを探しています…';
    try {
      const data:Discovery=await api<Discovery>('/api/discovery',start?{}:undefined);
      if(!dialog.open||seq!==sequence)return;
      devices=data.devices;renderDevices();
      state.textContent=data.collector_state!=='scanning'?'Bluetoothに接続中です…':data.scanning?`探索中 · ${devices.filter(d=>!d.registered).length}台の未登録センサー`:'探索が終了しました';
      if(data.scanning)timer=setTimeout(()=>void discover(),3000);
    } catch(error) {if(dialog.open&&seq===sequence)state.textContent=error instanceof Error?error.message:'探索できませんでした。';}
    finally {if(seq===sequence)restart.disabled=false;}
  }
  button.onclick=()=>{selected=undefined;devices=[];form.hidden=true;message.textContent='';dialog.showModal();renderDevices();void discover(true);};
  restart.onclick=()=>void discover(true);
  dialog.querySelector('#registration-close')!.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{sequence++;clearTimeout(timer);void api('/api/discovery',{active:false}).catch(()=>{});});
  list.onclick=event=>{
    if(saving)return;
    const target=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-address]');
    const device=devices.find(d=>d.address===target?.dataset.address);
    if(!device||device.registered)return;
    selected=device;form.hidden=false;input.value=device.name;message.textContent='';
    dialog.querySelector('#selected-name')!.textContent=device.name;
    dialog.querySelector('#selected-address')!.textContent=device.address;
    renderDevices();input.focus();input.select();
  };
  form.onsubmit=async event=>{
    event.preventDefault();if(!selected||saving)return;
    const device=selected; saving=true;sequence++;clearTimeout(timer);submit.disabled=true;input.disabled=true;message.className='';message.textContent='登録しています…';
    try {
      const data=await api<{sensor:{name:string};cloud_pending:boolean}>('/api/sensors',{address:device.address,name:input.value});
      form.hidden=true;selected=undefined;
      message.textContent=`「${data.sensor.name}」を登録しました。収集を開始しています。${data.cloud_pending?'クラウドへの反映は次の毎時保存で行います。':''}`;
      devices=devices.map(d=>d.address===device.address?{...d,registered:true,registered_name:data.sensor.name}:d);renderDevices();
      await onAdded();
    } catch(error){message.className='warning';message.textContent=error instanceof Error?error.message:'登録できませんでした。';}
    finally {saving=false;submit.disabled=false;input.disabled=false;if(dialog.open)void discover();}
  };
}
