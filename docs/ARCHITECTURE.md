# 架构与验证结果

```text
页面 / CLI / HTTP 客户端 / stdio MCP
    → 127.0.0.1:8787 本地网关（Bearer 认证）
    → enterprise-video-jobs 持久化任务、幂等键与后台监控
    → enterprise-video-client / doubao-cli 0.13.0
    → Doubao.app 本机 CDP / 已登录账户
    → 客户端生成结果 → 下载与 MP4 校验
    → 本机文件 API → 页面 Blob 预览或 CLI 下载
```

`public/` 是无框架的 HTML/CSS/ESM 界面。`src/gateway.js` 提供接口；`src/enterprise-video-jobs.js` 保存任务、幂等键与恢复状态，并由后台监控负责确认和提取；`src/enterprise-video-client.js` 使用共享 CDP 连接串行执行客户端操作，读取当前 run，识别视频卡片、上传 MP4 或助手文本中的豆包短链，只允许有限的视频参数确认，下载并检查 MP4。`scripts/doubao-video.mjs` 是访问本地网关的 CLI；`scripts/orbit-frame-mcp.mjs` 为 Agent 提供同一网关的三个工具。

状态读取只访问本地任务 JSON；长轮询和 SSE 等待本地事件，不重复调用客户端。只有显式 `refresh=1` 才对暂停任务强制重查。监控程序根据等待时间调整查询间隔，网关重启后重新接管运行中的任务。

`src/video-frames.js` 限定图片位于媒体目录内，按内容、文件大小和尺寸校验，记录首尾帧角色与 SHA-256。任务保存校验后的附件副本，防止源图片在提交后变化。`image_to_video` 和 `first_last_frame` 共用既有任务流程。

网关以当前请求 run 为提取范围，媒体下载限制来源、体积和超时，检查 ftyp、mdat、moov、视频轨及尺寸/时长。任务持久化在 `data/enterprise-video-jobs`；成片在 `data/videos`；两者不入库。完成条件是取得有效媒体；不会将普通文本或未完成卡片当成视频。

## 已实际验证（2026-10-05）

- macOS / Node 24.19 / Doubao.app 2.31.4 企业账户。
- 页面提交小狐狸视频，6 秒 / 9:16；自动处理参数确认后取得真实 MP4。
- 视频 720×1280，视频轨 6.041667 秒，容器 6.08 秒，922623 字节；完整 FFmpeg 解码通过。
- HTTP 文件下载 200；浏览器 video readyState=4，Blob 预览元数据一致。
- 页面刷新恢复、服务重启续跑、相同幂等键复用；浏览旧作品后不会绕过活跃任务保护。
- 401 拒绝无密钥任务/文件访问；作品列表只暴露有限元数据。
- 桌面双栏、手机单栏、天空/深空、减少动态效果。
- 首尾帧探测生成 1280×720、约 5 秒 MP4，文本短链提取和完整解码通过。
- 2026-10-06 运行 `npm test`：20 项通过，0 项失败，覆盖确认、视频提取、帧校验、CLI、认证和本地状态/SSE。

## 尚未验证

图生视频与首尾帧经网关完整提交的实际链路、独立 DoubaoWork.app、其他客户端版本、Windows/Linux 桌面视频桥接、实际执行模型 ID、内嵌浏览器下载按钮落盘及旧版文档中的扩展供应商功能。生成能力取决于用户账户、客户端登录、模型权限和平台当时状态。
