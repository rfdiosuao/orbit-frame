# doubao-relay · 本地媒体网关

> 本地工作副本（2026-10-05）：首页 `http://127.0.0.1:8787/` 已改为「轨映 / Orbit Frame」视频创作界面。原有账号池、Cookie、文生图和日志入口保留在 `/legacy.html`。以下旧版仓库功能描述包含本地工作副本尚未实现的模块；以 [本机部署记录](DEPLOYMENT.local.md) 和实际接口为准。

## 轨映首页（本地工作副本）

1. 打开 `http://127.0.0.1:8787/`，到「连接设置」输入本地 `.env` 配置的 `LOCAL_API_KEY`。默认只在当前页面内存使用；勾选「记住这台设备」才写入此浏览器的本地存储。已存的旧值可继续读取。密钥不会显示在页面调用示例中。
2. 回到「视频创作」，写提示词；时长为 **1–15 秒**，画面比例为横屏 16:9、竖屏 9:16、方形 1:1，另可选 4:3、3:4；输出文件为 MP4。页面默认请求 `Seedance 2.0 Fast`，界面所示模型名是请求值，尚未对服务端实际模型 ID 做独立核验。
3. 提交后可在预览区看真实任务状态。页面刷新时，会用原 `task_id` 恢复查询；提交结果未确认时，保持相同提示词和设置重试会复用已保存的幂等键，避免创建第二个视频。只有任务完成且 MP4 文件可读取时才出现预览和下载。
4. 「作品库」读取本机任务记录；「图像」保留常用文生图操作；「连接设置 → 打开高级管理」进入旧管理页，继续使用账号池、登录、手动 Cookie 和实时日志。

界面采用 `heang-design@0.1.0` 的天空/深空设计变量、鼠标交互和 Logo 开屏动画；相关静态资源与 MIT 许可证保存在 `public/heang/`，应用 Logo 为 `public/orbit-frame.svg`。实现和资源更新说明见 [轨映文档](docs/ORBIT-FRAME.md)。

> 无 Docker，个人自用。把豆包 / 即梦 / 可灵网页额度、本机 **Cursor** 编剧、火山方舟等，统一为 **`http://127.0.0.1:8787/v1`** 的 OpenAI 兼容 API。  
> **GitHub**：[linyf-B/local-media-gateway](https://github.com/linyf-B/local-media-gateway)（仓库名；管理页与 npm 包名仍为 **doubao-relay**）

**能做什么**

- 深色 **管理页**：账号池、本机试生成、成片记录、实时日志、ToonFlow 插件中心  
- **ToonFlow**：同时挂「豆包 / 即梦本地中转」生图生视频 +「Cursor 编剧」用 Composer / Claude / GPT / Gemini / Kimi 等写剧本  
- **脚本 / 任意客户端**：同一套 Bearer `LOCAL_API_KEY` 调 `/v1/*`


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


- **方案卡片**：豆包、即梦、可灵等；点选后操作当前方案  
- **登录当前方案 / 换账号登录**：扫码或 CDP 窗口；会话在 `data/`（**勿用 sessionid 当 API Bearer**）  
- **账号池**：切换、单号清冷却、删除、清空全部  
- 接口：`GET /admin/providers`

### 本机试生成


- 与 ToonFlow **同一 HTTP 接口**；显示预计消耗  
- 页签：文生图 / 文生视频；`@图1`… 对应参考图（最多 6 张）  
- 可选模型、比例；可展开 **原始 JSON**

### 生成记录


- **实时同步** / **清空**（清空仅前端；日志文件仍按天保留）  
- 含提示词、模型、缩略图、**下载**

### 实时日志


- 路径示例：`data/logs/relay-YYYY-MM-DD.log`  
- **跟随 / 暂停 / 清空**

### 高级设置


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




插件细节见 [`toonflow/README.md`](toonflow/README.md)。

### 通用导入（媒体 + 对话）

1. `npm start`，管理页为对应平台 **登录**  
2. ToonFlow → 导入 `toonflow/*.ts`（可 **检查更新**）  
3. **API 密钥** = `LOCAL_API_KEY`；**地址** = `http://127.0.0.1:8787/v1`  
4. `doubaorelay.ts` 可指定生图/视频方案（`doubao`、`jimeng-api`、`kling`…），留空用 `.env` 默认  

### ToonFlow 模型服务（多供应商并行）

**设置 → 模型服务** 可同时启用：媒体走 **豆包 / 即梦本地中转**，文本走 **Cursor 编剧**（均指本机 `8787`，不填网页 SessionID）。


| 供应商 | 典型模型 |
|--------|----------|
| 豆包 / 即梦本地中转 | Seedream、Seedance、即梦 4.0 等（需网关管理页登录） |
| Cursor 编剧 | 仅文本：Composer 2.5、Claude、GPT、Gemini、Kimi 等 |



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

2026-10-05 本机实测：一条 5 秒 16:9 纸船视频通过 HTTP 提交，在网关重启后由同一任务自动确认并完成，CLI 下载的 MP4 为 1,106,223 字节、1280×720、5.056 秒；全片解码通过。该验证覆盖 Doubao.app 工作资料档案中的企业客户端链路；个人版网页视频接口仍按原有实现单独处理。

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
