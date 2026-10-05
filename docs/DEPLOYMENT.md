# 从零部署与使用教程

## 1. 准备环境

企业客户端视频桥接目前只在 macOS 上实际验证。需要 Node.js ≥22.13（本次验收使用 24.19）、npm、Git，以及可正常生成视频的豆包客户端账户。已验证客户端为 Doubao.app 2.31.4，客户端内「豆包工作」企业账户。

当前桥接显式选择 `doubao` 应用，即 `/Applications/Doubao.app`、默认 CDP 9225；独立 DoubaoWork.app 的 9226 路径尚未在本网关验收。不要仅凭账户登录成功就认定视频权限可用。

## 2. 下载与安装

```bash
git clone https://github.com/rfdiosuao/orbit-frame.git
cd orbit-frame
cp .env.example .env
npm install --registry=https://registry.npmmirror.com
npm run setup:upstream
npx playwright install chromium
```

安装会包含 `doubao-cli@0.13.0` 与 HEANG。`setup:upstream` 在 `vendor/doubao-free-api` 安装依赖并构建；无 Docker。

生成一个本地访问密钥：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

将结果填入本机 `.env` 的 `LOCAL_API_KEY`，不要保留示例值。其他基础配置：

```dotenv
PORT=8787
LOCAL_API_KEY=replace-with-your-random-key
UPSTREAM_URL=http://127.0.0.1:8000
BROWSER_PROFILE_DIR=data/browser-profile
LOG_DIR=data/logs
```

`.env` 和 `data/` 均被 Git 忽略；不要上传。修改配置后需重启服务。

## 3. 登录客户端并开启桥接

先在 Doubao.app 登录你自己的账户，手动发送消息及生成视频，确认不会退出登录且账户具备视频权限。

```bash
npx doubao --app doubao cdp launch
npx doubao --app doubao status --json
```

`cdp launch` 可能要求重启客户端；保存客户端中未完成的工作，再按照 CLI 提示操作。它开启本机调试连接，应用窗口需保持打开。该接口仅用于本机自动化，不要对公网暴露。网页登录使用的 `DOUBAO_CDP_URL` 与桌面 CLI 的 `DOUBAO_CDP_ENDPOINT` 是不同配置，通常桌面保持默认 9225 即可。

## 4. 启动网关

```bash
npm start
```

一个进程启动 `:8000` 上游与 `:8787` 网关。保持终端运行，访问 http://127.0.0.1:8787/ 。如端口被占用，先检查已有进程，避免重复启动。

`./scripts/service.sh` 只管理已安装的 macOS LaunchAgent；克隆仓库后并不会自动创建 LaunchAgent，新用户先用 `npm start`。

## 5. 在页面生成视频

1. 「连接设置」输入 `.env` 中的 `LOCAL_API_KEY`，点击「应用连接」。默认仅在当前页面使用；勾选「记住这台设备」才持久保存。
2. 「视频创作」填写场景、动作、镜头、氛围。
3. 视频时长填写 1–15 的整数秒；画面比例选横屏、竖屏或方形。格式统一为 MP4。
4. 点击生成。默认请求 Seedance 2.0 Fast，实际模型 ID 未独立核验。
5. 等待真实任务状态更新；完成后预览。完整显示竖屏与方形画幅。
6. 刷新后继续原任务；未记住密钥时重新连接即可恢复。作品库保存本机真实任务记录。

只自动回答有限白名单中的视频参数确认。其他输入需要去客户端处理，再在页面「查看任务信息」中重新查询。没有视频文件、任务失败或等待输入都不会显示为成片。

## 6. CLI 生成与自动提取

```bash
npm run video:desktop -- submit "清晨的海边，小狐狸在沙滩奔跑，低机位跟拍" --duration 6 --ratio 9:16 --key fox-video-001 --async
npm run video:desktop -- status <task-id> --wait-seconds 45
npm run video:desktop -- download <video-id> ./fox.mp4
```

用实际返回值替换 `<task-id>` 和 `<video-id>`。`--async` 返回任务后即可退出；后续查询推动恢复、参数确认和提取。未加 `--async` 会等待一段时间，但超时不等于失败，继续查询原任务。CLI 输出 JSON，可由其他程序解析。下载不覆盖已存在文件。

退出码：0 表示请求成功（异步提交可能仍 running）；1 表示失败、取消或未取得视频；2 表示需要输入、未知状态或提取未完成。必须检查 JSON 的 `status` 和 `videos`，不能以退出码 0 当成成片。

知道客户端会话和运行 ID 时，可恢复：

```bash
npm run video:desktop -- recover <conversation-id> <run-id>
```

## 7. HTTP API

统一使用 `Authorization: Bearer YOUR_LOCAL_API_KEY`。生成请求：

```http
POST /v1/videos/generations
Content-Type: application/json
Authorization: Bearer YOUR_LOCAL_API_KEY

{"provider":"doubao-desktop","model":"Seedance 2.0 Fast","prompt":"海边的小狐狸","duration":6,"ratio":"9:16","idempotency_key":"fox-video-001","async":true}
```

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 本地服务存活；不代表账户登录或视频权限 |
| `GET /v1/videos/tasks` | 受保护的真实任务列表 |
| `GET /v1/videos/tasks/:id?wait_seconds=45` | 查询、续跑原任务，等待最长 60 秒 |
| `GET /v1/videos/files/:id` | 下载 MP4，支持 Range |
| `POST /v1/videos/recover` | 按 `conversation_id` / `run_id` 恢复 |

首次提交通常为 202；完成并有有效 MP4 后为 completed。不要因 202、文本“已提交”、视频卡片出现或 HTTP 200 就认定成片。任务、文件接口都需要 Bearer，不能把密钥放进 URL。

## 8. 常见问题

- **401**：核对 `.env` 和页面密钥；改 `.env` 后重启。
- **客户端未登录 / 发消息退出**：先手动确认客户端认证恢复，网关无法修复过期的账户登录。
- **waiting_input**：客户端中处理其他确认，再查询原任务；无需重新生成。
- **unknown**：原任务结果尚未确认，继续同一 ID 或恢复原 run；避免换幂等键重复发送。
- **extraction_failed / video_missing**：任务结束但未取得有效 MP4，查看客户端原会话并重新查询。
- **页面刷新**：原任务 ID 和幂等键保留；没勾记住密钥需再连接。
- **内嵌浏览器下载无反应**：使用普通浏览器，或上述 CLI 下载命令。内嵌浏览器下载落盘尚未独立验收。
- **图像生成**：采用旧网页上游登录，企业客户端视频登录不等于网页图像登录；通过「连接设置 → 打开高级管理」完成相应网页登录。

## 9. 验证

```bash
node --check public/app.js
node --test tests/enterprise-video-confirmation.mjs tests/enterprise-video-extraction.mjs tests/video-response-regression.mjs tests/video-library-safety.mjs
```

作品库安全测试会在临时端口启动测试网关，并读取本机任务元数据；不会生成视频。自动测试不能替代你的账户下实际生成、预览和下载验收。
