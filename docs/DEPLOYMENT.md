# Orbit Frame 部署与接口入口

另一台 Mac 的完整安装、启动、验收、外接生图、MCP/CLI、后台运行和回滚步骤见：

**[新 Mac 的完整部署流程](NEW-COMPUTER-MACOS.md)**

优先使用最新的完整源码部署包，再依次双击项目根目录的 `Mac-一键安装.command`、`Mac-连接豆包.command`、`Mac-启动.command`、`Mac-检查.command`。安装按 lockfile 固定依赖，不覆盖已有配置。

## 地址与认证

| 服务 | 默认地址 | 用途 |
|---|---|---|
| 网页 | `http://127.0.0.1:8787/` | 视频创作、作品库、连接设置 |
| 画布 | `http://127.0.0.1:8787/canvas.html` | 提示词和首尾帧镜头编排 |
| 外接生图设置 | `http://127.0.0.1:8787/image-provider.html` | 保存该图片服务自己的地址与密钥 |
| API | `http://127.0.0.1:8787/v1` | Bearer 鉴权 |
| 本机传统上游 | `http://127.0.0.1:8000` | 网页聊天/图像桥接 |
| 豆包客户端调试 | `http://127.0.0.1:9225` | Doubao.app 桌面桥接 |

`LOCAL_API_KEY` 由网关自动生成，保存在本机 `.env`。网页自动连接，CLI/MCP 自动读取；自己的 HTTP 程序在请求头传 `Authorization: Bearer LOCAL_API_KEY`，不要放到 URL。可在连接设置复制密钥。它不是豆包 Cookie 或外接图片服务密钥。

另一台电脑的 `127.0.0.1` 指向另一台电脑自己。当前完整链路只在 Mac 客户端环境验收，服务限制本机访问；公网服务器入口需要另外设计认证和执行机连接。

## 视频 HTTP API

| 方法与路径 | 用途 |
|---|---|
| `GET /health` | 网关存活，不能替代登录/生成检查 |
| `GET /v1/videos/readiness?refresh=1` | 桌面连接只读检查 |
| `POST /v1/videos/frames` | 上传 PNG/JPEG/WebP 原始字节 |
| `POST /v1/videos/generations` | 异步提交，返回原 task_id |
| `GET /v1/videos/tasks/:id?wait_seconds=30` | 等待本地状态变化；异常时用 refresh=1 恢复 |
| `GET /v1/videos/tasks/:id/events` | SSE 状态流，Bearer 放请求头 |
| `POST /v1/videos/tasks/:id/cancel` | 查询实际取消回执 |
| `GET /v1/videos/files/:id/source` | 云盘原片来源检查 |
| `GET /v1/videos/files/:id` | MP4 下载，支持 Range |

提交 JSON 示例（示例不含真实密钥）：

```json
{
  "provider":"doubao-desktop",
  "model":"Seedance 2.5",
  "prompt":"清晨海边的小狐狸，低机位跟拍",
  "duration":5,
  "ratio":"9:16",
  "idempotency_key":"为本次生成创建并保存的UUID",
  "async":true
}
```

首尾帧需先正规上传两张原图，再添加 `mode=first_last_frame`、`first_frame={"path":"uploads/真实首帧文件.png"}`、`last_frame={"path":"uploads/真实尾帧文件.png"}`。本地绝对路径由 CLI/MCP 读取并上传，HTTP API 不接受任意本机路径读取。

Seedance 2.5 参数范围 4–30 秒，Fast 1–15 秒；实际权限、型号和时长以生成结果核验。只有 completed、来源验证通过、可读 MP4 才算成片。超时、unknown、等待输入均继续原 task_id，不换幂等键重发。

完整用法：[Agent 工作流](AGENT-WORKFLOW.md)、[CLI 说明](../skills/orbit-frame/references/cli.md)、[MCP 说明](../skills/orbit-frame/references/mcp.md)。
