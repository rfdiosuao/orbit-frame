import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
const example='local-dev-key-change-me';
const usable=value=>typeof value==='string' && /^[\x21-\x7e]+$/.test(value) && value!==example;
export function ensureLocalApiKey(root, configured) {
  if(usable(configured))return configured;
  const file=path.join(root,'.env');let text='';
  try{text=readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  // Horizontal whitespace only: a blank value must never consume the next
  // comment line. Such a value would be invalid in an HTTP Bearer header.
  const raw=text.match(/^LOCAL_API_KEY[ \t]*=[ \t]*([^\r\n]*)$/m)?.[1]?.trim() || '';
  const quoteEnd=raw.indexOf(raw[0],1);
  const saved=/^['"]/.test(raw)?(quoteEnd>0?raw.slice(1,quoteEnd):''):raw.split('#')[0].trim();
  if(usable(saved))return saved;
  const key=randomBytes(32).toString('hex');
  const line=`LOCAL_API_KEY=${key}`;
  const next=/^LOCAL_API_KEY[ \t]*=.*$/m.test(text)?text.replace(/^LOCAL_API_KEY[ \t]*=.*$/m,line):`${text}${text.endsWith('\n')||!text?'':'\n'}${line}\n`;
  const temp=`${file}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temp,next,{flag:'wx',mode:0o600});renameSync(temp,file);
  return key;
}
