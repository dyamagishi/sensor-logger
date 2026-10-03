import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute=promisify(execFile);
const safeText=s=>String(s).replace(/[\x00-\x1f\x7f-\x9f]/g,'');
const ipv4Number=address=>{
  const parts=address.split('.');
  if(parts.length!==4||parts.some(p=>!/^\d{1,3}$/.test(p)||Number(p)>255))throw Error('invalid IPv4 address');
  return parts.reduce((n,p)=>n*256+Number(p),0);
};
const ipv4Address=n=>[24,16,8,0].map(shift=>(n>>>shift)&255).join('.');
export function subnetHosts(cidr) {
  const [address,prefixText,...extra]=cidr.split('/'),prefix=Number(prefixText);
  if(extra.length||!/^\d+$/.test(prefixText??'')||!Number.isInteger(prefix)||prefix<20||prefix>32)throw Error('探索範囲はIPv4の/20〜/32で指定してください。広いネットワークは/24などに分けて指定できます。');
  const ip=ipv4Number(address),size=2**(32-prefix),base=Math.floor(ip/size)*size;
  const hosts=[];
  for(let n=base+(prefix<=30?1:0);n<base+size-(prefix<=30?1:0);n++)hosts.push(ipv4Address(n));
  return {cidr:`${ipv4Address(base)}/${prefix}`,hosts};
}
export function localNetworks(interfaces=networkInterfaces(),subnets=[]) {
  const addresses=[],networks=new Map(),skipped=[];
  for(const [name,rows] of Object.entries(interfaces)){
    // Tunnel, loopback and container interfaces are not the household LAN.
    if(/^(utun|tun|tap|tailscale|wg|lo|docker|veth)/i.test(name))continue;
    for(const row of rows??[]){
      if(row.internal||row.family!=='IPv4')continue;
      addresses.push(row.address);
      try{
        let cidr=row.cidr;
        if(!cidr){const mask=ipv4Number(row.netmask).toString(2).padStart(32,'0');if(!/^1*0*$/.test(mask))throw Error('invalid netmask');cidr=`${row.address}/${mask.indexOf('0')===-1?32:mask.indexOf('0')}`;}
        const network=subnetHosts(cidr);networks.set(network.cidr,network);
      }catch(error){skipped.push({interface:name,cidr:row.cidr??`${row.address}/${row.netmask}`,reason:error.message});}
    }
  }
  // Explicit subnets also work for routed LANs and override automatic scan ranges.
  const scan=subnets.length?subnets.map(subnetHosts):[...networks.values()];
  const own=new Set(addresses);
  return {addresses,networks:scan,hosts:[...new Set(scan.flatMap(n=>n.hosts))].filter(ip=>!own.has(ip)),skipped:subnets.length?[]:skipped};
}

