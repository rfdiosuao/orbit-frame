# 轨映 · Orbit Frame

![轨映 Logo](public/orbit-frame.svg)

一个在 macOS 上运行的豆包企业客户端视频创作工作台：在页面填写提示词、时长和画面比例，经本机网关调用已登录的豆包客户端，再提取并校验真实 MP4。界面采用 HEANG 的天空 / 深空主题，包含 Logo 开屏动画、真实生成状态、作品库和视频预览。

## 安装与教程

- **[从零部署与使用教程](docs/DEPLOYMENT.md)**：环境准备、安装、登录、页面创作、CLI、HTTP 接口和常见问题。
- [界面设计与前端实现](docs/ORBIT-FRAME.md)
- [架构与验证结果](docs/ARCHITECTURE.md)

```bash
git clone https://github.com/rfdiosuao/orbit-frame.git
cd orbit-frame
cp .env.example .env
npm install --registry=https://registry.npmmirror.com
npm run setup:upstream
npx playwright install chromium
# 启动时自动生成并保存网关密钥
npm start
```

打开 **http://127.0.0.1:8787/** 即自动连接，无需填写密钥。企业客户端视频需要已登录的 **Doubao.app** 及本机 CDP；准备方法见部署教程。

## 当前功能

- 提示词、1–15 秒时长、横屏 16:9 / 竖屏 9:16 / 方形 1:1，另支持 4:3 / 3:4。
- 默认请求 Seedance 2.0 Fast，输出 MP4。实际执行模型 ID 尚未独立核验，模型名表示请求值。
- 真实任务状态、刷新恢复、幂等提交、白名单视频确认自动继续、成片提取与 MP4 校验。
- 后台 watcher 通过一条复用的 CDP 连接推进任务；状态查询只读本地（毫秒级），页面经 SSE 接收进度并显示「已提交 → 豆包生成中 → 等待确认 → 提取视频 → 文件校验 → 可预览」。
- 图生视频（`image_to_video`）与首尾帧（`first_last_frame`），参考图限定在媒体目录内。
- 豆包只在回复文字中给出 `aka.doubaocdn.com` 短链时，也能下载并校验成片。
- 本地 stdio MCP 服务，Agent 用结构化参数生成视频，不接触 API Key。
- Bearer 认证的作品列表和文件接口；预览使用 Blob URL。
- 天空 / 深空主题、Logo 与加载动画、手机布局及减少动态效果支持。
- 保留原有文生图入口和高级账号、Cookie、日志管理。

视频链路在 macOS 上已实际验收：6 秒 9:16 小狐狸视频，生成文件 720×1280、视频轨 6.04 秒；HTTP 下载和完整 FFmpeg 解码通过。旧任务恢复、刷新与防止重复生成均有实际验证。内嵌浏览器下载按钮落盘没有独立核验；CLI 下载可直接保存文件。其他客户端版本和操作系统仍需现场验证。

## 获取本地 API Key

Key 是网关自动生成的本机访问密码，保存在 `.env` 的 `LOCAL_API_KEY`，无需向豆包申请或手工填写。网页自动连接；外部程序调用 API 时，在「连接设置」点击「复制 API Key」。页面保留 cURL / Python API 示例。

## CLI 示例

```bash
# 一次调用，自动等待成片并保存
npm run --silent video:desktop -- generate "清晨海边的小狐狸奔跑" --duration 6 --ratio 9:16 --key fox-auto-001 --output ./fox.mp4
# 或分步提交、查询、下载
npm run --silent video:desktop -- submit "清晨海边的小狐狸奔跑" --duration 6 --ratio 9:16 --key my-first-video --async
npm run --silent video:desktop -- status <task-id> --wait-seconds 45
npm run --silent video:desktop -- download <video-id> ./output.mp4
```

密钥从本地 `.env` 读取，CLI 不打印密钥。查询时继续使用原任务 ID；同一 `--key` 只能用于相同请求。

