# 本机设置、网页与 HTTP API

## 运行条件与启停

Skill 不含完整项目、豆包安装包或依赖。需使用包含本轮图片提供商、画布语义工具和清单脚本的 Orbit Frame 源码；如果 MCP tools/list 没有 13 个工具，先核对源码版本与运行进程。仅下载 Skill 不会部署网关。

项目需 Node.js 22.13+。首次安装在项目目录执行 `npm run setup`，随后 `npm start`；已经运行的项目不要重复安装或启动第二个网关。没有 Docker 依赖。

本机主页：`http://127.0.0.1:8787/`；画布：`http://127.0.0.1:8787/canvas.html`；生图服务设置：`http://127.0.0.1:8787/image-provider.html`。网关端口可由项目 `.env` 的 PORT 改变，CLI/MCP 自行读取。上游网页桥接和已登录的企业豆包客户端是两条不同连接，企业视频调用主要依赖后者；别仅以网页登录代替客户端检查。

已经安装本机 LaunchAgent 时，可在项目内使用：

```sh
zsh scripts/service.sh status
zsh scripts/service.sh restart
# 仅在用户要求停止或启动服务时使用
zsh scripts/service.sh stop
zsh scripts/service.sh start
```

restart 用项目有界重启程序核对新进程。网关重启后按原 task_id 继续监控；不要再发原提示词。普通 npm start 由终端保持运行；LaunchAgent 安装本身不包含在本 Skill 中。

## 两种密钥

| 名称 | 用途 | 如何使用 |
|---|---|---|
| LOCAL_API_KEY | 调用你自己的 Orbit Frame 网关 | 项目自动生成/保存在本机；CLI/MCP 自动读取。手动 HTTP 调用在请求头使用。不是从豆包获取 |
| OPENAI_API_KEY | 外接图片服务的密钥 | 仅保存在本机生图设置或私有环境配置；由网关调用图片提供商，不传给视频提示词 |

网页连接设置可查看/复制本地网关密钥。Agent 不需要把它复制进聊天、MCP 参数或 URL。豆包视频使用客户端的原登录会话，不使用外接图片密钥。

## 外接生图配置

本包对应的公开配置：

```dotenv
OPENAI_BASE_URL=http://127.0.0.1:63451/v1
OPENAI_API_KEY=YOUR_IMAGE_PROVIDER_KEY
OPENAI_MODEL=gpt-image-2.5
```

这三个变量是输入约定。当前项目直接读取的是本机 `data/image-provider.json`，也支持 ORBIT_IMAGE_BASE_URL/ORBIT_IMAGE_API_KEY 覆盖；不会自动将任意 OPENAI_* 变量当成生图配置。助手负责将上面的变量桥接到实际设置。

最简单的配置方式：打开生图设置页，填写地址、原服务密钥和别名，保存并检查连接。已有配置可直接用，无须再填。

CLI 配置：复制 `assets/image-provider.env.example` 到包外本机私有文件，在本机编辑真实密钥，然后执行：

```sh
chmod 600 /完整路径/私有生图配置.env
node /Skill目录/scripts/orbit.mjs --project /完整项目路径 \
  configure-images --env-file /完整路径/私有生图配置.env
```

也可由用户的私有运行环境设置 OPENAI_* 后运行 configure-images。既没有 env-file 也没有这些变量时，助手沿用现有本机配置；不会打印密钥。它以 600 权限保存到项目，再只读探测 /models，不会生成图片。输入文件按数据解析，不会执行 shell 命令。`ORBIT_IMAGE_*` 覆盖仍生效时，先核对启动网关的环境与保存的配置是否一致。

configured=true 表示已保存，connected=true 表示鉴权模型查询成功，model_available=true 表示发现请求别名；不等于已验证生成额度。实际请求名为 gpt-image-2.5，独立型号证据可能仍为 requested_only。适配器支持同步生成/参考编辑，目前不提供上游查询和取消。

## 人类在网页里的流程

1. 打开主页或镜头画布，确认连接检查显示客户端可用。
2. 输入本次视频提示词，选择型号、时长、画面比例。主页按需上传首帧/尾帧，看到预览后提交。
3. 画布优先从 compose_video_scene 返回的链接打开，文字、首帧、尾帧、视频卡及连线已经准备好；检查视频卡列出的实际角色输入再生成。手动调整未提交镜头时确保文字进入同一视频卡，图片分别进入首帧和尾帧角色。
4. 图片卡中“同提示词再生成”和“参考原图衍生”都是新草稿；后者绑定原始参考图。选择外接提供商和实际别名后再明确点击生成。
5. 进度展示观察到的阶段：已提交、生成中、等待确认、提取、校验、可预览。不要用阶段百分比推算上游完成时间。
6. 完成后页面播放视频或下载原片；暂停/异常用原任务恢复，不重新创建任务。素材替换、交换、撤销适用于草稿，已提交快照保持历史输入。

