#!/usr/bin/env node
import {config} from '../src/config.js';
import {spawnSync} from 'node:child_process';
if (process.argv.includes('--copy')) {
  if (process.platform !== 'darwin') throw new Error('Clipboard copy requires macOS; read LOCAL_API_KEY from your local .env');
  if (!config.localApiKey || config.localApiKey === 'local-dev-key-change-me') throw new Error('Please configure a random LOCAL_API_KEY in .env first');
  const result = spawnSync('pbcopy', [], {input: config.localApiKey});
  if (result.error || result.status !== 0) throw new Error('Clipboard copy failed');
  console.log('本地 API Key 已复制。请粘贴到连接设置；不要分享或上传。');
} else {
  console.log(`API 地址：http://127.0.0.1:${config.port}\n密钥位置：本机 .env 的 LOCAL_API_KEY\n复制到剪贴板：npm run api:key -- --copy`);
}
