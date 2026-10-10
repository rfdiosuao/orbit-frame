import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ensureLocalApiKey} from '../src/local-api-key.js';
test('auto key persists, replaces example, and preserves custom keys',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'orbit-key-'));
 try {
  const key=ensureLocalApiKey(root,'');assert.match(key,/^[0-9a-f]{64}$/);assert.ok(readFileSync(path.join(root,'.env'),'utf8').includes(key));assert.equal(statSync(path.join(root,'.env')).mode&0o777,0o600);
  assert.equal(ensureLocalApiKey(root,''),key);
  writeFileSync(path.join(root,'.env'),'PORT=8787\nLOCAL_API_KEY=local-dev-key-change-me\n');
  const replaced=ensureLocalApiKey(root,'local-dev-key-change-me');assert.notEqual(replaced,key);assert.match(readFileSync(path.join(root,'.env'),'utf8'),/^PORT=8787\n/);
  assert.equal(ensureLocalApiKey(root,'custom-key'), 'custom-key');
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('blank or invalid key never consumes the next comment and always produces an HTTP-safe token',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'orbit-blank-key-'));
 try {
  for(const value of ['', ' ', '""', '本机密钥说明']) {
   writeFileSync(path.join(root,'.env'),`PORT=8787\nLOCAL_API_KEY=${value}\n# 本机上游地址\nUPSTREAM_URL=http://127.0.0.1:8000\n`);
   const key=ensureLocalApiKey(root,value==='""'?'':value);assert.match(key,/^[0-9a-f]{64}$/);
   const saved=readFileSync(path.join(root,'.env'),'utf8');
   assert.ok(saved.includes('# 本机上游地址\nUPSTREAM_URL=http://127.0.0.1:8000'));
   assert.equal(ensureLocalApiKey(root,''),key);
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});
