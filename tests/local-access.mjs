import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApp} from '../src/gateway.js';
import {config} from '../src/config.js';

test('local page receives key; external and rebinding requests are denied', async()=>{
 const server=createApp().listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 const headers={'Content-Type':'application/json','Origin':base,'Sec-Fetch-Site':'same-origin'};
 try {
  const good=await fetch(base+'/api/local-access',{method:'POST',headers,body:'{}'});
  assert.equal(good.status,200);assert.equal((await good.json()).api_key,config.localApiKey);assert.equal(good.headers.get('cache-control'),'no-store');
  for(const h of [{...headers,Origin:'https://external.example','Sec-Fetch-Site':'cross-site'}, {'Content-Type':'application/json'}, {...headers,Host:'attacker.example',Origin:'http://attacker.example'}, {...headers,'Content-Type':'text/plain'}]) {
   const bad=await fetch(base+'/api/local-access',{method:'POST',headers:h,body:'{}'});assert.equal(bad.status,403);assert.ok(!(await bad.text()).includes(config.localApiKey));
  }
  assert.notEqual((await fetch(base+'/api/local-access')).status,200);
  assert.equal((await fetch(base+'/v1/videos/tasks')).status,401);
 }finally{server.close();server.closeAllConnections();}
});
