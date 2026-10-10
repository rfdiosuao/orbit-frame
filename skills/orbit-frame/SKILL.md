---
name: orbit-frame
description: 使用 Orbit Frame 本地项目，通过 CLI 或 MCP 完成外接生图、参考图编辑、文生视频、图生视频、首尾帧视频和画布镜头编排。用于用户要求调用该项目、导入原图、生成或恢复视频、执行镜头清单时；不用于其他视频平台或通用图片编辑。
---

# 轨映 Orbit Frame

将用户的提示词和原图变成可查询、可恢复、可下载的视频任务。优先调用项目的语义工具，不用读屏找图或计算画布连线坐标。Skill 是调用指南和便携入口，运行时仍需完整 Orbit Frame 项目、Node.js 22.13+、启动的本地网关，以及已登录的豆包客户端；本包不包含账号或服务密钥。

## 找到项目与选择入口

1. 先定位包含 `scripts/orbit-frame-mcp.mjs`、`scripts/doubao-video.mjs`、`src/config.js` 的项目目录。可使用当前项目，也可读取 `ORBIT_FRAME_PROJECT_DIR`，或给本 Skill 的 `scripts/orbit.mjs` 传 `--project /完整项目路径`。不要把 Skill 目录当成项目源码目录。
2. MCP 可用时先调用 `check_video_connection({})`；需要图片时调用 `get_image_capabilities({probe:true})`。没有 MCP 时在项目目录运行 `npm run video:desktop -- check`、`npm run image:desktop -- providers`。检查不会提交媒体生成；ready 不代表额度或实际型号已证实。
3. 按任务读取一份参考：

| 用户要做什么 | 读取 |
|---|---|
| 安装、服务启停、外接图片配置、密钥、网页或 HTTP API | [references/operations.md](references/operations.md) |
| CLI 一次生成、首尾帧、编辑原图、异步、恢复与下载 | [references/cli.md](references/cli.md) |
| MCP 调用或注册、图片上传、画布镜头、视频下载 | [references/mcp.md](references/mcp.md) |
| 多张图、多镜头依赖、暂停恢复和剪辑交接 | [references/workflow.md](references/workflow.md) |

人类用户的入口与安装说明在 [使用说明书](使用说明书.md)。模板在 `assets/`；运行前复制模板并替换路径或请求编号。

## 生成与交付约定

- 用户给一张图，使用 `first_frame_path`（CLI `--first-frame`），默认自动推导 `image_to_video`；给首尾两张图，再传 `last_frame_path`（CLI `--last-frame`），使用 `first_last_frame`。只有尾帧不合法。不要把有图片的任务改成文生视频，也不要重绘图片冒充上传成功。
- 路径优先完整本地路径，PNG/JPEG/WebP 原图由 CLI/MCP 读取并正规上传。也可使用 `upload_frame`、`generate_image`、`list_media` 返回的素材 `path`，无需复制到目录或操作文件选择器。
- 外接生图使用 `provider="openai-compatible"`、请求别名 `gpt-image-2.5`。先查实际模型发现和 edit 能力；参考图编辑用 `reference_image_paths` 上传原始字节。`OPENAI_*` 变量需经配置助手保存到项目，不能假定设变量就已接入网关。
- 画布任务用 `compose_video_scene` 一次准备提示词、图片角色和视频卡。记录返回的 `canvas_id/card_id/idempotency_key`，再以 canvas/card 调用 `generate_and_wait`。这一调用不再传提示词、模型或帧覆盖。用户只要求准备时，不提交生成。
- 新任务创建并保存一个 UUID 请求编号。收到任务后保存原 `task_id`；超时、刷新、重启或 unknown 均查询原编号，不换键、换镜头或重新发送。准备响应丢失时使用同一 UUID 和输入恢复准备。
- 5 秒、16:9 是用户未指定时的小样本默认值；用户指定的型号、比例、时长和数量优先。代码接受 Seedance 2.5 的 4–30 秒、其他支持型号的 1–15 秒；这只是参数范围，不能据此承诺账号实际生成能力。请求型号的回执可能只有 `requested_only`。
- 使用后台自动确认与云盘交付。若任务需要尚未支持的进一步输入，报告 `waiting_input/next_action`，保留原任务。停止本地等待不等于上游取消；读取 `cancellation.state/accepted/confirmed`。
- 视频只交付 `cloud_only` 且 `source_verification=matched_upload_path_and_size` 的原片。先确认 completed，再下载或导出；报告原编号、文件、预览、尺寸、实际时长、hash 和来源验证。云盘来源不保证所有未来视频无水印，本 Skill 不做水印移除。
- 外接图片适配器目前不支持上游任务查询或取消。响应不确定时保留 unknown，不把本地幂等键当作上游去重证明。参考图不可读时停止交付，不接受重绘替代。

## 最短 MCP 路径

首尾帧直接传给 `generate_and_wait`：

```json
{
  "prompt": "严格使用两张原图，从首帧自然过渡到尾帧，保持人物与构图",
  "first_frame_path": "/完整路径/首帧.png",
  "last_frame_path": "/完整路径/尾帧.png",
  "model": "Seedance 2.5",
  "duration": 5,
  "ratio": "9:16",
  "idempotency_key": "由本次任务生成并保存的UUID"
}
```

生成图像和视频会调用用户配置的上游服务；按当前用户要求的范围执行。调用说明本身不授权批量压测、充值或发布。
