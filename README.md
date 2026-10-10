# 轨映 · Orbit Frame 本地媒体网关

**在另一台 Mac 部署**：使用完整源码包，按 [新 Mac 部署流程](docs/NEW-COMPUTER-MACOS.md) 操作。包内提供双击安装、连接豆包、启动、检查、MCP 配置和可选后台运行入口。新电脑自动生成自己的网关密钥；豆包账号与外接生图服务需在新电脑配置。

2026-10-10：CLI/MCP 已统一支持本地原图上传、首尾帧、参考图编辑、任务取消回执和按镜头清单组织画布。外部生图服务在首页或画布的「生图服务」页面配置，凭据只保存在本机。使用说明见 [Agent 工作流](docs/AGENT-WORKFLOW.md)，修复与真实验收见 [10 月 10 日报告](docs/AGENT-CANVAS-FIXES-2026-10-10.md)。

本轮通过 117 项自动检查，并实际完成 1 次原图编辑、1 条单图视频、1 条首尾帧视频；两条视频均为 5 秒、9:16、请求 Seedance 2.5，提取的是核验通过的云盘原片。模型仍标为 `requested_only`。外部同步生图超时后没有可查询编号时，保留原请求为未知，不会自动重发。

完整调用 Skill 位于 [skills/orbit-frame](skills/orbit-frame/SKILL.md)，附 [使用说明书](skills/orbit-frame/使用说明书.md)、CLI/MCP 参数、首尾帧模板、外接 `gpt-image-2.5` 配置助手与多镜头清单。Skill 包不包含源码运行环境或实际密钥，可安装到 Agent 的 Skill 目录并指定本机项目路径。

> 本地工作副本（2026-10-05）：首页 `http://127.0.0.1:8787/` 已改为「轨映 / Orbit Frame」视频创作界面。原有账号池、Cookie、文生图和日志入口保留在 `/legacy.html`。以下旧版仓库功能描述包含本地工作副本尚未实现的模块；以 [部署流程](docs/DEPLOYMENT.md) 和实际接口为准。

## 轨映首页（本地工作副本）

1. 打开 `http://127.0.0.1:8787/`，页面会自动从本机网关连接，无需填写 `LOCAL_API_KEY`。到「连接设置」可查看自动连接状态并复制 Key 给外部程序调用；密钥不会保存到页面本地存储。
2. 回到「视频创作」，写提示词并选择模型；Fast 参数范围为 **1–15 秒**，Seedance 2.5 为 **4–30 秒**。画面比例为横屏 16:9、竖屏 9:16、方形 1:1，另可选 4:3、3:4；输出文件为 MP4。界面所示模型名是请求值，尚未对服务端实际模型 ID 做独立核验；参数范围也不等于全部组合均已实测。
3. 提交后可在预览区看真实任务状态。遇到明确的「按要求生成」确认时，网关会自动选择并继续，完成后直接加载 MP4 预览；付费或其他不明确输入仍需人工处理。页面刷新时，会用原 `task_id` 恢复查询；提交结果未确认时，保持相同提示词和设置重试会复用已保存的幂等键，避免创建第二个视频。只有任务完成且 MP4 文件可读取时才出现预览和下载。
4. 「作品库」读取本机任务记录；「图像」保留常用文生图操作；「连接设置 → 打开高级管理」进入旧管理页，继续使用账号池、登录、手动 Cookie 和实时日志。

界面采用 `heang-design@0.1.0` 的天空/深空设计变量、鼠标交互和 Logo 开屏动画；相关静态资源与 MIT 许可证保存在 `public/heang/`，应用 Logo 为 `public/orbit-frame.svg`。实现和资源更新说明见 [轨映文档](docs/ORBIT-FRAME.md)。

