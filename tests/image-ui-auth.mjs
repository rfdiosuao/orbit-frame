import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('async function api('),source.indexOf('\nfunction showStage(',source.indexOf('async function api(')));
function setup(responses,{connecting=false}={}){
 const calls=[];let key='stale',reconnections=0;
 const context=vm.createContext({getKey:()=>key,localConnection:connecting?{}:null,AbortSignal,fetch:async(path,opts)=>{calls.push({path,body:opts.body,authorization:opts.headers.Authorization});return responses.shift()},applyKey:async()=>{reconnections++;key='fresh';return true}});
 vm.runInContext(fn,context);return {context,calls,reconnections:()=>reconnections};
}
const response=(status,error)=>({ok:status===200,status,json:async()=>error?{error}:{status:'running'}});
test('expired gateway key reconnects once and preserves image request body',async()=>{
 const s=setup([response(401,{type:'auth_error'}),response(200)]);const body=JSON.stringify({idempotency_key:'original'});
 await s.context.api('/v1/images/jobs',{method:'POST',body});
 assert.equal(s.reconnections(),1);assert.equal(s.calls.length,2);assert.equal(s.calls[0].body,s.calls[1].body);assert.equal(s.calls[1].authorization,'Bearer fresh');
});
test('Doubao login failure is shown as login failure and never replayed',async()=>{
 const s=setup([response(401,{type:'session_missing',message:'尚未登录豆包。'})]);
 await assert.rejects(s.context.api('/v1/images/generations',{method:'POST'}),/尚未登录豆包/);assert.equal(s.calls.length,1);assert.equal(s.reconnections(),0);
});
test('gateway auth cannot recurse during bootstrap or after one reconnect',async()=>{
 for(const connecting of [true,false]){const s=setup([response(401,{type:'auth_error'}),response(401,{type:'auth_error'})],{connecting});
 await assert.rejects(s.context.api('/v1/images/jobs'),/网关连接已失效/);assert.equal(s.reconnections(),connecting?0:1);assert.equal(s.calls.length,connecting?1:2);}
});
