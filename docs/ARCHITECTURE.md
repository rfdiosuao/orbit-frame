# 架构与验证结果

```text
页面 / CLI / HTTP 客户端
    → 127.0.0.1:8787 本地网关（Bearer 认证）
    → enterprise-video-jobs 持久化任务与幂等键
    → enterprise-video-client / doubao-cli 0.13.0
    → Doubao.app 本机 CDP / 已登录账户
    → 客户端生成结果 → 下载与 MP4 校验
    → 本机文件 API → 页面 Blob 预览或 CLI 下载
```

`public/` 是无框架的 HTML/CSS/ESM 界面。`src/gateway.js` 提供接口；`src/enterprise-video-jobs.js` 保存任务、串行锁和恢复状态；`src/enterprise-video-client.js` 读取当前 run，识别视频卡片或上传 MP4，只允许有限的视频参数确认，下载并检查 MP4。`scripts/doubao-video.mjs` 是访问本地网关的 CLI。

网关以当前请求 run 为提取范围，媒体下载限制来源、体积和超时，检查 ftyp、mdat、moov、视频轨及尺寸/时长。任务持久化在 `data/enterprise-video-jobs`；成片在 `data/videos`；两者不入库。完成条件是取得有效媒体；不会将普通文本或未完成卡片当成视频。

## 已实际验证（2026-10-05）

- macOS / Node 24.19 / Doubao.app 2.31.4 企业账户。
- 页面提交小狐狸视频，6 秒 / 9:16；自动处理参数确认后取得真实 MP4。
- 视频 720×1280，视频轨 6.041667 秒，容器 6.08 秒，922623 字节；完整 FFmpeg 解码通过。
- HTTP 文件下载 200；浏览器 video readyState=4，Blob 预览元数据一致。
- 页面刷新恢复、服务重启续跑、相同幂等键复用；浏览旧作品后不会绕过活跃任务保护。
- 401 拒绝无密钥任务/文件访问；作品列表只暴露有限元数据。
- 桌面双栏、手机单栏、天空/深空、减少动态效果。
- 确认/提取/响应回归 5 项及作品库安全测试 1 项通过。

## 尚未验证

独立 DoubaoWork.app、其他客户端版本、Windows/Linux 桌面视频桥接、实际执行模型 ID、内嵌浏览器下载按钮落盘及旧版文档中的扩展供应商功能。生成能力取决于用户账户、客户端登录、模型权限和平台当时状态。
