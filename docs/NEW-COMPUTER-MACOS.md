# Orbit Frame：另一台 Mac 的完整部署流程

适用：在另一台 Mac 上独立运行网页、CLI、MCP、豆包视频桥接与可选的外接生图。此包是 2026-10-10 本地源码快照，包含尚未同步到 GitHub 的代码；首次部署优先使用这个包。

**最短流程：安装 Node.js 和豆包 → 解压 → 双击安装 → 连接并登录豆包 → 双击启动 → 双击检查。** 不需要申请或填写 LOCAL_API_KEY。账号登录与外接生图密钥在新电脑单独配置。

安装依赖需要联网。包里包含完整项目源码、锁定依赖清单、网页资源、上游源码及许可证、测试、完整调用 Skill、macOS 启动脚本和本教程；安装包不携带旧电脑的账号、Cookie、真实密钥、任务、生成文件或已安装依赖。

## 1. 准备新电脑

1. 从 [Node.js 官方下载页](https://nodejs.org/en/download) 安装 **Node.js 24 LTS** 的 macOS 安装包。Apple 芯片选 arm64，Intel 选 x64；项目最低要求 22.13。安装后重新打开终端。
2. 从 [豆包官方下载页](https://www.doubao.com/download) 安装客户端，拖入“应用程序”，实际路径为 `/Applications/Doubao.app`。
3. 打开豆包，登录自己的账号。可在 Doubao.app 内使用已具备生成权限的企业账号；项目当前明确选择 Doubao.app，独立的 DoubaoWork.app 尚未在完整网关验收。
4. 确认手动发普通消息不会立即退出登录，账号能看到视频功能。当前机器验证过的组合是 Apple Silicon、Node 24.19、Doubao.app 2.31.4；其他版本由后面的连接检查与实际生成验收确认。

不需要安装 Docker、Git、Python 或 FFmpeg。可通过 Git 安装源码，但它不是这个部署包的前置条件。

## 2. 解压并放在固定位置

把 `orbit-frame-macos-2026-10-10.zip` 传到新 Mac 并解压。把整个项目文件夹放在自己的固定目录，例如 `~/Applications/orbit-frame`。文件夹名和父目录可以含中文或空格。

不要在 ZIP 内直接运行，不要只复制 Skill 或几个脚本。安装后台服务/MCP 后应保持项目位置固定；移动目录后需要重新生成这些配置。

项目根目录应能看到：

```text
Mac-一键安装.command       安装依赖、构建上游、初始化本机配置
Mac-连接豆包.command       开启 Doubao.app 的本机调试连接
Mac-启动.command           前台启动并打开网页
Mac-检查.command           只读检查，不消耗生成额度
Mac-MCP配置.command        生成适配新电脑路径的 MCP 配置
Mac-后台运行.command       可选：用户登录后后台运行网关
deployment/               部署实现与打包脚本
src/ public/ scripts/      后端、网页、CLI/MCP
vendor/doubao-free-api/     本机上游完整源码
skills/orbit-frame/         全面调用 Skill 与说明书
docs/ tests/               教程与自动检查
```

若 Finder 提示没有执行权限，在终端进入解压目录执行：

```bash
chmod +x ./Mac-*.command ./deployment/mac-runner.sh
```

若系统阻止打开脚本，右键该脚本选择“打开”，或从终端执行下文对应命令。无需关闭系统安全检查。

## 3. 双击「Mac-一键安装.command」

安装程序会依次：

1. 使用 `npm ci` 按两个 lockfile 安装项目和上游依赖，使用 npmmirror 镜像。
2. 构建 `vendor/doubao-free-api`。
3. 安装网页登录所需的 Playwright Chromium。
4. 从 `.env.example` 创建私有 `.env`，初始化 `data/`，自动生成本机 API Key。

看到“安装完成”再继续。重复运行保留已有 `.env` 和 `data/`，依赖会重新按 lockfile 安装；不会复制或覆盖豆包登录资料。不要在正在执行生成任务时重新安装依赖。

终端等价命令，在项目根目录执行：

```bash
node deployment/mac-deploy.mjs install
```

默认网关为 `127.0.0.1:8787`，本机上游为 `127.0.0.1:8000`，客户端调试连接为 `127.0.0.1:9225`。前两项只监听本机地址。

## 4. 双击「Mac-连接豆包.command」，然后登录

先保存豆包客户端中的工作，按 **⌘Q 完全退出**，再运行连接脚本。它用已锁定的 `doubao-cli@0.13.0` 启动 Doubao.app，并开启本机调试端口。若应用已运行且没有调试连接，CLI 会说明需要重启，按提示确认即可。

```bash
node deployment/mac-deploy.mjs bridge
```

随后在豆包客户端登录自己的账号，进入正常聊天页面，保持应用运行。**不要把高级管理页的网页登录当作客户端登录**；网页传统聊天/图像桥接与桌面视频是两条链路。

客户端正常退出、电脑重启或客户端更新后，若连接检查提示不可用，重新运行本步骤。网关后台启动不会替你重新登录，也不会擅自关闭豆包。

如果豆包装在自定义目录，可在 `.env` 中设置 `DOUBAO_APP=/完整路径/Doubao.app`；不要把调试端口暴露到公网。

## 5. 双击「Mac-启动.command」

```bash
node deployment/mac-deploy.mjs start
```

脚本先检查网关/上游端口，再启动两项服务，确认响应属于本目录的网关后打开 [本机首页](http://127.0.0.1:8787/)。第一次使用保持这个终端窗口打开；按 Ctrl+C 停止服务。

首页自动连接，不需要填写密钥。在“连接设置”可以复制自动生成的 API Key，供自己的 HTTP 程序调用。**LOCAL_API_KEY 是本机网关的访问密钥，由本项目自动生成；不是豆包密钥，也不是外接图片服务密钥。** CLI/MCP 会自行读取。

## 6. 双击「Mac-检查.command」

```bash
node deployment/mac-deploy.mjs doctor
```

检查结果保存在 `data/deployment-check.json`，不含密钥，不创建图片或视频。成功的主链路结果应为：

```json
{
  "ok": true,
  "generation_submitted": false,
  "checks": {
    "project_gateway": true,
    "unauthenticated_rejected": true,
    "local_key_accepted": true,
    "upstream_reachable": true,
    "doubao_ready": true
  }
}
```

`image_provider_available=false` 表示外接生图还没配置，不影响独立的视频链路。`doubao_ready=true` 只确认连接、登录痕迹与客户端模块可读，不代表额度、实际模型或生成成功。

## 7. 真实验收：网页、首尾帧、CLI

先做一条 5 秒小样本即可，不要上来批量生成。

**网页：** 首页输入提示词，选择 Seedance 2.5、5 秒、9:16；需要首尾帧时分别上传自己的两张 PNG/JPEG/WebP 原图，确认角色和预览，再点击生成。完成后应能播放、下载，并在作品库找到同一个任务。

**CLI：** 在项目根目录执行。下面会真正调用你的账户并消耗生成额度，请自行替换图片路径和提示词后运行。

```bash
request_key="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
printf '本次请求编号：%s\n' "$request_key"

npm run --silent video:desktop -- generate \
  "严格使用两张原图，从首帧自然过渡到尾帧，保持主体与构图" \
  --first-frame "$HOME/Desktop/首帧.png" \
  --last-frame "$HOME/Desktop/尾帧.png" \
  --model "Seedance 2.5" --duration 5 --ratio 9:16 \
  --key "$request_key" --output "$HOME/Desktop/首尾帧验收.mp4"
```

一张首帧自动使用图生视频；两张自动使用首尾帧；去掉图片参数即为文生视频。CLI 正规上传原始图片，无需 computer use、拖线或复制到素材文件夹。

进度在 stderr，结果 JSON 在 stdout。只有 `completed`、已验证的云盘原片、有效本地 MP4 才算交付。文件存在时不会覆盖，换一个输出文件名即可。

超时或需要进一步输入时保留原 `task_id`；继续查询/导出，**不要换请求编号重发**：

```bash
npm run --silent video:desktop -- status "原task_id" --wait-seconds 30
npm run --silent video:desktop -- generate --task "原task_id" \
  --output "$HOME/Desktop/首尾帧验收.mp4"
```

明确的视频参数确认由后台处理；付费或尚未支持的输入去原客户端会话处理，再查询原任务。模型名/范围是请求参数：Seedance 2.5 接受 4–30 秒，Fast 接受 1–15 秒，账号实际可用性以成片验证为准。项目仅下载核验通过的云盘来源，不做视频后期去水印。

完整参数与恢复方法见 [Agent 工作流](AGENT-WORKFLOW.md) 和 [Skill CLI 说明](../skills/orbit-frame/references/cli.md)。

## 8. 配置外接生图 `gpt-image-2.5`

打开 [本机生图服务设置](http://127.0.0.1:8787/image-provider.html)，填写：

| 设置 | 填什么 |
|---|---|
| API 地址 | 新电脑可访问的兼容接口，例如 `http://127.0.0.1:63451/v1` |
| 服务密钥 | 该生图服务自己的密钥，在本机页面输入 |
| 模型 | `gpt-image-2.5`，并检查服务的模型发现结果 |
| 参考图编辑 | 服务支持原图 edits 时启用 |

点击“保存到本机并检查连接”。密钥保存在 `data/image-provider.json`，不进 MCP 配置或部署包。

**重要：新 Mac 的 `127.0.0.1:63451` 只指新 Mac 自己。** 如果服务仍在旧电脑，不能直接照抄本机地址。有两种方式：

1. 在新电脑运行同一生图服务，再使用本机地址。
2. 让旧电脑保持服务运行，通过你自己的 SSH 连接转发。旧 Mac 先开启“系统设置 → 通用 → 共享 → 远程登录”；在新 Mac 的单独终端运行：

```bash
ssh -N -L 127.0.0.1:63451:127.0.0.1:63451 旧Mac用户名@旧Mac局域网IP
```

转发期间保持此终端和旧电脑运行。新电脑仍填 `http://127.0.0.1:63451/v1`，使用原生图服务自己的密钥。如果新机的 63451 已占用，将命令左侧的 63451 改为 63452，页面地址也改为 `http://127.0.0.1:63452/v1`。接口有可访问的 HTTPS 地址时，也可直接在页面配置 HTTPS。

如果已有私有环境文件：

```dotenv
OPENAI_BASE_URL=http://127.0.0.1:63451/v1
OPENAI_API_KEY=在本机填入服务密钥
OPENAI_MODEL=gpt-image-2.5
```

不要把实际密钥放进命令行、聊天或 Git。将文件保存在项目外并设为仅自己可读，然后导入：

```bash
chmod 600 "$HOME/.config/orbit-frame/image-provider.env"
node skills/orbit-frame/scripts/orbit.mjs --project "$PWD" configure-images \
  --env-file "$HOME/.config/orbit-frame/image-provider.env"
```

只设置 `OPENAI_*` 不会自动接入网关，需用设置页或这个配置助手保存。随后可检查：

```bash
npm run --silent image:desktop -- providers
```

配置完成后才进行真实生图，例如：

```bash
npm run --silent image:desktop -- "山海经异兽站在云海山峰，电影感，竖版" \
  --provider openai-compatible --model gpt-image-2.5 --ratio 9:16 \
  --output-dir "$HOME/Desktop/轨映图片"
```

参考原图编辑再加 `--reference-image "/完整路径/原图.png"`。外接同步生图当前没有上游查询/取消接口；响应不确定时保留 unknown，不自动重发。

## 9. 给 Claude Code / Codex / 其他 Agent 配 MCP 和 Skill

双击 **Mac-MCP配置.command**，或：

```bash
node deployment/mac-deploy.mjs mcp-config
```

配置输出并保存到 `data/mcp-config.json`，使用新机的真实 Node 和项目绝对路径。采用 `mcpServers` 格式的客户端，把其中 `orbit-frame` 项合并进自己的配置；采用其他格式的客户端，填写同样的 `command`、`args` 和 `env`。保留其他服务器，不要用这个文件覆盖客户端整份配置。它是 **stdio MCP**，不是需要填写网址的 HTTP MCP；网关仍需先启动。更换项目位置或 Node 安装位置后重新生成配置。

无需填写网关 API Key；MCP 自动读取本机配置。生成后导出的文件默认在 `data/exports`。

首尾帧 MCP 调用：

```json
{
  "tool": "generate_and_wait",
  "arguments": {
    "prompt": "严格使用两张原图，从首帧自然过渡到尾帧",
    "first_frame_path": "/新电脑完整路径/首帧.png",
    "last_frame_path": "/新电脑完整路径/尾帧.png",
    "model": "Seedance 2.5",
    "duration": 5,
    "ratio": "9:16",
    "idempotency_key": "为这一次生成创建并保存的UUID"
  }
}
```

先调用 `check_video_connection({})`，再执行生成。Agent 需要画布时，用 `compose_video_scene` 一次准备提示词、首尾帧、视频卡与连线，再把返回的 `canvas_id/card_id` 传给 `generate_and_wait`；不要模拟坐标拖线，也不要重复准备相同镜头。

完整 Skill 已在 `skills/orbit-frame/`。把这个完整目录放进你使用的 Agent 的 Skill 目录；Codex 常用 `~/.codex/skills/orbit-frame`，Claude Code 常用 `~/.claude/skills/orbit-frame`。已有同名 Skill 时先备份旧版本，避免复制成两层目录。仅安装 Skill 不能替代本项目与网关。

完整使用说明见 [Skill 使用说明书](../skills/orbit-frame/使用说明书.md)。

## 10. 可选：登录 Mac 后后台运行

先完成前台验收，按 Ctrl+C 退出前台网关，再双击 **Mac-后台运行.command**。它创建当前用户的 `local.doubao-relay` LaunchAgent，不需要管理员权限；配置里仅有本机路径，不含密钥。

```bash
node deployment/mac-deploy.mjs autostart --dry-run  # 只展示配置，不安装
node deployment/mac-deploy.mjs autostart            # 安装并验证后台网关
```

已有同名服务会拒绝覆盖，端口占用时也不会终止其他进程。安装后台服务后不要再同时双击前台启动。

```bash
./scripts/service.sh status
./scripts/service.sh stop
./scripts/service.sh start
./scripts/service.sh restart
node deployment/mac-deploy.mjs remove-autostart
```

卸载后台配置保留 `.env` 和全部 `data/`。后台日志为 `data/logs/service.out.log` 和 `service.err.log`。后台运行的是网关；豆包仍需保持登录、调试连接可用，电脑休眠时无法承诺继续生成。

## 11. 更新、备份与回滚

1. 保存原部署 ZIP、当前源码、`.env` 和 `data/` 的私有备份。`.env`/`data/` 可能含密钥或登录资料，只放在自己的备份中，不上传到公开仓库。
2. 有任务时记录原 `task_id`，先检查状态；需要维护时停止后台服务或前台终端。
3. 在**相同项目路径**更新源码，保留已有 `.env` 和 `data/`，重新运行安装并启动、检查。不要直接删除整个目录或覆盖任务资料。
4. 更新失败就把原源码恢复到同一路径，保留原 `.env`/`data/`，重新安装原 lockfile 依赖后启动。
5. 豆包更新属于独立环节：更新后完全退出客户端，再运行连接脚本和检查。网关源码回滚不等于客户端版本回滚。

这个部署包不迁移旧电脑的豆包用户目录或自动登录凭据。若需要历史作品/任务的跨电脑迁移，应单独核验任务、素材和客户端来源路径，而不是覆盖新电脑的账号目录。

## 12. 常见失败与处理

| 表现 | 处理 |
|---|---|
| 找不到 Node | 安装 Node 24 LTS，重新打开终端；不要只安装 npm |
| npm 下载失败 | 检查新电脑网络；安装脚本可重复运行，保留配置 |
| Chromium 下载失败 | 网络恢复后重跑安装；仅桌面链路临时调试可按下方手动步骤安装依赖 |
| 8787/8000 已占用 | 停止已知的旧服务；脚本不会替你杀进程。需改端口时同步调整 `.env` 的 PORT、SERVER_PORT、UPSTREAM_URL |
| 豆包 CDP 不可用 | 保存工作、⌘Q 完全退出、重新运行连接脚本，进入聊天页 |
| 提示客户端未登录 | 在客户端恢复登录；普通消息也退出时先处理客户端账号认证 |
| 401 | 确认 MCP/CLI 指向同一个项目；网页点击重新连接。不要拿生图密钥当网关密钥 |
| 首尾帧不可读 | 使用新机完整路径、PNG/JPEG/WebP 原图，确认文件仍存在且可读 |
| waiting_input/unknown | 查看原任务与客户端原会话，继续原 task_id，不创建第二条视频 |
| 63451 生图连接失败 | 本机运行服务或建立 SSH 转发，检查服务自己的密钥和模型发现 |
| 本地文件已存在 | 换输出文件名，不覆盖原视频 |
| 移动项目后 MCP/后台不可用 | 重新生成 MCP 配置；原路径卸载后台服务后，在新路径重新安装 |

手动安装等价流程，仍在项目根目录运行：

```bash
cp -n .env.example .env
chmod 600 .env
npm ci --registry=https://registry.npmmirror.com --no-audit --no-fund
npm ci --prefix vendor/doubao-free-api --registry=https://registry.npmmirror.com --no-audit --no-fund
npm run build --prefix vendor/doubao-free-api
node node_modules/playwright/cli.js install chromium
node node_modules/doubao-cli/bin/doubao.mjs --app doubao cdp launch
node deployment/mac-deploy.mjs start
```

完整离线代码检查可用 `npm test`；通过检查仍需在新电脑完成真实生成、预览、下载验收。
