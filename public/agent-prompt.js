// Copyable instructions that let an agent generate videos and images through
// the local MCP server or CLI. They never contain LOCAL_API_KEY.
const q = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

export function agentPrompts({ base, projectDir, mediaDir }) {
  const mcpScript = `${projectDir}/scripts/orbit-frame-mcp.mjs`;
  const rules = `规则：
- 不要索取、读取、打印或保存 LOCAL_API_KEY，也不要读取 .env；工具会自行完成认证。
- 视频生成通常需要几分钟。拿到 task_id 后只用它继续查询，不要用同一提示词重新提交，否则会重复生成。
- 首帧 / 尾帧图片必须放在媒体目录 ${mediaDir} 内；生成的图片默认就保存在这里，可直接用作首帧或尾帧。
- 时长 1–15 秒；视频比例可用 16:9、9:16、1:1、4:3、3:4；图片比例可用 1:1、16:9、9:16、4:3、3:4。
- 任务进入 waiting_input 时，请我在豆包客户端处理；不要替我确认任何付费或收费选项。
- 完成后回复：task_id、视频或图片的本地文件路径、预览地址。`;

  const mcp = `你可以通过本机「轨映 Orbit Frame」的 MCP 服务 orbit-frame 直接生成视频和图片（网关：${base}）。

可用工具：
1. generate_image — 生成图片并保存到本地。
   参数：prompt（必填）、model（Seedream 5.0 Lite / Seedream 5.0 / Seedream 4.5 / Seedream 4.0，默认 Seedream 4.5）、ratio（默认 1:1）。
   返回：images[].file（绝对路径）和 images[].media_path（可直接作为视频首帧 / 尾帧）。
2. generate_and_wait — 生成视频并等待 MP4 下载、校验完成。
   参数：prompt（必填）、model（默认 Seedance 2.0 Fast）、duration（秒，默认 5）、ratio（默认 16:9）、
   mode（text_to_video / image_to_video / first_last_frame）、first_frame: {"path": "..."}、last_frame: {"path": "..."}、timeout_seconds（默认 900）。
   返回：task_id、status、file（本地 MP4）、preview_url。若返回 timed_out，改用 get_video_status 继续等待。
3. get_video_status — 参数 task_id、wait_seconds（0–60），查询或等待任务状态。
4. download_video — 参数 task_id、filename（可选，仅文件名），把成片复制到导出目录。

常用流程：
- 文生视频：generate_and_wait {"prompt": "金色小狐狸沿海边奔跑", "duration": 6, "ratio": "9:16"}
- 先出图再图生视频：generate_image 得到 media_path，然后 generate_and_wait {"mode": "image_to_video", "first_frame": {"path": "<media_path>"}, "prompt": "角色缓缓转身微笑"}
- 首尾帧过渡：generate_and_wait {"mode": "first_last_frame", "first_frame": {"path": "first.png"}, "last_frame": {"path": "last.png"}, "prompt": "镜头从室内平滑过渡到海边"}

${rules}

如果 orbit-frame 工具不可用，请让我先注册 MCP 服务：
doubao mcp register orbit-frame --command "$(command -v node)" --arg ${q(mcpScript)}`;

  const cli = `你可以在终端通过本机「轨映 Orbit Frame」的命令行直接生成视频和图片（网关：${base}）。
所有命令都在项目目录运行：cd ${q(projectDir)}
命令会自行读取密钥并只输出 JSON 结果，不会打印密钥或签名链接。

生成图片（默认保存到 ${mediaDir}/generated，可直接用作视频首帧 / 尾帧）：
npm run --silent image:desktop -- "一只戴墨镜的橘猫，赛博朋克霓虹" --model "Seedream 4.5" --ratio 1:1
输出的 images[].media_path 就是首帧 / 尾帧可用的路径。

生成视频并等待保存（--output 必须是不存在的新文件）：
npm run --silent video:desktop -- generate "金色小狐狸沿海边奔跑" --duration 6 --ratio 9:16 --output ./fox.mp4 --timeout-seconds 900

图生视频（首帧）：
npm run --silent video:desktop -- generate "角色缓缓转身微笑" --mode image_to_video --first-frame start.png --duration 6 --ratio 9:16 --output ./turn.mp4

首尾帧过渡：
npm run --silent video:desktop -- generate "镜头从室内平滑过渡到海边" --mode first_last_frame --first-frame first.png --last-frame last.png --duration 6 --ratio 16:9 --output ./transition.mp4

退出码：0 成功；1 失败；2 需要继续或人工处理。退出码为 2 且输出含 task_id 时，用同一个任务继续，不要重新提交：
npm run --silent video:desktop -- generate --task <task_id> --output ./fox.mp4 --timeout-seconds 900

查询状态：npm run --silent video:desktop -- status <task_id> --wait-seconds 30

${rules}`;
  return { mcp, cli };
}

export function setupAgentPrompt(paths) {
  const select = document.getElementById('agentPromptKind');
  const code = document.getElementById('agentPromptCode');
  const notice = document.getElementById('agentPromptNotice');
  const copy = document.getElementById('copyAgentPrompt');
  if (!paths?.projectDir) {
    code.textContent = '连接本机网关后自动生成提示词。';
    copy.disabled = true;
    return;
  }
  const prompts = agentPrompts({ base: location.origin, ...paths });
  const render = () => { code.textContent = prompts[select.value]; notice.textContent = ''; };
  select.onchange = render;
  render();
  copy.disabled = false;
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(code.textContent); notice.textContent = '提示词已复制，粘贴给 Agent 即可；其中不含 API Key。'; }
    catch { notice.textContent = '浏览器不允许复制，请手动选中提示词复制。'; }
  };
}
