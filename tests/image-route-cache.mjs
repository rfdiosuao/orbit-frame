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
  // The landing page and its JS must bypass stale caches. Derive the cache-busting
  // token from the served HTML instead of pinning it: the token changes by design on
  // every UI change, so a hard-coded value turns every legitimate bump into a red test.
  const page=await fetch(base+'/');
  assert.equal(page.status,200);
  assert.equal(page.headers.get('cache-control'),'no-store');
  const html=await page.text();
  const versioned=html.match(/<script[^>]+src="(\/app\.js\?v=([^"]+))"/);
  assert.ok(versioned,'index.html must reference a versioned /app.js');
  const assetUrl=versioned[1],token=versioned[2];
  assert.match(token,/^\d{8}-[a-z0-9-]+$/i,`cache-busting token must be dated, got: ${token}`);
  const asset=await fetch(base+assetUrl);
  assert.equal(asset.status,200);
  assert.equal(asset.headers.get('cache-control'),'no-store');
 }finally{server.close();server.closeAllConnections();}
});