## 任务状态与 SSE

- `GET /v1/videos/tasks/:task_id`：只读本地状态；`?wait_seconds=N` 等待状态变化；`?refresh=1` 让暂停的任务（`unknown` / `waiting_input` / `extraction_failed` / `video_missing`）立即重查一次豆包。
- `GET /v1/videos/tasks/:task_id/events`：SSE 状态流，同样需要 Bearer，任务停止运行后自动关闭。
- 响应中的 `phase`：`submitted` → `generating` → `awaiting_confirmation` → `extracting` → `validating` → `ready`。
- 页面支持 `/?task=<task_id>` 直接打开某个任务。

## 图生视频与首尾帧

```json
{
  "provider": "doubao-desktop",
  "mode": "first_last_frame",
  "prompt": "镜头从室内平滑过渡到海边",
  "duration": 6,
  "ratio": "16:9",
  "first_frame": { "path": "first.png" },
  "last_frame": { "path": "last.png" }
}
```

- `mode`：`text_to_video`（默认）、`image_to_video`（需要 `first_frame`）、`first_last_frame`（需要 `first_frame` 和 `last_frame`）。
- 图片必须位于 `ORBIT_FRAME_MEDIA_DIR`（默认 `data/media`），相对路径按该目录解析，符号链接逃逸会被拒绝。
- 按内容识别 PNG / JPEG / WebP；单张不超过 20 MB，每边 300–6000 像素，宽高比 2:5–5:2。比例与 `ratio` 不符时在 `warnings` 中提示。
- 网关把校验过的字节复制为 `first_frame.*` / `last_frame.*`，按顺序作为附件上传，并在提示中写明首帧、尾帧角色。
- 成片只以文字短链给出时，只从助手消息提取，下载后核对时长（±1.5 秒）与画面比例。

短链提取已用一次真实首尾帧探测任务验证：1280×720、5.04 秒 MP4，FFmpeg 完整解码通过。经网关完整提交图生视频 / 首尾帧任务尚未单独验收；页面还没有首帧 / 尾帧上传区。

## Agent / MCP

`scripts/orbit-frame-mcp.mjs` 是本地 stdio MCP 服务，自行读取 `LOCAL_API_KEY`，不会把密钥交给 Agent。工具：

- `generate_and_wait`：`prompt`、`model`、`duration`、`ratio`、`mode`、`first_frame`、`last_frame`、`wait`、`timeout_seconds`、`idempotency_key`；返回 `task_id`、本地 MP4 路径和预览地址。超时后用 `get_video_status` 继续，不要重新提交。
- `get_video_status`：查询状态，可等待最多 60 秒。
- `download_video`：只写入 `ORBIT_FRAME_OUTPUT_DIR`（默认 `data/exports`），只接受文件名。

```bash
doubao mcp register orbit-frame --command "$(command -v node)" --arg "$PWD/scripts/orbit-frame-mcp.mjs"
```

## 来源与许可

本项目基于 [linyf-B/doubao-relay](https://github.com/linyf-B/doubao-relay) 的本地工作副本，保留其源码和历史文档；此仓库展示的是当前实际实现。原版扩展功能说明归档于 [旧版 README](docs/README.upstream.md)，其中列出的 ToonFlow、Cursor 等模块不能视为本版本已实现。

- [doubao-cli](https://github.com/Fullstop000/doubao-cli)：固定依赖 `0.13.0`，用于本机客户端桥接。
- `heang-design@0.1.0`：设计变量和交互动画；[MIT 许可证](public/heang/LICENSE)。
- 内嵌 `doubao-free-api`：[原许可证](vendor/doubao-free-api/LICENSE)。

本项目需要用户自己的客户端登录和视频权限。源码不包含登录态、密钥、生成的视频、账户数据或本机运行日志。网关默认仅监听回环地址，适合本机使用。