function nameBytes(name) {
  return Buffer.concat([...name.replace(/\.$/,'').split('.').map(s=>{const b=Buffer.from(s);return Buffer.concat([Buffer.from([b.length]),b]);}),Buffer.from([0])]);
}
export function dnsQuery(name,type) {
  const header=Buffer.alloc(12);header.writeUInt16BE(1,4);
  const tail=Buffer.alloc(4);tail.writeUInt16BE(type);tail.writeUInt16BE(0x8001,2);
  return Buffer.concat([header,nameBytes(name),tail]);
}
export function dnsRecords(packet) {
  const readName=(start)=>{
    let pos=start,end,labels=[];const visited=new Set();
    for(let n=0;n<128;n++){
      if(pos>=packet.length||visited.has(pos))throw Error('invalid DNS name');visited.add(pos);
      const size=packet[pos++];if(!size)return {name:labels.join('.').toLowerCase(),end:end??pos};
      if((size&0xc0)===0xc0){if(pos>=packet.length)throw Error();const pointer=((size&0x3f)<<8)|packet[pos++];end??=pos;pos=pointer;continue;}
      if(size>63||pos+size>packet.length)throw Error();labels.push(packet.toString('utf8',pos,pos+size));pos+=size;
    }
    throw Error('DNS name too long');
  };
  if(packet.length<12)throw Error('short DNS packet');let pos=12;
  for(let i=0;i<packet.readUInt16BE(4);i++){pos=readName(pos).end+4;if(pos>packet.length)throw Error();}
  const count=packet.readUInt16BE(6)+packet.readUInt16BE(8)+packet.readUInt16BE(10),records=[];
  for(let i=0;i<count;i++){
    const {name,end}=readName(pos);pos=end;if(pos+10>packet.length)throw Error();
    const type=packet.readUInt16BE(pos),ttl=packet.readUInt32BE(pos+4),length=packet.readUInt16BE(pos+8);pos+=10;const finish=pos+length;if(finish>packet.length)throw Error();
    let value;
    if(type===12)value=readName(pos).name;
    if(type===33&&length>=7)value={port:packet.readUInt16BE(pos+4),host:readName(pos+6).name};
    if(type===1&&length===4)value=[...packet.subarray(pos,finish)].join('.');
    if(type===16){value={};let cursor=pos;while(cursor<finish){const n=packet[cursor++];if(cursor+n>finish)throw Error();const text=packet.toString('utf8',cursor,cursor+n);const eq=text.indexOf('=');if(eq>0)value[text.slice(0,eq).toLowerCase()]=text.slice(eq+1);cursor+=n;}}
    if(value!==undefined&&ttl>0)records.push({name,type,value});pos=finish;
  }
  return records;
}
/** Legacy unicast mDNS queries; bind to a LAN interface, not a VPN socket. */
export async function discoverMDNS({addresses,duration=10000,onWarning=()=>{}}) {
  const lists=await Promise.all(addresses.map(async address=>{
  const socket=dgram.createSocket('udp4');const records=new Map();
  let failed=false;socket.on('error',error=>{failed=true;onWarning(`mDNS ${address}: ${safeText(error.message)}`);});
  try{await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(0,address,resolve);});socket.setMulticastInterface(address);}catch{try{socket.close();}catch{}return [];}
  socket.on('message',packet=>{try{for(const r of dnsRecords(packet))records.set(`${r.type}/${r.name}/${JSON.stringify(r.value)}`,r);}catch{}});
  const query=(name,type)=>socket.send(dnsQuery(name,type),5353,'224.0.0.251',error=>{if(error)onWarning(`mDNS ${address}: ${safeText(error.message)}`);});
  try {
    const end=Date.now()+duration;
    while(Date.now()<end&&!failed){
      query('_hue._tcp.local',12);
      for(const r of records.values()){
        if(r.type===12&&r.name==='_hue._tcp.local'){query(r.value,33);query(r.value,16);}
        if(r.type===33)query(r.value.host,1);
      }
      await new Promise(resolve=>setTimeout(resolve,Math.min(650,Math.max(1,end-Date.now()))));
    }
  }finally{socket.close();}
  const all=[...records.values()],bridges=[];
  for(const ptr of all.filter(r=>r.type===12&&r.name==='_hue._tcp.local')){
    const srv=all.find(r=>r.type===33&&r.name===ptr.value);if(!srv)continue;
    const ip=all.find(r=>r.type===1&&r.name===srv.value.host)?.value;
    const txt=all.find(r=>r.type===16&&r.name===ptr.value)?.value??{};
    if(ip&&!bridges.some(b=>b.host===ip))bridges.push({host:ip,name:ptr.value.replace(/\._hue\._tcp\.local$/,''),bridgeId:txt.bridgeid??''});
  }
  return bridges;
  }));
  return lists.flat();
}

