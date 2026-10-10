# 轨映 · Orbit Frame

The home page at `http://127.0.0.1:8787/` is a local video creation interface. It keeps the relay's existing endpoints and advanced management page (`/legacy.html`). Video creation uses the `doubao-desktop` provider, requests `Seedance 2.0 Fast`, accepts 1–15 seconds and 16:9, 9:16, 1:1, 4:3 or 3:4 framing. Download format is MP4.

The CLI, API and MCP also accept an explicit `Seedance 2.5` request for 4–30 seconds. Duration validation is shared by job submission and the desktop client; the longer limit does not apply to Fast or unknown model names. Account permissions remain upstream decisions, and `model_verification` remains `requested_only`.

The browser sends an authenticated `POST /v1/videos/generations` with a persisted idempotency key. It then queries the returned task ID, including after refresh. The video preview and download fetch `/v1/videos/files/:id` with the Bearer header, convert the response to a Blob and use a local object URL. A task is shown as complete only when it has a valid video ID and its file can be fetched. The works library reads authenticated, restricted metadata from `GET /v1/videos/tasks`; older recovered tasks without prompts receive date-based titles.

首页支持“文生视频 / 图生视频 / 首尾帧”切换。图生视频需要一张首帧；首尾帧模式需要首帧和尾帧，支持点击或拖放添加、预览、移除和交换。图片仅支持 PNG/JPEG/WebP，每张不超过 20 MB，每边 300–6000 像素，宽高比在 2:5 到 5:2 之间。图片与输出比例不同会提示可能裁切或补边。

网页通过带 Bearer 鉴权的 `POST /v1/videos/frames` 上传原始图片字节（`Content-Type: application/octet-stream`）。接口返回 `path`、尺寸、类型和受保护的 `preview_url`，图片以随机文件名保存到私有媒体目录的 `uploads/` 中。生成请求将返回的路径作为 `first_frame.path` / `last_frame.path`，并携带明确的 `mode`。提交草稿保留这些路径和幂等键；刷新或重试会继续同一次请求，不重新上传或重复创建任务。

The connection page reads an existing `doubao_local_api_key` browser value for compatibility. Newly entered keys stay in page memory unless “记住这台设备” is checked. The advanced page displays a placeholder in its example command. Do not add keys to URLs or server-rendered HTML.

HEANG design system assets under `public/heang/` are copied from `heang-design@0.1.0` (MIT). The page imports its tokens, motion CSS, `initPointerFX` and `runSplash`. The local splash uses the same `orbit-frame.svg` as the header and favicon. To refresh the assets, install the desired version with `npm install heang-design --registry=https://registry.npmmirror.com`, then copy the package's `assets/tokens.css`, `assets/motion.css`, `dist/index.js` and `LICENSE` together. The page's splash CSS intentionally uses `data-mode="sky"` and `data-mode="space"` consistently with the tokens.

Verification: `node --check public/app.js`, `node tests/video-response-regression.mjs`, `node tests/enterprise-video-extraction.mjs`, `node tests/video-library-safety.mjs`. A real video submission must still be verified in a browser with the local service and a valid client session.

连接诊断、断线恢复、提取重试和 Agent 使用方式见 [稳定性与恢复](STABILITY.md)。首页在线状态会检查豆包客户端；仅网关存活不会被显示为可以生成。
