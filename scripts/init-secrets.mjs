import { mkdirSync, existsSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
mkdirSync('.auth', { recursive: true, mode: 0o700 });
if (!existsSync('.auth/secrets.json')) writeFileSync('.auth/secrets.json', JSON.stringify({ INGEST_TOKEN: randomBytes(32).toString('hex'), READ_TOKEN: randomBytes(32).toString('hex') }), { mode: 0o600 });
const secrets = JSON.parse(readFileSync('.auth/secrets.json','utf8'));
writeFileSync('.dev.vars', Object.entries(secrets).map(([k,v]) => `${k}=${v}`).join('\n')+'\n', { mode: 0o600 });
chmodSync('.dev.vars',0o600);
console.log('専用トークンを非公開ファイルに用意しました（値は表示しません）。');
