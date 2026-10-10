import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {standardUtf8Zip} from '../deployment/build-package.mjs';
const exec=promisify(execFile);

test('source ZIP keeps Chinese script names executable and supports standard extractors',async()=>{
  if(process.platform!=='darwin')return;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-zip-format-'));
  try {
    const source=path.join(dir,'源码 空格');await fs.mkdir(source);
    const file=path.join(source,'Mac-一键安装.command');const payload='#!/bin/zsh\necho 测试\n';
    await fs.writeFile(file,payload,{mode:0o755});
    const raw=path.join(dir,'raw.zip');await exec('/usr/bin/ditto',['-c','-k','--keepParent','--norsrc','--noextattr','--noqtn',source,raw]);
    const bytes=standardUtf8Zip(await fs.readFile(raw));
    let found=false;
    for(let at=0;at+46<bytes.length;at++)if(bytes.readUInt32LE(at)===0x02014b50){
      const size=bytes.readUInt16LE(at+28),name=bytes.subarray(at+46,at+46+size).toString('utf8');
      if(name.endsWith('Mac-一键安装.command')){found=true;assert.ok(bytes.readUInt16LE(at+8)&0x800);const local=bytes.readUInt32LE(at+42);assert.ok(bytes.readUInt16LE(local+6)&0x800);}
    }
    assert.equal(found,true);
    const normalized=path.join(dir,'normalized.zip');await fs.writeFile(normalized,bytes);
    const extracted=path.join(dir,'extracted');await exec('/usr/bin/ditto',['-x','-k',normalized,extracted]);
    const result=path.join(extracted,'源码 空格/Mac-一键安装.command');
    assert.equal(await fs.readFile(result,'utf8'),payload);assert.ok((await fs.stat(result)).mode&0o111);
    assert.throws(()=>standardUtf8Zip(Buffer.from('not a zip')));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
