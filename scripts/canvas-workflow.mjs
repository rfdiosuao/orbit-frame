// A small client-side manifest runner. Original task IDs remain the source of
// truth; the manifest is data, never executable code. No upstream retries.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {config} from '../src/config.js';
import {validateFrameData} from '../src/video-frames.js';
import {validateVideoDuration} from '../public/video-models.js';
import {isCloudVideo} from '../public/video-task-state.js';
import {uploadFrame} from './frame-workflow.mjs';
import {generateImageAndWait} from './image-workflow.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const invalid=message=>Object.assign(new Error(message),{diagnostic:{code:'invalid_workflow',message,submitted:false}});
const base=()=>`http://127.0.0.1:${config.port}`;
async function api(endpoint,body,timeout=180000) {
  const response=await fetch(base()+endpoint,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${config.localApiKey}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeout)});
  const result=await response.json();
  if(!response.ok) throw Object.assign(new Error(result.error?.message || `HTTP ${response.status}`),{diagnostic:{...(result.error || {}),http_status:response.status,submitted:result.error?.submitted ?? ([400,401,403,404,422].includes(response.status)?false:'unknown')}});
  return result;
}
async function manifestContext(filename) {
  if(typeof filename!=='string' || !filename || /^[a-z]+:\/\//i.test(filename)) throw invalid('Provide a local manifest JSON path');
  const file=await fs.realpath(path.resolve(filename));
  const stat=await fs.stat(file);if(!stat.isFile() || stat.size>1024*1024) throw invalid('Manifest must be a regular JSON file no larger than 1 MB');
  const manifest=JSON.parse(await fs.readFile(file,'utf8'));
  const images=manifest.images || [],shots=manifest.shots || [];
  if(!Array.isArray(images) || !Array.isArray(shots) || images.length>100 || shots.length>100 || !images.length && !shots.length) throw invalid('Manifest supports up to 100 images and 100 shots');
  const ids=new Set();
  for(const [list,key] of [[images,'image_id'],[shots,'shot_id']]) for(const node of list) {
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(node[key] || '') || ids.has(node[key])) throw invalid('Image and shot IDs must be unique, 1..80 letters, digits, underscores or hyphens');ids.add(node[key]);
    if(typeof node.prompt!=='string' || !node.prompt.trim() || node.prompt.length>(key==='image_id'?4000:20000)) throw invalid(`${node[key]} needs a valid prompt`);
  }
  const imageIds=new Set(images.map(i=>i.image_id));
  for(const image of images) {
    if(!Array.isArray(image.required_reference_ids || []) || (image.required_reference_ids || []).length>8 || (image.required_reference_ids || []).some(id=>!imageIds.has(id) || id===image.image_id)) throw invalid(`Invalid references for ${image.image_id}`);
    if(image.provider && !['doubao-desktop','openai-compatible'].includes(image.provider))throw invalid(`Invalid provider for ${image.image_id}`);
    if(image.model && (typeof image.model!=='string' || image.model.length>60))throw invalid(`Invalid model for ${image.image_id}`);
    if(!['16:9','9:16','1:1','4:3','3:4'].includes(image.ratio || manifest.ratio || '1:1'))throw invalid(`Invalid ratio for ${image.image_id}`);
  }
  const visiting=new Set(),done=new Set(),ordered=[];
  const visit=id=>{if(visiting.has(id))throw invalid('Image dependencies contain a cycle');if(done.has(id))return;visiting.add(id);const image=images.find(i=>i.image_id===id);for(const ref of image.required_reference_ids || [])visit(ref);visiting.delete(id);done.add(id);ordered.push(image);};images.forEach(i=>visit(i.image_id));
  for(const shot of shots) {
    const first=shot.first_frame_source,last=shot.last_frame_source;
    if(first && !imageIds.has(first) || last && (!first || !imageIds.has(last))) throw invalid(`Invalid frame roles for ${shot.shot_id}`);
    const mode=last?'first_last_frame':first?'image_to_video':'text_to_video';
    if(shot.mode && shot.mode!==mode) throw invalid(`${shot.shot_id}: mode cannot ignore frame sources`);
    if(!['16:9','9:16','1:1','4:3','3:4'].includes(shot.ratio || manifest.ratio || '16:9'))throw invalid(`Invalid ratio for ${shot.shot_id}`);
    try{validateVideoDuration(shot.model || 'Seedance 2.0 Fast',Number(shot.duration ?? 5));}catch(error){throw invalid(error.message);}
  }
  const definition=JSON.stringify({images:images.map(i=>[i.image_id,i.prompt,i.model,i.provider,i.ratio,i.required_reference_ids || []]),shots:shots.map(s=>[s.shot_id,s.prompt,s.model,s.duration,s.ratio || manifest.ratio,s.mode,s.first_frame_source,s.last_frame_source])});
  const stateFile=path.join(config.dataDir,'workflows',hash(file)+'.json');
  const state=await fs.readFile(stateFile,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(state && state.definition_hash!==hash(definition)) throw invalid('Prepared workflow inputs changed. Use a new manifest file for a new version; original tasks remain recoverable.');
  const cardCount=images.length+shots.reduce((n,s)=>n+2+Boolean(s.first_frame_source)+Boolean(s.last_frame_source),0);
  const edgeCount=images.reduce((n,i)=>n+(i.required_reference_ids || []).length,0)+shots.reduce((n,s)=>n+1+Boolean(s.first_frame_source)+Boolean(s.last_frame_source),0);
  if(cardCount>500 || edgeCount>1000)throw invalid('Workflow exceeds canvas limits (500 cards, 1000 connections)');
  return {file,manifest,images:ordered,shots,stateFile,definition_hash:hash(definition),state};
}
const queues=new Map();
async function update(ctx,change) {
  const previous=queues.get(ctx.stateFile) || Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{
    await fs.mkdir(path.dirname(ctx.stateFile),{recursive:true,mode:0o700});
    const lock=ctx.stateFile+'.lock';
    const release=await lease(lock);
    try {
      const current=await fs.readFile(ctx.stateFile,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      const state=current || {workflow_id:randomUUID(),manifest_path:ctx.file,definition_hash:ctx.definition_hash,canvas_key:randomUUID(),title:ctx.manifest.project || '视频工作流',paused:false,images:{},shots:{}};
      if(state.definition_hash!==ctx.definition_hash) throw invalid('Workflow definition changed');
      await change(state);state.updated_at=new Date().toISOString();
      const temp=ctx.stateFile+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(state,null,2),{mode:0o600});await fs.rename(temp,ctx.stateFile);ctx.state=state;return state;
    } finally {await release();}
  });queues.set(ctx.stateFile,next);
  try{return await next;}finally{if(queues.get(ctx.stateFile)===next)queues.delete(ctx.stateFile);}
}
async function lease(file) {
  for(let tries=0;tries<40;tries++) {
    try {const handle=await fs.open(file,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid}));await handle.close();return ()=>fs.rm(file,{force:true});}
    catch(error) {
      if(error.code!=='EEXIST')throw error;
      const owner=await fs.readFile(file,'utf8').then(JSON.parse).catch(()=>null);
      let dead=false;if(owner?.pid)try{process.kill(owner.pid,0);}catch(e){dead=e.code==='ESRCH';}
      const stat=await fs.stat(file).catch(()=>null);
      if(dead || !owner && stat && Date.now()-stat.mtimeMs>30000) {await fs.rm(file,{force:true});continue;}
      await new Promise(r=>setTimeout(r,100));
    }
  }
  throw invalid('This workflow is already being modified or run. Query its original state instead of starting a second runner.');
}
function summary(ctx) {return {...ctx.state,state_file:ctx.stateFile,canvas_url:ctx.state?.canvas_id?`${base()}/canvas.html?id=${ctx.state.canvas_id}`:null};}
function imageFile(ctx,image){const file=image.asset_paths?.generated_image || image.file || ctx.state?.images?.[image.image_id]?.file;return file?path.resolve(path.dirname(ctx.file),file):null;}
function externalUnknown(image){return /unknown|408|timeout/i.test(String(image.source?.status || '')) || image.source?.http_status===408;}
async function verifyImage(file,expected) {
  const stat=await fs.stat(file);if(!stat.isFile() || stat.size>20*1024*1024)throw invalid('Reference image must be a regular file no larger than 20 MB');
  const bytes=await fs.readFile(file),info=validateFrameData(bytes,'workflow image'),sha256=hash(bytes);
  if(expected && expected!==sha256)throw invalid('Reference image SHA256 differs from manifest or prepared asset');return {...info,sha256,bytes:bytes.length};
}
export async function preflightWorkflow(args) {
  const ctx=await manifestContext(args.manifest_path),images=[];
  for(const image of ctx.images) {
    const file=imageFile(ctx,image);let verified=null,error=null;
    if(file)try{verified=await verifyImage(file,ctx.state?.images?.[image.image_id]?.asset?.sha256 || image.asset_paths?.sha256);}catch(e){error=e.message;}
    images.push({image_id:image.image_id,file,verified,status:error?'invalid':verified?'available':externalUnknown(image)?'unknown_do_not_resubmit':'needs_generation',references:image.required_reference_ids || [],error});
  }
  const shots=ctx.shots.map(shot=>({shot_id:shot.shot_id,status:ctx.state?.shots?.[shot.shot_id]?.status || 'draft',missing:[shot.first_frame_source,shot.last_frame_source].filter(id=>id && !images.some(i=>i.image_id===id && i.verified)),mode:shot.last_frame_source?'first_last_frame':shot.first_frame_source?'image_to_video':'text_to_video'}));
  return {manifest_path:ctx.file,workflow_id:ctx.state?.workflow_id || null,canvas_id:ctx.state?.canvas_id || null,images,shots,ready:!images.some(i=>i.status==='invalid') && shots.every(s=>!s.missing.length),submitted:false};
}
async function attachImage(ctx,id,asset,status='ready',job=null) {
  // PUT uses current version; preserve any human edits elsewhere and let the
  // server reject changes to frozen video inputs.
  for(let attempt=0;attempt<3;attempt++) {
    const doc=await api(`/v1/canvases/${ctx.state.canvas_id}`),node=ctx.state.images[id];
    const existing=doc.cards.find(c=>c.id===node.card_id);
    const card={id:node.card_id,type:'image',x:-750,y:ctx.images.findIndex(i=>i.image_id===id)*480,...(existing || {}),prompt:ctx.images.find(i=>i.image_id===id).prompt,provider:node.provider,model:node.model,ratio:node.ratio,status:['running','submitting'].includes(status)?'generating':status,asset,assets:asset?[asset]:[],reference_images:(ctx.images.find(i=>i.image_id===id).required_reference_ids || []).map(parent=>ctx.state.images[parent]?.asset).filter(Boolean),image_job:job,error:status==='unknown' && !job?'外部原请求超时，没有可查询编号；请在原服务核对，禁止自动重发。':''};
    if(existing)Object.assign(existing,card);else doc.cards.push(card);
    for(const parentId of ctx.images.find(i=>i.image_id===id).required_reference_ids || []) {
      const parent=ctx.state.images[parentId];if(!doc.edges.some(e=>e.from===parent.card_id && e.to===node.card_id && e.role==='derived'))doc.edges.push({id:'e'+hash(parentId+id).slice(0,15),from:parent.card_id,to:node.card_id,role:'derived'});
    }
    const response=await fetch(base()+`/v1/canvases/${doc.id}`,{method:'PUT',headers:{Authorization:`Bearer ${config.localApiKey}`,'Content-Type':'application/json'},body:JSON.stringify(doc),signal:AbortSignal.timeout(20000)});
    if(response.ok)return;if(response.status!==409 || attempt===2)throw invalid('Canvas changed while attaching image; original job is retained. Retry preparation.');
  }
}
export async function prepareWorkflow(args) {
  const ctx=await manifestContext(args.manifest_path),check=await preflightWorkflow(args);
  if(check.images.some(i=>i.status==='invalid'))throw invalid(check.images.find(i=>i.error).error);
  const externalDefaults=ctx.images.some(image=>!ctx.state?.images?.[image.image_id] && !image.model && !image.model_verification?.requested_model && (image.provider==='openai-compatible' || /openai/i.test(image.source?.provider || '')))
    ? (await api('/v1/images/capabilities')).providers.find(provider=>provider.id==='openai-compatible') : null;
  await update(ctx,state=>{
    for(const image of ctx.images) {
      const provider=image.provider || (/openai/i.test(image.source?.provider || '')?'openai-compatible':'doubao-desktop');
      state.images[image.image_id] ||= {card_id:'i'+hash(state.workflow_id+image.image_id).slice(0,15),request_key:randomUUID(),status:externalUnknown(image)?'unknown':'draft',provider,model:image.model_verification?.requested_model || image.model || (provider==='openai-compatible'?externalDefaults?.requested_model || 'gpt-image-2.5':'Seedream 4.5'),ratio:image.ratio || ctx.manifest.ratio || '1:1',legacy_request_key:image.source?.idempotency_key || null};
    }
    for(const shot of ctx.shots)state.shots[shot.shot_id] ||= {compose_key:randomUUID(),status:'draft',task_id:shot.task_id || null};
  });
  if(!ctx.state.canvas_id) {
    const canvas=await api('/v1/canvases',{title:ctx.state.title,idempotency_key:ctx.state.canvas_key});await update(ctx,state=>{state.canvas_id=canvas.id;});
  }
  for(const image of ctx.images) {
    const node=ctx.state.images[image.image_id],file=imageFile(ctx,image);
    if(file) {
      await verifyImage(file,node.asset?.sha256 || image.asset_paths?.sha256);
      let asset=node.asset;
      if(!asset) {
        const imported=await uploadFrame(file);
        asset={...imported,provider:image.source?.provider || imported.provider || 'local-upload',requested_model:image.model_verification?.requested_model || image.model || imported.requested_model,
          model_verification:typeof image.model_verification==='object'?image.model_verification.status:image.model_verification || imported.model_verification || 'not_applicable',
          parent_assets:image.required_reference_ids?.length?image.required_reference_ids.map(id=>({asset_id:ctx.state.images[id]?.asset?.asset_id,path:ctx.state.images[id]?.asset?.path,sha256:ctx.state.images[id]?.asset?.sha256})):imported.parent_assets || []};
      }
      await update(ctx,state=>Object.assign(state.images[image.image_id],{asset,file,status:'completed'}));
      await attachImage(ctx,image.image_id,asset);
    } else await attachImage(ctx,image.image_id,null,node.status==='unknown'?'unknown':'draft',node.task_id || null);
  }
  for(const shot of ctx.shots) {
    const node=ctx.state.shots[shot.shot_id];if(node.card_id)continue;
    const first=ctx.state.images[shot.first_frame_source]?.asset,last=ctx.state.images[shot.last_frame_source]?.asset;
    if(shot.first_frame_source && !first || shot.last_frame_source && !last) {await update(ctx,state=>{state.shots[shot.shot_id].status='blocked';});continue;}
    const result=await api(`/v1/canvases/${ctx.state.canvas_id}/video-scenes`,{prompt:shot.prompt,model:shot.model || 'Seedance 2.0 Fast',duration:shot.duration ?? 5,ratio:shot.ratio || ctx.manifest.ratio || '16:9',...(first?{first_frame:first}:{}),...(last?{last_frame:last}:{}),idempotency_key:node.compose_key});
    await update(ctx,state=>Object.assign(state.shots[shot.shot_id],{card_id:result.card_id,status:node.task_id?'running':'draft'}));
  }
  return summary(ctx);
}
export async function workflowStatus(args) {
  const ctx=await manifestContext(args.manifest_path);if(!ctx.state)return {...await preflightWorkflow(args),status:'not_prepared'};
  for(const image of Object.values(ctx.state.images))if(image.task_id){try{const result=await api(`/v1/images/jobs/${image.task_id}`);image.status=result.status;image.cancellation=result.cancellation;}catch{image.status='unknown';}}
  for(const shot of Object.values(ctx.state.shots))if(shot.task_id){try{const result=await api(`/v1/videos/tasks/${shot.task_id}`);shot.status=result.status;shot.cancellation=result.cancellation;shot.delivery=result.delivery;shot.videos=result.videos;shot.model_verification=result.model_verification;shot.frames=result.frames;}catch{shot.status='unknown';}}
  return summary(ctx);
}
export async function runWorkflow(args) {
  if(args.live!==true)throw invalid('Run requires explicit live:true. Preflight and prepare do not generate.');
  const max=args.max_new_tasks ?? 1;if(!Number.isInteger(max) || max<1 || max>5)throw invalid('max_new_tasks must be 1..5');
  const timeout=args.timeout_seconds ?? 900;if(!Number.isInteger(timeout) || timeout<1 || timeout>3600)throw invalid('timeout_seconds must be 1..3600');
  await prepareWorkflow(args);const ctx=await manifestContext(args.manifest_path),release=await lease(ctx.stateFile+'.runner');let submitted=0;
  const deadline=Date.now()+timeout*1000;
  try {
    if(args.resume===true)await update(ctx,state=>{state.paused=false;});
    const paused=async()=>{ctx.state=JSON.parse(await fs.readFile(ctx.stateFile,'utf8'));return ctx.state.paused;};
    for(const image of ctx.images) {
      if(await paused() || Date.now()>=deadline)break;const node=ctx.state.images[image.image_id];
      if(node.status==='completed' || ['unknown','failed','cancelled'].includes(node.status) && !node.task_id)continue;
      const refs=(image.required_reference_ids || []).map(id=>ctx.state.images[id]?.asset);
      if(refs.some(ref=>!ref))continue;
      if(!node.task_id && submitted>=max)break;
      const fresh=!node.task_id;if(fresh){submitted++;await update(ctx,state=>Object.assign(state.images[image.image_id],{task_id:node.request_key,status:'submitting'}));}
      try {
        const result=await generateImageAndWait(fresh?{prompt:image.prompt,model:node.model,provider:node.provider,ratio:node.ratio,reference_images:refs,idempotency_key:node.request_key,timeout_seconds:Math.max(1,Math.floor((deadline-Date.now())/1000))}:{task_id:node.task_id,timeout_seconds:Math.max(1,Math.floor((deadline-Date.now())/1000))});
        const asset=result.images?.[0];await update(ctx,state=>Object.assign(state.images[image.image_id],{status:result.status,task_id:result.task_id,model_verification:result.model_verification,...(asset?{asset,file:asset.file}:{} )}));
        await attachImage(ctx,image.image_id,asset || null,result.status==='completed'?'ready':result.status,result.status==='completed'?null:result.task_id);
        if(result.status!=='completed')break;
      }catch(error){await update(ctx,state=>Object.assign(state.images[image.image_id],{status:error.diagnostic?.submitted===false?'failed':'unknown',error:error.diagnostic || {code:'response_unknown'},...(error.diagnostic?.submitted===false?{task_id:null}: {})}));break;}
    }
    // Newly generated image dependencies can now be composed, using the same keys.
    await prepareWorkflow(args);ctx.state=JSON.parse(await fs.readFile(ctx.stateFile,'utf8'));
    for(const shot of ctx.shots) {
      if(await paused() || Date.now()>=deadline)break;const node=ctx.state.shots[shot.shot_id];
      if(!node.card_id || ['failed','cancelled','completed'].includes(node.status))continue;
      if(!node.started && submitted>=max)break;
      const scenes=await api(`/v1/canvases/${ctx.state.canvas_id}/video-scenes`),scene=scenes.scenes.find(s=>s.card_id===node.card_id);
      if(!scene || scene.prompt!==shot.prompt.trim() || scene.model!==(shot.model || 'Seedance 2.0 Fast') || scene.duration!==Number(shot.duration || 5) || scene.ratio!==(shot.ratio || ctx.manifest.ratio || '16:9') || ['first_frame','last_frame'].some(role=>{const source=shot[role+'_source'];return (scene[role]?.sha256 || null)!==(source?ctx.state.images[source]?.asset?.sha256:null);}))throw invalid('Canvas scene differs from the prepared manifest; inspect it before running.');
      if(!node.started){submitted++;await update(ctx,state=>{state.shots[shot.shot_id].started=true;state.shots[shot.shot_id].status='submitting';});}
      try {
        let result=node.task_id?await api(`/v1/videos/tasks/${node.task_id}`):await api(`/v1/canvases/${ctx.state.canvas_id}/video-scenes/${node.card_id}/generate`,{});
        const frozen=(await api(`/v1/canvases/${ctx.state.canvas_id}/video-scenes`)).scenes.find(s=>s.card_id===node.card_id);
        await update(ctx,state=>Object.assign(state.shots[shot.shot_id],{task_id:result.task_id,status:result.status,request_key:frozen?.request_key || scene.request_key || null}));
        while(['submitting','running'].includes(result.status) && Date.now()<deadline && !await paused())result=await api(`/v1/videos/tasks/${result.task_id}?wait_seconds=${Math.min(25,Math.max(1,Math.floor((deadline-Date.now())/1000)))}`,null,Math.max(1000,deadline-Date.now()));
        await update(ctx,state=>Object.assign(state.shots[shot.shot_id],{status:result.status,task_id:result.task_id,delivery:result.delivery,videos:result.videos,frames:result.frames,model_verification:result.model_verification}));
        if(result.status!=='completed')break;
      }catch(error){await update(ctx,state=>Object.assign(state.shots[shot.shot_id],{status:error.diagnostic?.submitted===false?'failed':'unknown',error:error.diagnostic || {code:'response_unknown'}}));break;}
    }
    return {...summary(ctx),new_tasks:submitted};
  } finally {await release();}
}
export async function cancelWorkflow(args) {
  const ctx=await manifestContext(args.manifest_path);if(!ctx.state)throw invalid('Workflow is not prepared');
  await update(ctx,state=>{state.paused=true;});
  for(const [kind,nodes] of [['image',ctx.state.images],['video',ctx.state.shots]])for(const [id,node] of Object.entries(nodes)) {
    if(!node.task_id || ['completed','failed','cancelled'].includes(node.status))continue;
    try {const result=await api(kind==='image'?`/v1/images/jobs/${node.task_id}/cancel`:`/v1/videos/tasks/${node.task_id}/cancel`,{});await update(ctx,state=>Object.assign((kind==='image'?state.images:state.shots)[id],{status:result.status,cancellation:result.cancellation}));}
    catch{await update(ctx,state=>{(kind==='image'?state.images:state.shots)[id].cancellation={state:'unknown',confirmed:false};});}
  }
  return summary(ctx);
}
export async function exportWorkflow(args,outputDir) {
  const state=await workflowStatus(args);if(!state.workflow_id)throw invalid('Workflow is not prepared');
  const folder=path.join(outputDir,state.workflow_id);await fs.mkdir(folder,{recursive:true,mode:0o700});const clips=[];
  for(const [id,node] of Object.entries(state.shots)) {
    const video=node.videos?.find(isCloudVideo);
    if(node.status!=='completed' || !video){clips.push({shot_id:id,status:node.status,file:null});continue;}
    const source=await api(`/v1/videos/files/${encodeURIComponent(video.id)}/source`);if(!isCloudVideo(source))throw invalid('Export requires verified cloud video');
    const response=await fetch(base()+`/v1/videos/files/${encodeURIComponent(video.id)}`,{headers:{Authorization:`Bearer ${config.localApiKey}`},signal:AbortSignal.timeout(120000)});if(!response.ok)throw invalid('Video export download failed');
    const bytes=Buffer.from(await response.arrayBuffer()),sha256=hash(bytes);if(bytes.toString('ascii',4,8)!=='ftyp')throw invalid('Export is not an MP4');
    const file=path.join(folder,id+'-'+node.task_id.slice(0,10)+'.mp4');
    try{await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST' || hash(await fs.readFile(file))!==sha256)throw error;}
    clips.push({shot_id:id,task_id:node.task_id,canvas_id:state.canvas_id,card_id:node.card_id,file,sha256,bytes:bytes.length,width:video.width,height:video.height,duration:video.duration,source_verification:video.source_verification,frames:node.frames,model_verification:node.model_verification});
  }
  const report={workflow_id:state.workflow_id,canvas_id:state.canvas_id,clips,complete:clips.every(c=>c.file),editing_note:'Original clips only. Subtitles, narration, music and transitions still require editing.'};
  const file=path.join(folder,'edit-manifest.json');await fs.writeFile(file,JSON.stringify(report,null,2),{mode:0o600});return {...report,manifest_file:file};
}
