# Agent 直接上传图片与安排视频镜头

## 直接生成：不经过画布界面

CLI 接受本机任意位置的 PNG、JPEG、WebP。路径有空格时用引号，推荐完整路径。上传与密钥均自动处理。

```sh
# 一张图自动使用图生视频
npm run video:desktop -- generate "狐狸的尾巴微微飘动，镜头缓慢推进" \
  --first-frame "/Users/yourname/Desktop/首帧.png" --output ./image-video.mp4

# 两张图自动使用首尾帧
npm run video:desktop -- generate "从清晨自然过渡到星夜，保持人物与构图" \
  --first-frame "/Users/yourname/Desktop/首帧.png" \
  --last-frame "/Users/yourname/Desktop/尾帧.png" --output ./first-last.mp4

# 单独上传，返回素材路径、尺寸与 SHA256，不消耗生成额度
npm run video:desktop -- upload-frame "/Users/yourname/Desktop/首帧.png"
```

对应 MCP 调用：

```json
{
  "prompt": "从清晨自然过渡到星夜，保持人物与构图",
  "first_frame_path": "/Users/yourname/Desktop/首帧.png",
  "last_frame_path": "/Users/yourname/Desktop/尾帧.png",
  "duration": 5,
  "ratio": "16:9"
}
```

工具名 `generate_and_wait`。默认 `mode=auto`：0 张图为文生视频，1 张图为图生视频，2 张图为首尾帧。只有尾帧、明确要求文生却又传图、只指定首尾帧模式但少了一张图，都在提交前报错；不静默降级。也保留 `first_frame: {"path": "..."}` / `last_frame` 写法。一个角色不要同时传两种写法。

`list_media` 可查 `generated` / `uploads` 素材；返回的 `path` 可直接传帧参数。`generate_image` 的图片也可直接使用。`upload_frame` 接收 `{"path":"/完整路径/图片.png"}`。所有图片先在 CLI/MCP 进程读取并验证，再把字节上传；HTTP 网关仍只允许读取受保护的素材目录，没有开放任意本机文件读取。

每张图片最多 20 MB，每边 300–6000 像素，支持比例 2:5–5:2。任务返回角色、尺寸、字节数、SHA256。提供帧时优先使用原图，不能用提示词重绘替代。

## 画布：按镜头组织，由系统连线

MCP `compose_video_scene` 接收提示词和本地首尾帧路径，一次完成上传、文字/图片/视频卡、角色连线和布局。只创建草稿，不会开始生成。

```json
{
  "title": "云海归航",
  "prompt": "从清晨自然过渡到星夜，保持人物与构图",
  "first_frame_path": "/Users/yourname/Desktop/首帧.png",
  "last_frame_path": "/Users/yourname/Desktop/尾帧.png",
  "duration": 5,
  "ratio": "16:9"
}
```

返回 `canvas_id`、`card_id`、各角色、缺失项及画布链接。下一步：

```json
{"canvas_id": "返回的画布编号", "card_id": "返回的视频卡编号"}
```

传给 `generate_and_wait`。使用该镜头已保存的输入，不传提示词/图片/模型覆盖参数。生成前保存幂等键和帧快照，任务编号挂回原视频卡；两个 Agent 同时调用也沿用同一编号。已提交镜头不能改输入，重新生成应明确新建镜头。

给 `compose_video_scene` 加 `canvas_id` 可追加镜头；再加 `card_id` 可替换尚未提交的镜头。专属输入卡原位复用；共享图片或文字不被改写。网页「同步镜头」读取 Agent 修改，打开返回的画布链接会定位正确画布。

`get_canvas({})` 列出画布；`get_canvas({canvas_id})` 读取实际提示词、帧角色、缺失项、冻结状态和原任务编号。Agent 不必读屏或计算拖线坐标。

CLI 也有对应流程：

```sh
npm run video:desktop -- scene "从清晨过渡到星夜" \
  --first-frame "/Users/yourname/Desktop/首帧.png" --last-frame "/Users/yourname/Desktop/尾帧.png"
npm run video:desktop -- scenes CANVAS_ID
npm run video:desktop -- generate --canvas CANVAS_ID --card CARD_ID --output ./clip.mp4
```

## 超时和客户端刷新

