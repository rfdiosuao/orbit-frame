#!/usr/bin/env node
import path from 'node:path';
import {config} from '../src/config.js';
import {preflightWorkflow,prepareWorkflow,runWorkflow,workflowStatus,cancelWorkflow,exportWorkflow} from './canvas-workflow.mjs';
const [command,file,...flags]=process.argv.slice(2);
try {
  if(!command || ['help','--help','-h'].includes(command)) {
    console.log('Orbit Frame manifest workflow\n  preflight|prepare|status|cancel|export MANIFEST.json\n  run MANIFEST.json --live [--max-new-tasks 1 --timeout-seconds 900 --resume]\nPreflight/prepare never generate. Run is bounded to 1..5 new tasks, defaults to 1. Resume retains original task IDs. Export saves verified cloud MP4s plus an editing manifest.');
  }else {
    if(!['preflight','prepare','run','status','cancel','export'].includes(command) || !file || file.startsWith('--'))throw Error('Choose a command and a local manifest file');
    const args={manifest_path:path.resolve(file)};const allowed=command==='run'?['--live','--resume','--max-new-tasks','--timeout-seconds']:[];const seen=new Set();
    for(let i=0;i<flags.length;i++){const flag=flags[i];if(!allowed.includes(flag) || seen.has(flag))throw Error('Unknown or duplicate option '+flag);seen.add(flag);if(['--live','--resume'].includes(flag))args[flag.slice(2)]=true;else{if(!flags[i+1] || flags[i+1].startsWith('--'))throw Error('Missing value for '+flag);args[flag==='--max-new-tasks'?'max_new_tasks':'timeout_seconds']=Number(flags[++i]);}}
    const result=await ({preflight:preflightWorkflow,prepare:prepareWorkflow,run:runWorkflow,status:workflowStatus,cancel:cancelWorkflow,export:a=>exportWorkflow(a,path.join(config.dataDir,'exports','workflows'))}[command])(args);
    console.log(JSON.stringify(result));
  }
}catch(error){process.exitCode=1;console.log(JSON.stringify({status:'error',error:error.diagnostic || {code:'workflow_error',message:error.message,submitted:command==='run'?'unknown':false},recovery:'Read the original workflow status; do not change its manifest or task keys to retry.'}));}