export function ssdpCandidate(packet,source) {
  if(!/^HTTP\/1\.1 200\b/i.test(packet))return null;
  const headers=Object.fromEntries(packet.split(/\r?\n/).slice(1).filter(l=>l.includes(':')).map(l=>{const i=l.indexOf(':');return [l.slice(0,i).trim().toLowerCase(),l.slice(i+1).trim()];}));
  if(!/^[a-f0-9]{16}$/i.test(headers['hue-bridgeid']??'')&&!/\b(hue|ipbridge)\b/i.test(headers.server??''))return null;
  try{ipv4Number(source);}catch{return null;}
  // Use the sender's LAN address, never fetch an arbitrary LOCATION URL.
  return {host:source,bridgeId:headers['hue-bridgeid']??'',name:'Hue Bridge'};
}
export async function discoverSSDP({addresses,duration=6500,onWarning=()=>{}}) {
  return (await Promise.all(addresses.map(async address=>{
    const socket=dgram.createSocket('udp4'),hosts=new Map();let failed=false;
    socket.on('error',error=>{failed=true;onWarning(`SSDP ${address}: ${safeText(error.message)}`);});
    try{await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(0,address,resolve);});socket.setMulticastInterface(address);}catch{try{socket.close();}catch{}return [];}
    socket.on('message',(packet,peer)=>{const candidate=ssdpCandidate(packet.toString('utf8'),peer.address);if(candidate)hosts.set(candidate.host,candidate);});
    try{
      const end=Date.now()+duration;
      while(Date.now()<end&&!failed){
        for(const target of ['ssdp:all','upnp:rootdevice'])socket.send(Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\n\r\n`),1900,'239.255.255.250',error=>{if(error)onWarning(`SSDP ${address}: ${safeText(error.message)}`);});
        await new Promise(resolve=>setTimeout(resolve,Math.min(2200,Math.max(1,end-Date.now()))));
      }
    }finally{socket.close();}
    return [...hosts.values()];
  }))).flat();
}
async function neighbors() {
  const [command,args]=process.platform==='darwin'?['arp',['-an']]:['ip',['-4','neigh','show']];
  const {stdout}=await execute(command,args,{timeout:2500,maxBuffer:262144});
  return neighborHosts(stdout);
}
export function neighborHosts(output) {
  return [...new Set(output.split(/\r?\n/).filter(line=>!/\b(incomplete|failed)\b/i.test(line)&&/\b(?:[a-f0-9]{1,2}:){5}[a-f0-9]{1,2}\b/i.test(line)).flatMap(line=>line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)??[]))];
}
export function hueIdentity(config,host,protocol) {
  if(!config||typeof config!=='object'||!/^BSB\d{3}$/.test(config.modelid??'')||!/^[a-f0-9]{16}$/i.test(config.bridgeid??''))return null;
  return {host,name:safeText(config.name??'Hue Bridge'),bridgeId:config.bridgeid.toUpperCase(),model:config.modelid,protocol};
}
/** Only public identification requests. Pairing and certificate trust happen later. */
export async function probeBridge(host,{connectTimeout=1500,requestTimeout=4000,httpsPort=443,httpPort=80}={}) {
  const readConfig=(protocol,port)=>new Promise(resolve=>{
    const transport=protocol==='https'?https:http;let done=false,connectTimer,responseTimer;
    const req=transport.get({hostname:host,port,path:'/api/config',agent:false,rejectUnauthorized:false},res=>{
      if(res.statusCode!==200){res.resume();finish(null);return;}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>65536){finish(null);return;}chunks.push(chunk);});
      res.on('error',()=>finish(null));res.on('end',()=>{try{finish(hueIdentity(JSON.parse(Buffer.concat(chunks).toString('utf8')),host,protocol));}catch{finish(null);}});
    });
    function finish(result){if(done)return;done=true;clearTimeout(connectTimer);clearTimeout(responseTimer);req.destroy();resolve(result);}
    connectTimer=setTimeout(()=>finish(null),connectTimeout);
    req.once('socket',socket=>socket.once(protocol==='https'?'secureConnect':'connect',()=>{clearTimeout(connectTimer);responseTimer=setTimeout(()=>finish(null),requestTimeout);}));
    req.on('error',()=>finish(null));
  });
  return await readConfig('https',httpsPort)??await readConfig('http',httpPort);
}
async function pool(items,action,concurrency=24) {
  let next=0;await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(next<items.length)await action(items[next++]);}));
}
/** Multicast + neighbors + complete connected-subnet scan; never rely on advertisements alone. */
export async function discoverBridges({subnets=[],onProgress=()=>{},multicastDuration=10000}={},dependencies={}) {
  const plan=localNetworks(dependencies.interfaces??networkInterfaces(),subnets);
  const mdns=dependencies.mdns??discoverMDNS,ssdp=dependencies.ssdp??discoverSSDP;
  const readNeighbors=dependencies.neighbors??neighbors,probe=dependencies.probe??probeBridge;
  const warn=message=>onProgress({type:'warning',message});
  for(const skipped of plan.skipped)warn(`${skipped.interface} ${skipped.cidr}: ${skipped.reason}`);
  onProgress({type:'start',networks:plan.networks.map(n=>n.cidr),total:plan.hosts.length});
  const jobs=new Map(),found=new Map(),sources=new Map(),advertised=new Set();
  async function verify(host,source,retry=false){
    try{ipv4Number(host);}catch{return;}
    if(!sources.has(host))sources.set(host,new Set());sources.get(host).add(source);
    if(!retry&&jobs.has(host))return jobs.get(host);
    const job=(async()=>{
      const candidate=await probe(host,retry?{connectTimeout:3000,requestTimeout:6000}:{});
      if(candidate){
        const previous=found.get(candidate.bridgeId);found.set(candidate.bridgeId,candidate);
        if(!previous)onProgress({type:'found',bridge:candidate});
      }
      return candidate;
    })();jobs.set(host,job);return job;
  }
  const multicast=Promise.all([['mDNS',mdns],['SSDP',ssdp]].map(async([source,discover])=>{
    let candidates=[];
    try{candidates=await discover({addresses:plan.addresses,duration:source==='mDNS'?multicastDuration:Math.min(multicastDuration,6500),onWarning:warn});}catch(error){warn(`${source}: ${safeText(error.message)}`);}
    onProgress({type:'multicast',source,candidates:candidates.length});
    await pool(candidates,async c=>{advertised.add(c.host);await verify(c.host,source);});
  }));
  try{
    const hosts=new Set(plan.hosts);const nearby=(await readNeighbors()).filter(host=>hosts.has(host));
    onProgress({type:'neighbors',total:nearby.length});await pool(nearby,host=>verify(host,'ARP'));
  }catch(error){warn(`ARP候補の取得: ${safeText(error.message)}`);}
  let completed=0;
  onProgress({type:'scan',completed,total:plan.hosts.length,round:1});
  await pool(plan.hosts,async host=>{await verify(host,'subnet');onProgress({type:'scan',completed:++completed,total:plan.hosts.length,round:1});});
  await multicast;
  // An advertised Bridge may have responded slowly. Also retry the whole range
  // when no verified Bridge was found, with larger connection/response budgets.
  const retry=found.size===0?[...new Set([...plan.hosts,...advertised])]:[...advertised].filter(host=>![...found.values()].some(c=>c.host===host));
  if(retry.length){
    onProgress({type:'retry',total:retry.length});completed=0;
    await pool(retry,async host=>{await verify(host,'retry',true);onProgress({type:'scan',completed:++completed,total:retry.length,round:2});});
  }
  const result=[...found.values()].map(c=>({...c,sources:[...sources.get(c.host)]})).sort((a,b)=>a.host.localeCompare(b.host,undefined,{numeric:true}));
  onProgress({type:'complete',total:jobs.size,found:result.length});return result;
}
