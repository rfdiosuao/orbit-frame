# Agent instructions — Doubao Relay

本地豆包网页版中转，**无 Docker**，仅限个人自用。

## 启动

```bash
node deployment/mac-deploy.mjs install
node deployment/mac-deploy.mjs bridge
node deployment/mac-deploy.mjs start
```

- 管理页 http://127.0.0.1:8787 →「登录豆包」
- 上游 `vendor/doubao-free-api` 本机 Node `:8000`
- 新 Mac 的完整流程见 `docs/NEW-COMPUTER-MACOS.md`；不要迁移 `.env`、`data/` 或豆包用户资料。`install` 保留已有配置，`doctor` 只读检查且不生成媒体。

勿提交 `data/`、`.env`、`vendor/**/node_modules`。

## Agent 生成视频

- 用户给了图片时优先使用原图。CLI `--first-frame /本地/图片.png` 自动上传并选择图生视频，加 `--last-frame /本地/尾帧.png` 自动选择首尾帧。不要用 computer use 找图、复制文件到素材目录或拖线；不能忽略图片改为文生视频，也不能重新绘图冒充输入帧。
- MCP 使用 `generate_and_wait` 的 `first_frame_path` / `last_frame_path`，或通过 `upload_frame` / `list_media` 取素材。密钥自动读取，不向用户索取或回显。
- 画布用 `compose_video_scene` 一次建立提示词、首帧、尾帧和连线；`get_canvas` 读语义与缺失项；`generate_and_wait` 传 `canvas_id` + `card_id` 生成并挂回原卡片。无需计算坐标或模拟拖动。
- 超时继续原 `task_id`；不要新建镜头或换幂等键重发。使用详情见 `docs/AGENT-WORKFLOW.md`。