## HTTP API

通常让 Agent 用 CLI/MCP 即可，无须手写鉴权。需要接入自己的程序时，在 `Authorization: Bearer LOCAL_API_KEY` 请求头携带本机密钥；视频和图片的绝对本地路径由调用端读取后上传，不能让 HTTP 网关任意读取本机文件。

| 方法与路径 | 功能 |
|---|---|
| GET /health | 网关进程检查；不代替功能验证 |
| GET /v1/videos/readiness?refresh=1 | 视频连接和参数能力 |
| POST /v1/videos/frames | PNG/JPEG/WebP 原始字节上传，Content-Type 为 application/octet-stream 或图片 MIME |
| POST /v1/videos/generations | 提交视频；provider=doubao-desktop，async=true 立即返回任务 |
| GET /v1/videos/tasks/:id | 本地状态；wait_seconds=0..60，主动恢复可用 refresh=1 |
| GET /v1/videos/tasks/:id/events | SSE 状态流，密钥放请求头 |
| POST /v1/videos/tasks/:id/cancel | 取消原任务与回执 |
| GET /v1/videos/files/:id/source | 检查原片来源 |
| GET /v1/videos/files/:id | MP4 文件 |
| POST /v1/images/jobs | 统一生图/编辑任务，参考图为已经上传的 descriptor |
| GET /v1/images/jobs/:id | 图片状态；可 wait_seconds/refresh |
| POST /v1/images/jobs/:id/cancel | 原图片取消 |
| GET /v1/images/capabilities?probe=1 | 图片服务与模型发现 |
| POST /v1/images/provider | 保存本机生图设置 |
| GET /v1/media?dir=generated或uploads | 已有图片 |
| GET、POST /v1/canvases | 列出、创建画布 |
| GET、PUT /v1/canvases/:id | 读取、版本保护保存 |
| GET、POST /v1/canvases/:id/video-scenes | 镜头语义读取、准备 |
| POST /v1/canvases/:id/video-scenes/:cardId/generate | 按镜头生成 |
| POST /v1/chat/completions | 兼容聊天接口，属于网页桥接；视频建议用专用任务 API |
| POST /v1/images/generations | 兼容图片接口；本 Skill 优先使用可恢复的 images/jobs |

视频 API 的 JSON 示例，先把两个原图上传并拿到真实 path：

```json
{
  "provider":"doubao-desktop",
  "prompt":"严格使用原图，从首帧平滑过渡到尾帧",
  "model":"Seedance 2.5",
  "duration":5,
  "ratio":"9:16",
  "mode":"first_last_frame",
  "first_frame":{"path":"uploads/真实首帧文件.png"},
  "last_frame":{"path":"uploads/真实尾帧文件.png"},
  "idempotency_key":"本次生成的真实UUID",
  "async":true
}
```

## 常见异常

| 表现 | 处理 |
|---|---|
| MCP 不见新工具或参数不识别 | 检查运行源码版本，重连服务器，读取 tools/list；不要猜旧工具名 |
| 401 | 区分本地网关鉴权与外部图片服务鉴权；用本机设置检查，不向聊天输出密钥 |
| 客户端/CDP 未连接或未登录 | 让用户在原豆包客户端恢复登录，再只读 check；不要切换账户假装验证成功 |
| 请求图片找不到或类型不对 | 核对实际文件、尺寸和 PNG/JPEG/WebP 字节；不能重绘替代 |
| waiting_input | 保留原任务，检查 next_action，补足实际要求，不新提交 |
| unknown/408/断线 | 查询原编号，保留未知，不换键重发；外接服务需核查原服务 |
| extraction_failed | 对原视频任务 refresh，再检查云盘原片，不回退普通视频卡 |
| 只有 completed 但下载不成功 | 检查来源验证、可用输出目录和是否已有同名文件；按原任务重新导出 |
| 画布冲突 | 不同字段可合并；真实同字段冲突保留副本，不能覆盖已提交快照 |
| 尝试“取消”仍有视频返回 | 读真实 cancellation 回执；上游可能已经完成或不支持取消 |

维护时读取项目 `docs/AGENT-WORKFLOW.md` 和最新验收报告；不要把健康检查、参数范围或旧测试当成新的真实生成成功。
