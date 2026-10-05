import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
const example='local-dev-key-change-me';
export function ensureLocalApiKey(root, configured) {
  if(configured && configured!==example)return configured;
  const file=path.join(root,'.env');let text='';
  try{text=readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  const saved=text.match(/^LOCAL_API_KEY\s*=\s*(.*)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g,'');
  if(saved && saved!==example)return saved;
  const key=randomBytes(32).toString('hex');
  const line=`LOCAL_API_KEY=${key}`;
  const next=/^LOCAL_API_KEY\s*=.*$/m.test(text)?text.replace(/^LOCAL_API_KEY\s*=.*$/m,line):`${text}${text.endsWith('\n')||!text?'':'\n'}${line}\n`;
  const temp=`${file}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temp,next,{flag:'wx',mode:0o600});renameSync(temp,file);
  return key;
}
