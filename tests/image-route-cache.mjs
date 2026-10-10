import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApp} from '../src/gateway.js';
import {config} from '../src/config.js';
test('old GPT image client is rejected before any Doubao generation and UI assets bypass stale caches',async()=>{
 const server=createApp().listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const r=await fetch(base+'/v1/images/generations',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.localApiKey}`},body:JSON.stringify({model:'gpt-image-2.5',prompt:'dog'})});
  assert.equal(r.status,400);const d=await r.json();assert.equal(d.error.type,'image_client_outdated');assert.equal(d.error.submitted,false);
  for(const route of ['/','/app.js?v=20261010-image-auth-2']){const r=await fetch(base+route);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');}
  const html=await(await fetch(base+'/')).text();assert.ok(html.includes('/app.js?v=20261010-image-auth-2'));
 }finally{server.close();server.closeAllConnections();}
});
