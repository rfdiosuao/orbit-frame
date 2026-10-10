# MCP 调用说明

## 接入本地 stdio MCP

服务器为完整项目的 `scripts/orbit-frame-mcp.mjs`；Skill 的助手可以固定项目路径并透传 stdio。它自动读取本机网关密钥，不要在 MCP 配置的 env、提示词或 JSON 参数中加入密钥。

```sh
node /Skill目录/scripts/orbit.mjs --project /完整项目路径 mcp-config
```

这会输出实际 Node 路径和助手路径的 MCP JSON 配置；合并到客户端配置，勿覆盖已有其他 MCP 服务器。也可使用 `assets/mcp.config.example.json`，替换绝对路径。

MCP 客户端若使用 TOML 或自己的设置页，填相同的 command/args。服务器是 stdio，不能把 `http://127.0.0.1:8787` 当作 MCP URL。修改配置后重连，读取 tools/list，应发现 13 个工具；名称可能带客户端添加的前缀。只使用当前发现的工具。

在完整项目目录使用 `npm run mcp` 也可启动，但客户端推荐直接运行 Node，避免 npm 在 stdout 输出额外文本。相对本地文件以 MCP 工作目录为准，建议始终传完整路径。

## 全部工具

| 工具 | 核心输入 | 作用 |
|---|---|---|
| check_video_connection | `{}` | 检查网关、客户端、登录与参数能力；不生成 |
| get_image_capabilities | `probe:true` | 图片提供商、实际别名发现和编辑/查询/取消能力 |
| upload_frame | `path` | 上传本机原图；返回可复用素材与 SHA256 |
| list_media | `directory:generated或uploads`，`limit:1..100` | 查已有图片 |
| generate_image | `prompt/provider/model/ratio/reference_image_paths` 或 `task_id` | 生成、真实参考图编辑或原图片任务恢复 |
| get_image_status | `task_id/wait_seconds/refresh` | 读本地状态或恢复原客户端任务 |
| get_canvas | 可选 `canvas_id` | 列画布或读镜头语义和缺失项 |
| compose_video_scene | `prompt`，可选图片路径、canvas/card、模型、时长、比例、UUID | 上传、准备角色卡和连线；不生成 |
| generate_and_wait | prompt+帧、canvas+card、或原 task_id 三选一 | 生成视频并等云盘交付或恢复原任务 |
| get_video_status | `task_id/wait_seconds/refresh` | 查询原视频；wait_seconds 为 0–60 |
| download_video | `task_id`，可选纯 `filename` | 导出已经核验的云盘 MP4 |
| cancel_task | `kind:image或video`，`task_id` | 取消原任务；回读实际回执 |
| manage_workflow | `manifest_path/action` | 清单预检、准备、执行、暂停、状态与原片导出 |

示例的提示词、图片路径和 UUID 都是可替换输入。新增请求先生成并保存真实 UUID；不能照抄中文占位编号。

## 视频直接调用

文生视频：工具 `generate_and_wait`，无图片字段。

```json
{"prompt":"云海浮空岛，镜头缓慢推进","model":"Seedance 2.0 Fast","duration":5,"ratio":"16:9","wait":true,"timeout_seconds":900}
```

图生视频：

```json
{"prompt":"严格使用原图，保持人物与构图，衣摆轻轻飘动","first_frame_path":"/完整路径/首帧.png","model":"Seedance 2.5","duration":5,"ratio":"9:16","wait":true}
```

首尾帧：

```json
{"prompt":"严格使用两张原图，从首帧自然过渡到尾帧，保持人物服装与构图","first_frame_path":"/完整路径/首帧.png","last_frame_path":"/完整路径/尾帧.png","model":"Seedance 2.5","duration":5,"ratio":"9:16","mode":"first_last_frame","wait":true,"timeout_seconds":900}
```

`mode` 默认 auto：0/1/2 张图分别推导文生、图生、首尾帧。也可传 `first_frame:{path:"uploads/xxx.png"}` 与 `last_frame`；一个角色不同时传快捷 path 和 descriptor。只有尾帧或显式模式不符合图片数量时会拒绝，不降级重绘。

`wait:false` 可快速返回 task_id，随后 `get_video_status`。任务完成后使用 `download_video`；所有情况先保存原编号和下一步指令。

## 外接图片生成与编辑

先调用 `get_image_capabilities({probe:true})`；确认 openai-compatible 已配置、connected，以及 `gpt-image-2.5` 出现在真实模型发现中。

工具 `generate_image`：

```json
{"prompt":"原创山海经白鹿，云海日出，电影分镜，竖屏","provider":"openai-compatible","model":"gpt-image-2.5","ratio":"9:16","timeout_seconds":900}
```

编辑真实首帧生成尾帧：

```json
{"prompt":"保留人物和构图，只改变窗外光线为紫色星夜","provider":"openai-compatible","model":"gpt-image-2.5","ratio":"9:16","reference_image_paths":["/完整路径/首帧.png"],"timeout_seconds":900}
```

已上传图可改用 `reference_images:[{"path":"uploads/xxx.png"}]`，不要与 reference_image_paths 混用。最多 8 张；图片都先验证再提交。拿到 images[0].file 或素材 path 以后，直接传入视频工具，不必用 computer use 找图片。

## 画布首尾帧镜头

工具 `compose_video_scene`：

```json
{"title":"窗光过渡","prompt":"严格使用原图，从蓝光平滑过渡为尾帧紫光","first_frame_path":"/完整路径/首帧.png","last_frame_path":"/完整路径/尾帧.png","model":"Seedance 2.5","duration":5,"ratio":"9:16"}
```

先保存返回的 canvas_id、card_id、准备 UUID，再用 `get_canvas({canvas_id:"返回编号"})` 检查提示词来源、帧角色、hash、缺失项和冻结状态。下一次调用 `generate_and_wait` 只传镜头编号：

```json
{"canvas_id":"返回的canvas_id","card_id":"返回的card_id","wait":true,"timeout_seconds":900}
```

不会再指定模型、提示词或图片覆盖；修改未提交镜头用 compose_video_scene 加 canvas_id 和 card_id。重复准备使用原准备 UUID，避免丢响应后多出一套卡片。已提交镜头保持历史快照，新一轮生成应明确创建新镜头。

## 查询、恢复、下载、取消

```json
{"task_id":"原视频task_id","wait_seconds":30}
```

给 `get_video_status`；暂停、提取失败需要主动恢复时加 refresh:true。继续等待用 `generate_and_wait({task_id:"原视频task_id"})`，不再传 prompt/frames/canvas。

`download_video`：

```json
{"task_id":"已完成原视频task_id","filename":"shot-01.mp4"}
```

filename 只能是文件名，不能带目录、`..` 或绝对路径。默认写入项目 `data/exports`；启动服务器时设置 `ORBIT_FRAME_OUTPUT_DIR` 可改变导出目录。下载回执返回 file、字节数、task_id 和 video_id；尺寸、实际时长、hash、预览与来源验证读取原任务结果，并在下载后核对实际文件。不接受普通视频卡替代云盘原片。

图片恢复用 `generate_image({task_id:"原图片UUID"})` 或 get_image_status。取消用 `cancel_task({kind:"video",task_id:"原编号"})`，图片 kind 为 image。requested/accepted 不能当作停止；只有明确上游确认才报告取消成功。外接同步服务返回 unsupported 或 unknown 时停止自动重发。

超时不自动更换编号。若收到 reference_unreadable，向用户说明原图访问失败并保留原任务，不接受重绘视频作为图生成功。完整工作流见 [workflow.md](workflow.md)。