- MCP 恢复：`generate_and_wait({task_id: "原编号"})`，或 `get_video_status({task_id: "原编号"})`。
- CLI 恢复：`generate --task 原编号 --output ./clip.mp4`。恢复不重新读/上传图片、不再次提交。
- 新工具尚未出现时，重连/重启 MCP 连接，让客户端重新获取 tools/list。项目根目录的 CLAUDE.md、AGENTS.md 已写明优先使用图片工具。
- 项目根目录已提供 `.mcp.json`。在此目录打开 Claude Code 可发现 orbit-frame；若客户端显示项目 MCP 首次信任提示，按客户端正常流程确认。配置不含密钥，服务自己读取本机配置。[Claude Code 项目 MCP 说明](https://code.claude.com/docs/en/mcp)。
- 所有生成依赖豆包登录、模型权限和上游支持。请求含图片并不等于上游已按首尾帧执行，验收还需要比对视频首尾画面。

HTTP 语义入口：`GET /v1/canvases/:id/video-scenes`、`POST /v1/canvases/:id/video-scenes`、`POST /v1/canvases/:id/video-scenes/:cardId/generate`。均需本地 API 密钥。

## 参考原图编辑与外部生图服务

打开 `http://127.0.0.1:8787/image-provider.html`，填写 OpenAI 兼容地址、服务密钥和实际模型别名，保存并检查连接。凭据以仅当前用户可读的文件保存在本机，不会返回给 Agent，也不放进 Git。当前机器已发现 `gpt-image-2.5`；这是服务提供的请求别名，响应没有独立型号证明。

```sh
npm run image:desktop -- "保持人物、服装、构图，只把窗光改成淡紫色" \
  --provider openai-compatible --model gpt-image-2.5 --ratio 9:16 \
  --reference-image "/Users/yourname/Desktop/原图.png" --key UUID
```

MCP `generate_image` 使用 `reference_image_paths` 数组；也可传 `reference_images: [{"path":"uploads/xxx.png"}]` 复用已上传素材。两种写法不要同时传。最多 8 张参考图，所有图片先校验再提交；外部编辑使用实际原图字节作为 multipart 附件，采用 [Images API 编辑协议](https://developers.openai.com/api/reference/resources/images)。`get_image_capabilities({probe:true})` 返回连接、实际别名发现和 generate/edit/query/cancel 能力，连接成功不代替生成权限证明。

```json
{
  "provider": "openai-compatible",
  "model": "gpt-image-2.5",
  "prompt": "保持人物、服装、构图，只改变窗光",
  "ratio": "9:16",
  "reference_image_paths": ["/Users/yourname/Desktop/原图.png"],
  "idempotency_key": "一个新的UUID"
}
```

画布图片卡的「同提示词再生成」创建新的草稿；「参考原图衍生」创建绑定实际原图的编辑草稿。两者都需要明确点击生成。输出保存 provider、请求模型、核验等级、任务编号、SHA256 和父参考资产。导入已有素材时保留来源，重新核验实际字节，不根据 metadata 中旧的 hash 相信图片。

图片恢复：CLI `--task 原编号`，MCP `generate_image({task_id:"原编号"})`。本地幂等键只证明网关不会重复提交，不能替上游同步服务保证去重。当前外部适配器不支持原请求查询或取消；HTTP 408、断线、进程退出导致结果无法判断时，继续显示 unknown，核查原服务后再决定新请求。历史短剧 img-3 的 408 请求没有恢复编号，仍保持未知，未自动重发。

## 取消、输入冻结与冲突

- CLI：`npm run video:desktop -- cancel TASK_ID`；图片用 `npm run image:desktop -- cancel TASK_ID`。
- MCP：`cancel_task({kind:"video",task_id:"原编号"})`；图片将 kind 改为 image。
- HTTP：`POST /v1/videos/tasks/:id/cancel`、`POST /v1/images/jobs/:id/cancel`。

读取 `cancellation.state/accepted/confirmed`：requested 表示记录意图；cancelled 且 confirmed=true 才表示上游确认停止；already_completed 表示已经完成；unsupported 和 unknown 都不能理解成上游停止。本地超时和暂停不代替上游取消。没有原 run 编号时保留取消意图，收到编号后只尝试原任务。取消回执丢失不会自动重发。

视频在提交前冻结提示词、模型、时长、比例及角色对应的原图快照和 hash，刷新、撤销、修改源文字/图片都不会改掉历史输入。明确收到豆包“原图无法读取”的回复时拒绝交付重绘结果，并尝试停止原 run；没有这类回复仍不等于已证明实际采用原图，成片必须人工比对。

画布使用最后一次服务端确认的文档合并互不冲突的编辑和任务回执。两个调用者改不同镜头可合并；同一字段出现真实冲突时保留恢复副本。相同 UUID 的镜头准备请求复用原卡片，专属帧卡原位替换，共享卡不被连带改写。生成阶段只显示实际观察到的阶段。

## 镜头清单与整段工作流

CLI `npm run workflow -- <动作> /完整路径/manifest.json`，MCP `manage_workflow` 使用同一份本地 JSON 清单和持久化状态，不需要拖动画布。

最小清单：

```json
{
  "project": "窗光过渡",
  "ratio": "9:16",
  "images": [
    {"image_id":"a","prompt":"原图","asset_paths":{"generated_image":"./首帧.png"}},
    {"image_id":"b","prompt":"保持人物，只改变光线","provider":"openai-compatible","model":"gpt-image-2.5","required_reference_ids":["a"]}
  ],
  "shots": [
    {"shot_id":"shot-1","prompt":"蓝色窗光平滑过渡为紫色","first_frame_source":"a","last_frame_source":"b","model":"Seedance 2.5","duration":5}
  ]
}
```

已有尾帧可在 b 加 `asset_paths.generated_image`，相对路径以 manifest 所在目录为准。可写 `asset_paths.sha256` 固定素材身份。依赖图按顺序执行，缺参考图的镜头保持 blocked；图生/首尾帧由角色自动推导，显式模式不能忽略图片。

| 动作 | CLI | MCP action | 行为 |
|---|---|---|---|
| 预检 | preflight | preflight | 校验路径、hash、依赖、角色；不生成 |
| 准备 | prepare | prepare | 导入原图，建立 canvas/card 映射；不生成 |
| 执行 | run | run | 需 `--live` / live:true，默认最多 1 个新任务，最大 5 个 |
| 查询 | status | status | 读取原任务与取消回执 |
| 暂停 | cancel | pause | 先保存暂停状态，再尝试取消已知上游任务 |
| 导出 | export | export | 导出核验的云盘 MP4 和剪辑清单 |

```sh
npm run workflow -- preflight /完整路径/manifest.json
npm run workflow -- prepare /完整路径/manifest.json
npm run workflow -- run /完整路径/manifest.json --live --max-new-tasks 1 --timeout-seconds 900
npm run workflow -- status /完整路径/manifest.json
npm run workflow -- cancel /完整路径/manifest.json
# 用户决定恢复后：仍查询原任务，只有预算内的未开始节点可新提交
npm run workflow -- run /完整路径/manifest.json --live --resume --max-new-tasks 1
npm run workflow -- export /完整路径/manifest.json
```

每次状态变更先保存 workflow/shot/canvas/card/request/task 映射。重复 prepare 不增加一套卡片；重复 run 保留原任务；未知同步外部请求不重发。暂停后需要显式 resume。准备完成后修改提示词/依赖须另存新 manifest 文件，原工作流可继续查询。最多 100 张图、100 个镜头，并受单画布 500 卡、1000 连线限制。导出只交付原镜头，字幕、旁白、音乐与正式剪辑仍需下一步制作。

本轮真实验证了 MCP 预检、幂等准备、原任务状态、原片导出和同镜头并发恢复；多节点新生成的预算、依赖执行及取消中断由隔离测试验证，未额外生成一部完整短剧。参见 [本轮验收报告](AGENT-CANVAS-FIXES-2026-10-10.md)。

## 画布方案调研（2026-10-09）

| 方案 | 已有能力 | 对本项目的适合程度 |
|---|---|---|
| [React Flow](https://reactflow.dev/api-reference/components/handle) | 命名输入端口、自定义节点、[连线校验](https://reactflow.dev/examples/interaction/validation) | 最适合后续升级提示词/首帧/尾帧的工作流编辑器。需要迁移到 React；画布库不会自动提供豆包生成。 |
| [tldraw Agent Starter](https://tldraw.dev/starter-kits/agent) | Agent 读取结构化图形与截图，调用经过校验的操作改变画布 | 适合自由白板加对话。可借鉴结构化上下文与高层操作，视频任务仍需自己接入。 |
| [Excalidraw MCP App](https://github.com/excalidraw/excalidraw-mcp) | 通过 MCP 生成和展示图形 | 适合图解/分镜讨论；直接替换不能解决素材上传、帧角色或视频任务恢复。 |

本次先采用共同原则：Agent 操作语义与素材，网页负责呈现与人类编辑。新增高层工具与已有画布共享持久化数据，避免另造一套状态；没有更换画布库。后续若要整体迁移，我建议优先评估 React Flow 的命名端口和校验能力。这是基于本项目工作流作出的判断。
