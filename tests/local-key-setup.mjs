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
