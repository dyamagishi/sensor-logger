import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,stat,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import https from 'node:https';
import { bridgeURL,writeConfiguration,bridgeRequest } from '../scripts/hue-setup.mjs';
import { dnsQuery,dnsRecords,subnetHosts,localNetworks,ssdpCandidate,neighborHosts,discoverBridges,probeBridge } from '../scripts/hue-discovery.mjs';

test('connection configuration rejects URLs with credentials or paths',()=>{
  assert.equal(bridgeURL('192.168.1.2'),'https://192.168.1.2');assert.equal(bridgeURL('[::1]'),'https://[::1]');
  for(const url of ['http://192.168.1.2','https://user:secret@bridge','https://bridge/api','https://bridge/?key=secret'])assert.throws(()=>bridgeURL(url));
});
test('mDNS compressed names are parsed and malformed pointers rejected',()=>{
  const query=dnsQuery('_hue._tcp.local',12);assert.equal(query.readUInt16BE(4),1);
  const packet=Buffer.concat([query,Buffer.from([0xc0,0x0c,0,12,0,1,0,0,0,120,0,9,6]),Buffer.from('bridge'),Buffer.from([0xc0,0x0c])]);packet.writeUInt16BE(1,6);
  assert.deepEqual(dnsRecords(packet),[{name:'_hue._tcp.local',type:12,value:'bridge._hue._tcp.local'}]);
  for(let n=0;n<packet.length;n++){try{dnsRecords(packet.subarray(0,n));}catch{}}
  const loop=Buffer.alloc(14);loop.writeUInt16BE(1,4);loop[12]=0xc0;loop[13]=12;assert.throws(()=>dnsRecords(loop));
});
test('scan uses the actual LAN subnet, skips VPNs and reports large omitted ranges',()=>{
  const interfaces={en0:[{address:'192.168.53.144',cidr:'192.168.53.144/24',family:'IPv4',internal:false}],utun4:[{address:'100.70.1.2',cidr:'100.70.1.2/32',family:'IPv4',internal:false}],en1:[{address:'10.0.0.2',cidr:'10.0.0.2/16',family:'IPv4',internal:false}]};
  const p=localNetworks(interfaces);assert.ok(p.hosts.includes('192.168.53.194'));assert.equal(p.hosts.length,253);assert.ok(!p.hosts.includes('192.168.53.144'));assert.ok(!p.addresses.includes('100.70.1.2'));assert.equal(p.skipped.length,1);
  assert.deepEqual(subnetHosts('192.168.53.194/30').hosts,['192.168.53.193','192.168.53.194']);assert.deepEqual(subnetHosts('192.168.53.194/32').hosts,['192.168.53.194']);assert.throws(()=>subnetHosts('192.168.300.1/24'));
  const explicit=localNetworks(interfaces,['192.168.43.0/24']);assert.ok(explicit.hosts.includes('192.168.43.146'));assert.equal(explicit.hosts.length,254);assert.equal(explicit.skipped.length,0);
  assert.deepEqual(neighborHosts('? (192.168.53.194) at ec:b5:fa:af:a8:38 on en0\n? (192.168.53.195) at (incomplete) on en0\n192.168.53.196 dev eth1 FAILED'),['192.168.53.194']);
});
test('SSDP advertisements are candidates only and arbitrary LOCATION hosts are ignored',()=>{
  const packet='HTTP/1.1 200 OK\r\nhue-bridgeid: ECB5FAFFFEAFA838\r\nLOCATION: http://external.example/description.xml\r\n\r\n';
  assert.equal(ssdpCandidate(packet,'192.168.53.194').host,'192.168.53.194');assert.equal(ssdpCandidate('HTTP/1.1 200 OK\r\nSERVER: unrelated\r\n','192.168.53.1'),null);
});
test('no multicast replies still finds a responding Bridge through complete subnet probing',async()=>{
  const interfaces={en0:[{address:'192.168.53.144',cidr:'192.168.53.144/24',family:'IPv4',internal:false}]};const seen=new Set(),events=[];
  const result=await discoverBridges({onProgress:e=>events.push(e)},{interfaces,mdns:async()=>[],ssdp:async()=>[],neighbors:async()=>[],probe:async host=>{seen.add(host);return host==='192.168.53.194'?{host,bridgeId:'ECB5FAFFFEAFA838',name:'Hue Bridge',model:'BSB002',protocol:'https'}:null;}});
  assert.equal(seen.size,253);assert.equal(result.length,1);assert.equal(result[0].host,'192.168.53.194');assert.ok(result[0].sources.includes('subnet'));assert.ok(events.some(e=>e.type==='scan'&&e.completed===253));assert.equal(events.at(-1).type,'complete');
});
test('no verified result retries all addresses with a larger budget, and duplicate methods merge',async()=>{
  const interfaces={en0:[{address:'192.168.53.193',cidr:'192.168.53.193/30',family:'IPv4',internal:false}]};const budgets=[],events=[];
  const result=await discoverBridges({onProgress:e=>events.push(e)},{interfaces,mdns:async()=>[{host:'192.168.53.194'}],ssdp:async()=>[{host:'192.168.53.194'}],neighbors:async()=>['192.168.53.194'],probe:async(host,budget)=>{budgets.push(budget);return budget.connectTimeout===3000?{host,bridgeId:'ECB5FAFFFEAFA838',name:'Hue Bridge',model:'BSB002',protocol:'https'}:null;}});
  assert.equal(result.length,1);assert.equal(budgets.length,2);assert.equal(budgets[1].requestTimeout,6000);assert.deepEqual(new Set(result[0].sources),new Set(['mDNS','SSDP','ARP','subnet','retry']));assert.ok(events.some(e=>e.type==='retry'));
});
test('wizard generates private standalone config, does not overwrite, and pins before credentials are sent',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hue-wizard-test-'));let server;
  try{
    for(const name of ['bridge','other'])execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,`${name}.key`),'-out',join(dir,`${name}.pem`),'-days','1','-subj','/CN=test-hue'],{stdio:'ignore'});
    const certificate=new X509Certificate(await readFile(join(dir,'bridge.pem'))),other=new X509Certificate(await readFile(join(dir,'other.pem')));
    const output=join(dir,'generated');const args={url:'https://192.168.1.2',bridgeId:'001788FFFE123456',key:'test-secret',certificate};
    await writeConfiguration(output,args);
    assert.equal((await stat(join(output,'hue.env'))).mode&0o777,0o600);assert.equal((await stat(output)).mode&0o777,0o700);
    const toml=await readFile(join(output,'hue.toml'),'utf8');assert.ok(toml.includes('bridge_id = "001788fffe123456"'));assert.ok(!toml.includes('test-secret'));
    assert.ok((await readFile(join(output,'hue.env'),'utf8')).includes("HUE_APPLICATION_KEY='test-secret'"));assert.deepEqual(await readFile(join(output,'hue-certificate.der')),certificate.raw);
    await assert.rejects(()=>writeConfiguration(output,{...args,key:'changed-secret'}));assert.ok((await readFile(join(output,'hue.env'),'utf8')).includes('test-secret'));
    let requests=0;server=https.createServer({key:await readFile(join(dir,'bridge.key')),cert:await readFile(join(dir,'bridge.pem'))},(req,res)=>{requests++;res.setHeader('Content-Type','application/json');if(req.url==='/api/config'){assert.equal(req.headers['hue-application-key'],undefined);setTimeout(()=>res.end('{"name":"Hue Bridge","modelid":"BSB002","bridgeid":"001788FFFE123456"}'),1100);return;}assert.equal(req.headers['hue-application-key'],'test-secret');res.end('{"data":[],"errors":[]}');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`https://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await bridgeRequest(url,'/clip/v2/resource/light',certificate,{key:'test-secret'}),{data:[],errors:[]});
    await assert.rejects(()=>bridgeRequest(url,'/clip/v2/resource/light',other,{key:'test-secret'}));assert.equal(requests,1,'mismatched certificate must receive no HTTP request');
    const discovered=await probeBridge('127.0.0.1',{httpsPort:server.address().port,connectTimeout:200,requestTimeout:2000});assert.equal(discovered.bridgeId,'001788FFFE123456');assert.equal(discovered.protocol,'https','slow public API replies must be allowed after a successful TLS connection');
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
