import path from 'node:path';
import { generateImageAndWait, copyImageExports, imageRequest } from './image-workflow.mjs';
const args=process.argv.slice(2),refs=[],options={};let prompt;
const flags=new Set(['--model','--provider','--ratio','--key','--timeout-seconds','--output-dir','--task','--reference-image']);
try {
  if(args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Orbit Frame image CLI\n  doubao-image.mjs "prompt" [--reference-image FILE (repeatable)] [--provider doubao-desktop|openai-compatible --model MODEL --ratio 16:9 --key UUID --timeout-seconds 900 --output-dir DIR]\n  doubao-image.mjs --task TASK_ID\n  doubao-image.mjs cancel TASK_ID\n  doubao-image.mjs providers\nCredentials load automatically. References upload as original bytes. Resume original task IDs after timeouts.\n');
  } else if(args[0]==='cancel') {
    if(args.length!==2) throw Error('cancel requires one task ID');
    process.stdout.write(JSON.stringify(await imageRequest(`/v1/images/jobs/${encodeURIComponent(args[1])}/cancel`,{method:'POST',body:'{}'}))+'\n');
  } else if(args[0]==='providers') {process.stdout.write(JSON.stringify(await imageRequest('/v1/images/capabilities?probe=1'))+'\n');}
  else {
    for(let i=0;i<args.length;i++) {
      const arg=args[i];
      if(arg.startsWith('--')) {if(!flags.has(arg)) throw Error(`不支持参数 ${arg}；参考图请用 --reference-image FILE`);const next=args[++i];if(!next || next.startsWith('--')) throw Error(`${arg} 缺少参数值`);if(arg==='--reference-image')refs.push(next);else if(options[arg]!=null) throw Error(`重复参数 ${arg}`);else options[arg]=next;}
      else {if(prompt!=null) throw Error('只能提供一段提示词');prompt=arg;}
    }
    const result=await generateImageAndWait({prompt,task_id:options['--task'],idempotency_key:options['--key'],provider:options['--provider'],model:options['--model'],ratio:options['--ratio'],reference_image_paths:refs,timeout_seconds:Number(options['--timeout-seconds']||600)},
      job=>process.stderr.write(`Image ${job.id}: ${job.phase || job.status}\n`));
    if(result.status==='completed' && options['--output-dir'])result.images=await copyImageExports(result.images,path.resolve(options['--output-dir']));
    process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.status==='completed'?0:['failed','cancelled'].includes(result.status)?1:2;
  }
} catch(error) {process.stdout.write(JSON.stringify({error:error.diagnostic || {code:'invalid_request',message:error.message,submitted:false}})+'\n');process.exitCode=1;}