> 无 Docker，个人自用。把豆包 / 即梦 / 可灵网页额度、本机 **Cursor** 编剧、火山方舟等，统一为 **`http://127.0.0.1:8787/v1`** 的 OpenAI 兼容 API。  
> **GitHub**：[rfdiosuao/orbit-frame](https://github.com/rfdiosuao/orbit-frame)（仓库名；管理页与 npm 包名仍为 **doubao-relay**）

**能做什么**

- 深色 **管理页**：账号池、本机试生成、成片记录、实时日志、ToonFlow 插件中心  
- **ToonFlow**：同时挂「豆包 / 即梦本地中转」生图生视频 +「Cursor 编剧」用 Composer / Claude / GPT / Gemini / Kimi 等写剧本  
- **脚本 / 任意客户端**：同一套 Bearer `LOCAL_API_KEY` 调 `/v1/*`

![网关控制台：账号与登录](docs/console-account.png)

---

## 目录

- [背景与架构](#背景与架构)
- [功能一览](#功能一览)
- [快速开始](#快速开始)
- [网关控制台](#网关控制台)
- [ToonFlow 与 Cursor](#toonflow-与-cursor)
- [HTTP API](#http-api)
- [常用命令](#常用命令)
- [环境变量](#环境变量)
- [旧版文档与免责](#旧版文档与免责)

---

## 背景与架构

官方火山方舟要 Key、要计费；各平台网页版又难接工作流。本项目在本机起一个网关：用你的登录态调网页能力（或内嵌即梦 SDK），再以标准 HTTP 交给 ToonFlow、脚本或其它客户端。

```text
ToonFlow / 脚本 / 任意 OpenAI 客户端
        │  Authorization: Bearer LOCAL_API_KEY
        ▼
  :8787  doubao-relay（管理页 + /v1 API）
        ├─ 生图 / 生视频：doubao · jimeng · jimeng-api · kling · …
        ├─ 编剧 / 大模型：cursor-relay → Cursor API（订阅额度）
        └─ 豆包对话：内部 :8000 doubao-free-api（npm start 一并拉起）
```

---

## 功能一览

| 分类 | 能力 | 说明 |
|------|------|------|
| 控制台 | 网关控制台 | 顶栏「网关控制台 / ToonFlow 插件」；侧栏：账号、试生成、记录、日志、设置 |
| 控制台 | 多方案账号池 | 豆包 / 即梦 / 可灵分方案登录；切换、清冷却、删号 |
| 控制台 | 本机试生成 | 文生图 / 文生视频，与 ToonFlow 同接口；`@图N` 参考图 |
| 控制台 | 生成记录 · 实时日志 | 成片时间线；按天日志 + 页面跟随 / 暂停 |
| 集成 | ToonFlow 插件 | `toonflow/*.ts` 列表、复制路径、按插件看调用日志 |
| 集成 | Cursor 编剧 | `cursor-relay.ts`：文本走本机网关 → Cursor |
| API | OpenAI 兼容 | `/v1/images/generations`、`/v1/videos/generations`、`/v1/chat/completions` |
| 能力 | 即梦内嵌 | 进程内 SDK，**无需 :5100**；管理页登录，ToonFlow 不用 SessionID |
| 能力 | CDP 抗风控 | Chrome/Edge 远程调试，降低豆包 `shark` / `710022004` |

---

## 快速开始

**环境**：Node.js **≥ 22.13**（见 `package.json` → `engines`）。

### 安装与启动

```powershell
cd doubao
copy .env.example .env
npm run setup
npm start
```

### 管理页里要做的事

打开 **http://127.0.0.1:8787**：

| 步骤 | 操作 |
|------|------|
| 1 | **账号与登录**：选豆包 / 即梦 / 可灵 → **登录当前方案**（或 **换账号登录** 进账号池） |
| 2 | **ToonFlow 插件**：复制 `toonflow/*.ts` → ToonFlow **设置 → 模型服务 → 添加供应商**；密钥 `LOCAL_API_KEY`，地址 `http://127.0.0.1:8787/v1` |
| 3 | **Cursor（可选）**：[Integrations](https://cursor.com/dashboard/integrations) 创建密钥 → 写入 `.env` 的 `CURSOR_API_KEY` → 重启服务 → ToonFlow 启用「Cursor 编剧」（见 [ToonFlow 与 Cursor](#toonflow-与-cursor)） |
| 4 | **豆包视频风控（可选）** | **高级设置** 开 CDP，或 `npm run start:cdp` |

### 端点

| URL | 用途 |
|-----|------|
| http://127.0.0.1:8787 | 管理页 |
| http://127.0.0.1:8787/v1 | 对外 API |
| http://127.0.0.1:8000 | 豆包对话上游（本机内部） |

### 命令行登录（可选）

```bash
npm run login
npm run login:switch   # 换账号，写入账号池
```

---

## 网关控制台

顶栏进入 **「网关控制台」**，左侧五个子页如下。

### 账号与登录

![多方案额度与账号池](docs/console-providers.png)

- **方案卡片**：豆包、即梦、可灵等；点选后操作当前方案  
- **登录当前方案 / 换账号登录**：扫码或 CDP 窗口；会话在 `data/`（**勿用 sessionid 当 API Bearer**）  
- **账号池**：切换、单号清冷却、删除、清空全部  
- 接口：`GET /admin/providers`

### 本机试生成

![文生图 / 文生视频](docs/console-studio.png)

- 与 ToonFlow **同一 HTTP 接口**；显示预计消耗  
- 页签：文生图 / 文生视频；`@图1`… 对应参考图（最多 6 张）  
- 可选模型、比例；可展开 **原始 JSON**

### 生成记录

![成片与 API 调用](docs/console-activity.png)

- **实时同步** / **清空**（清空仅前端；日志文件仍按天保留）  
- 含提示词、模型、缩略图、**下载**

### 实时日志

![网关运行输出](docs/console-logs.png)

- 路径示例：`data/logs/relay-YYYY-MM-DD.log`  
- **跟随 / 暂停 / 清空**

### 高级设置

![密钥 · Cookie · CDP](docs/console-settings.png)

| 项 | 说明 |
|----|------|
| `LOCAL_API_KEY` | 客户端 Bearer；多数场景只配此项 |
| 网关地址 | `http://127.0.0.1:8787/v1` |
| Cookie 粘贴 | 备用；优先页面登录 |
| CDP | **启动 CDP 浏览器** 或 `npm run start:cdp` |

```env
DOUBAO_USE_CDP=1
DOUBAO_CDP_URL=http://127.0.0.1:9222
```

---

## ToonFlow 与 Cursor

### 插件列表（管理页 → ToonFlow 插件）

| 文件 | 用途 |
|------|------|
| [`cursor-relay.ts`](toonflow/cursor-relay.ts) | 文本 · Cursor 订阅 |
| [`jimeng-relay.ts`](toonflow/jimeng-relay.ts) | 即梦生图 / 生视频（内嵌 API） |
| [`doubaorelay.ts`](toonflow/doubaorelay.ts) | 豆包对话 + 多方案媒体，可配 provider |
| [`kling-relay.ts`](toonflow/kling-relay.ts) | 可灵网页 |
| [`volcengine-relay.ts`](toonflow/volcengine-relay.ts) | 火山方舟 Ark |
| [`metaso-minimax-h3.ts`](toonflow/metaso-minimax-h3.ts) | 秘塔 MiniMax-H3 |
| [`tencent-tokenhub-image.ts`](toonflow/tencent-tokenhub-image.ts) | 腾讯 TokenHub 混元 |

![Cursor 编剧插件](docs/plugins-cursor.png)

![豆包全功能与调用日志](docs/plugins-doubaorelay.png)

![即梦 API 插件](docs/plugins-jimeng.png)

插件细节见 [`toonflow/README.md`](toonflow/README.md)。

### 通用导入（媒体 + 对话）

1. `npm start`，管理页为对应平台 **登录**  
2. ToonFlow → 导入 `toonflow/*.ts`（可 **检查更新**）  
3. **API 密钥** = `LOCAL_API_KEY`；**地址** = `http://127.0.0.1:8787/v1`  
4. `doubaorelay.ts` 可指定生图/视频方案（`doubao`、`jimeng-api`、`kling`…），留空用 `.env` 默认  

### ToonFlow 模型服务（多供应商并行）

**设置 → 模型服务** 可同时启用：媒体走 **豆包 / 即梦本地中转**，文本走 **Cursor 编剧**（均指本机 `8787`，不填网页 SessionID）。

![模型服务总览](docs/toonflow-model-services-overview.png)

| 供应商 | 典型模型 |
|--------|----------|
| 豆包 / 即梦本地中转 | Seedream、Seedance、即梦 4.0 等（需网关管理页登录） |
| Cursor 编剧 | 仅文本：Composer 2.5、Claude、GPT、Gemini、Kimi 等 |

![豆包与即梦供应商](docs/toonflow-providers-doubao-jimeng.png)

![Cursor 文本模型](docs/toonflow-cursor-models.png)

### 接入本地 Cursor（`cursor-relay.ts`）

网关将 ToonFlow 文本请求转到 **Cursor Cloud Agents API**（消耗订阅额度）。**生图/生视频仍用** `jimeng-relay.ts` 或 `doubaorelay.ts`。

**1. 网关 `.env`**（完整项见 [`.env.example`](.env.example)）

```env
CURSOR_API_KEY=cursor_...
CURSOR_RUNTIME=cloud
```

- `cloud`：纯文本编剧（推荐）  
- `local`：可设 `CURSOR_CWD` 让 Agent 读写本地项目  

**2. ToonFlow 供应商**

- 导入 `toonflow/cursor-relay.ts`  
- 填 **`LOCAL_API_KEY`** + **`http://127.0.0.1:8787/v1`**（Cursor 密钥只写在网关 `.env`）  
- 编剧任务选 **Cursor 编剧** 下模型  

**3. 查可用模型**

```http
GET http://127.0.0.1:8787/admin/cursor/models
```

---

## HTTP API

统一鉴权：

```http
Authorization: Bearer <LOCAL_API_KEY>
```

### 文生图

```bash
curl http://127.0.0.1:8787/v1/images/generations ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"Seedream 5.0 Lite\",\"prompt\":\"一只戴墨镜的橘猫，赛博朋克霓虹\",\"ratio\":\"16:9\"}"
```

多参考图：`images` + 提示词 `@图1`、`@图2`（网关映射占位并注入角色锁定）。

### 文生视频

```bash
curl http://127.0.0.1:8787/v1/videos/generations ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"Seedance 2.5\",\"prompt\":\"橘猫走过霓虹街道\",\"duration\":5,\"ratio\":\"16:9\"}"
```

同步等待，最长约数分钟。别名：`/v1/videos`、`/v1/video/generations`。

本机 **Doubao.app 工作资料档案**的 Seedance 视频链路使用显式 `provider: "doubao-desktop"`。它需要 Doubao.app 已登录并开放本机 CDP `127.0.0.1:9225`，且网关通过 `LOCAL_API_KEY` 保护。网关从指定会话和 run 的服务端消息提取 MP4，验证文件后存入私有 `data/videos/`。返回的 `model_verification: "requested_only"` 表示模型来自请求参数；视频块本身没有独立证实实际模型。

推荐用本网关提供的 `video:desktop` CLI（内部使用固定版本 `doubao-cli` 适配 Doubao.app；并非原版 `doubao-cli` 自带视频命令）。密钥从 `.env` 读取，不会显示在命令行输出：

```sh
npm run video:desktop -- submit "橘猫穿过草地" --model "Seedance 2.0 Fast" --duration 5 --ratio 16:9 --key cat-grass-001 --async
npm run video:desktop -- status <task_id> --wait-seconds 30
npm run video:desktop -- download <video_id> ./result.mp4
```

去掉 `--async` 时，提交请求会等待生成完成，最长约 9 分钟；超时返回可继续查询的 `task_id`，不会重发。重复使用同一个 `--key` 会复用原任务；同一个 key 配不同请求会报错。已存在的会话可以用 `npm run video:desktop -- recover <conversation_id> <run_id>` 提取。视频文件 URL 也需要 `Authorization: Bearer <LOCAL_API_KEY>`；`GET /v1/videos/tasks/:task_id` 可查询状态，`GET /v1/videos/files/:video_id` 可下载，支持 Range。

CLI、API 与 MCP 可显式请求 `Seedance 2.5`，时长范围为 **4–30 秒**；其他模型继续使用原来的 1–15 秒校验。主页仍默认请求 Fast。30 秒请求会保留完整时长，不会截成 15 秒：

```bash
npm run video:desktop -- generate "清晨云海中的九尾狐，连续镜头，无文字" --model "Seedance 2.5" --duration 30 --ratio 16:9 --timeout-seconds 1800 --output ./seedance25.mp4
```

MCP 的 `generate_and_wait` 同样可传 `model: "Seedance 2.5"`、`duration: 30`、`timeout_seconds: 1800`。账号权限与额度由豆包决定，网关不承诺固定可生成条数；发生超时或确认暂停，应继续查询原 `task_id`，不要换编号重发。模型核验仍为 `requested_only`，不能把请求名称当成独立的服务端模型证明。

2026-10-05 本机实测：一条 5 秒 16:9 纸船视频通过 HTTP 提交，在网关重启后由同一任务自动确认并完成，CLI 下载的 MP4 为 1,106,223 字节、1280×720、5.056 秒；全片解码通过。该验证覆盖 Doubao.app 工作资料档案中的企业客户端链路；个人版网页视频接口仍按原有实现单独处理。

**任务状态由后台 watcher 推进。**网关进程内的 watcher 通过一条复用的 CDP 连接查询豆包、自动确认、下载并校验 MP4，然后写入任务 JSON；`GET /v1/videos/tasks/:task_id` 只读本地状态（毫秒级），`?wait_seconds=N` 等待状态变化，`?refresh=1` 对暂停状态（`unknown` / `waiting_input` / `extraction_failed`）立即重查一次豆包。`GET /v1/videos/tasks/:task_id/events` 是 SSE 流（同样需要 Bearer），不可恢复或已完成时自动关闭；可恢复的 `unknown` 状态继续跟踪原任务。响应里的 `phase` 字段：`submitted` → `generating` → `awaiting_confirmation` → `extracting` → `validating` → `ready`。

**Agent 通过 MCP 生成视频。**`scripts/orbit-frame-mcp.mjs` 是本地 stdio MCP 服务，自己读取 `LOCAL_API_KEY`，不会把密钥交给 Agent。它提供 `upload_frame`、`list_media`、`compose_video_scene`、`get_canvas`，以及连接检查、图像生成、`generate_and_wait`、状态与下载工具。生成等待的总时限包括提交和查询，超时保留原任务编号；`download_video` 只写入 `ORBIT_FRAME_OUTPUT_DIR`（默认 `data/exports`），且只接受文件名。新工具需客户端重连 MCP 后重新发现。

**图生视频与首尾帧。**CLI `--first-frame "/本机/首帧.png"` 和 `--last-frame "/本机/尾帧.png"` 可直接读本地图片并自动上传；MCP 使用 `first_frame_path` / `last_frame_path`（保留 `first_frame: {path: ...}` 写法）。CLI/MCP 默认 `mode=auto`：一张图选 `image_to_video`，两张选 `first_last_frame`，没有图片才选 `text_to_video`；缺首帧或显式模式与图片冲突时直接报错，不忽略图片。HTTP 网关仍只读取 `ORBIT_FRAME_MEDIA_DIR` 内素材：外部客户端先用 `POST /v1/videos/frames` 上传字节，再把返回的素材路径传入生成请求。图片按内容识别 PNG/JPEG/WebP，单张不超过 20 MB、每边 300–6000 像素、宽高比 2:5–5:2。网关保存 `first_frame.*` / `last_frame.*` 私有副本，按角色顺序作为附件上传；任务返回角色与 SHA256，比例不符时提示。完整 CLI/MCP 和画布镜头流程见 [Agent 工作流](docs/AGENT-WORKFLOW.md)。

**无限画布。**`http://127.0.0.1:8787/canvas.html`（首页导航「画布 ↗」）。文字、图片、视频三种卡片。推荐直接点击视频卡的「选择首帧 / 选择尾帧」，从画布、素材库或新上传的图片中选择；连线自动建立，① 首帧和 ② 尾帧颜色不同，可一键交换。已提交任务保留输入帧，不能通过编辑或撤销改变其角色。也可以把图片卡右侧圆点拖到视频卡的「首帧 / 尾帧」槽位（或把图片文件、素材直接拖进槽位）即为图生视频或首尾帧。操作：拖动空白处或按住空格平移，Shift + 拖动框选，⌘ + 滚轮或双指缩放，⌘Z / ⇧⌘Z 撤销重做（生成结果不会被撤销回去），⌘C / ⌘V / ⌘D 复制粘贴重复（可跨画布；粘贴截图直接变图片卡，粘贴文字变文字卡），方向键微移，⌘A 全选，Delete 移除选中卡片或连线（点击连线可选中），右键菜单，拖卡片右下角调宽，双击图片看大图，右下角小地图点击跳转，新卡片自动避开已有卡片。「素材」抽屉可把作品库里的视频和已生成 / 上传的图片放进画布。图片生成改为后台任务（`POST /v1/images/jobs`、`GET /v1/images/jobs/:id?wait_seconds=25`），刷新或切换画布不会中断；重试同一图片请求沿用编号，不会重复生成；另一个仍存活的网关拥有的任务仍显示生成中。原进程退出后状态为未知，需先核对豆包结果，当前图片接口不能自动接管上游生成。视频只在接近可视区时加载。画布保存在 `data/canvases/<id>.json`，只记录卡片位置、`task_id`、媒体路径和图片任务 ID；移除卡片或删除画布（`DELETE /v1/canvases/:id`）都不会删除文件或任务。其他接口：`GET/POST /v1/canvases`、`GET/PUT /v1/canvases/:id`（`version` 不一致返回 409，防止两个窗口互相覆盖；网页把未保存的本地编辑另存为“冲突恢复”副本）、`GET /v1/videos/events?ids=a,b`（多任务共用一条 SSE）、`GET /v1/media?dir=generated|uploads`（素材列表）。本机页面连接时会得到一个只读媒体 Cookie（HttpOnly、SameSite=Strict、每次重启更换），仅用于加载 `/v1/media/*`、`/v1/videos/frames/*`、`/v1/videos/files/*`，不能调用其他 API。

```bash
doubao mcp register orbit-frame --command "$(command -v node)" --arg "$PWD/scripts/orbit-frame-mcp.mjs"
```

### 多方案路由

默认与 failover 在 `.env`；单次请求可覆盖：

```json
{
  "provider": "jimeng-api",
  "prompt": "@图1 为角色立绘…",
  "ratio": "16:9",
  "images": ["…"]
}
```

或 Header：`X-Image-Provider` / `X-Video-Provider`。

支持：`doubao`、`jimeng`、`jimeng-api`、`kling`、`volcengine`、`openai` 等。

### 对话 · 豆包

```bash
curl http://127.0.0.1:8787/v1/chat/completions ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"doubao\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

### 对话 · Cursor

需 `CURSOR_API_KEY`。`model` 为 Cursor 模型名（如 `composer-2.5`），或加 Header 显式走路由：

```bash
curl http://127.0.0.1:8787/v1/chat/completions ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -H "X-Provider: cursor" ^
  -d "{\"model\":\"composer-2.5\",\"messages\":[{\"role\":\"user\",\"content\":\"写一场古风对峙戏\"}]}"
```

---

## 常用命令

| 命令 | 作用 |
|------|------|
| `npm start` | 上游 free-api + 网关（含内嵌即梦） |
| `npm run gateway` | 仅网关 |
| `npm run upstream` | 仅 doubao-free-api |
| `npm run login` | 弹窗登录 |
| `npm run login:switch` | 换账号进池 |
| `npm run start:cdp` | 启动 CDP 浏览器 |
| `npm run setup` | 依赖 + Playwright + 构建上游与 jimeng-api |

---

## 环境变量

详见 [`.env.example`](.env.example)。常用：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8787` | 网关端口 |
| `LOCAL_API_KEY` | `local-dev-key-change-me` | 客户端 Bearer |
| `UPSTREAM_URL` | `http://127.0.0.1:8000` | 豆包对话上游 |
| `IMAGE_PROVIDER` / `VIDEO_PROVIDER` | `doubao` | 默认媒体方案 |
| `JIMENG_API_ENABLED` | `1` | 内嵌即梦 SDK |
| `CURSOR_API_KEY` | — | Cursor 编剧 |
| `CURSOR_RUNTIME` | `cloud` | `cloud` / `local`（配合 `CURSOR_CWD`） |
| `DOUBAO_USE_CDP` | — | `1` 启用 CDP |
| `LOG_DIR` | `data/logs` | 按天日志 |

勿提交：`data/`、`.env`、`vendor/**/node_modules`。

---

## 旧版文档与免责

- 改版前 README：[docs/README.legacy.md](docs/README.legacy.md)  
- 非官方接口，网页改版可能失效；**仅限个人学习**，勿对外商用  
- 生产环境请用各平台官方 API（如 [火山引擎豆包](https://www.volcengine.com/product/doubao)）

画布操作与本轮验收说明见 [画布使用说明](docs/CANVAS.md)。作品列表支持 `?limit=40&before=<task_id>` 分页，响应包含 `next_cursor`；首页作品库可加载更多。

### 云盘视频交付

企业豆包视频现在统一使用 `cloud_only` 策略：网页、CLI 与 MCP 只提取与成功云盘上传记录匹配的原视频。回复即使同时有视频卡，也不会下载视频卡作为备用。程序关联同一任务内的上传路径与原视频下载地址，下载后核对上传字节数、MP4、时长与比例；不会执行豆包回复中的命令。

结果含 `delivery`（来源数量与选择策略），视频含 `source_kind` / `source_verification`。云盘文件页用于确认上传关系，不直接当 MP4 下载，也不放宽下载域名检查。该策略选择云盘上传版本，不会编辑水印或修改 AIGC 标识；上游以后是否包含可见水印仍取决于它交付的文件。

旧作品点“重新提取云盘版本”，或调用 `GET /v1/videos/tasks/:id?refresh=1`。这是读取原任务并重新下载，不重新生成。CLI `generate --task TASK_ID --output FILE.mp4` 与 MCP `download_video` 会处理旧任务的重新提取；CLI 按视频 ID 下载时，只接受已核验云盘来源的文件。未找到可核验来源会返回 `video_missing` / `cloud_video_missing`，请在豆包原会话补交云盘文件后重新查询。
