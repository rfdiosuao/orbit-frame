# 轨映 · Orbit Frame

![轨映 Logo](public/orbit-frame.svg)

一个在 macOS 上运行的豆包企业客户端视频创作工作台：在页面填写提示词、时长和画面比例，经本机网关调用已登录的豆包客户端，再提取并校验真实 MP4。界面采用 HEANG 的天空 / 深空主题，包含 Logo 开屏动画、真实生成状态、作品库和视频预览。

## 安装与教程

- **[从零部署与使用教程](docs/DEPLOYMENT.md)**：环境准备、安装、登录、页面创作、CLI、HTTP 接口和常见问题。
- [界面设计与前端实现](docs/ORBIT-FRAME.md)
- [架构与验证结果](docs/ARCHITECTURE.md)

```bash
git clone https://github.com/rfdiosuao/orbit-frame.git
cd orbit-frame
cp .env.example .env
npm install --registry=https://registry.npmmirror.com
npm run setup:upstream
npx playwright install chromium
# 启动时自动生成并保存网关密钥
npm start
```

打开 **http://127.0.0.1:8787/** 即自动连接，无需填写密钥。企业客户端视频需要已登录的 **Doubao.app** 及本机 CDP；准备方法见部署教程。

## 当前功能

- 提示词、1–15 秒时长、横屏 16:9 / 竖屏 9:16 / 方形 1:1，另支持 4:3 / 3:4。
- 默认请求 Seedance 2.0 Fast，输出 MP4。实际执行模型 ID 尚未独立核验，模型名表示请求值。
- 真实任务状态、刷新恢复、幂等提交、白名单视频确认自动继续、成片提取与 MP4 校验。
- Bearer 认证的作品列表和文件接口；预览使用 Blob URL。
- 天空 / 深空主题、Logo 与加载动画、手机布局及减少动态效果支持。
- 保留原有文生图入口和高级账号、Cookie、日志管理。

视频链路在 macOS 上已实际验收：6 秒 9:16 小狐狸视频，生成文件 720×1280、视频轨 6.04 秒；HTTP 下载和完整 FFmpeg 解码通过。旧任务恢复、刷新与防止重复生成均有实际验证。内嵌浏览器下载按钮落盘没有独立核验；CLI 下载可直接保存文件。其他客户端版本和操作系统仍需现场验证。

## 获取本地 API Key

Key 是网关自动生成的本机访问密码，保存在 `.env` 的 `LOCAL_API_KEY`，无需向豆包申请或手工填写。网页自动连接；外部程序调用 API 时，在「连接设置」点击「复制 API Key」。页面保留 cURL / Python API 示例。

## CLI 示例

```bash
# 一次调用，自动等待成片并保存
npm run --silent video:desktop -- generate "清晨海边的小狐狸奔跑" --duration 6 --ratio 9:16 --key fox-auto-001 --output ./fox.mp4
# 或分步提交、查询、下载
npm run --silent video:desktop -- submit "清晨海边的小狐狸奔跑" --duration 6 --ratio 9:16 --key my-first-video --async
npm run --silent video:desktop -- status <task-id> --wait-seconds 45
npm run --silent video:desktop -- download <video-id> ./output.mp4
```

密钥从本地 `.env` 读取，CLI 不打印密钥。查询时继续使用原任务 ID；同一 `--key` 只能用于相同请求。

## 来源与许可

本项目基于 [linyf-B/doubao-relay](https://github.com/linyf-B/doubao-relay) 的本地工作副本，保留其源码和历史文档；此仓库展示的是当前实际实现。原版扩展功能说明归档于 [旧版 README](docs/README.upstream.md)，其中列出的 ToonFlow、Cursor 等模块不能视为本版本已实现。

- [doubao-cli](https://github.com/Fullstop000/doubao-cli)：固定依赖 `0.13.0`，用于本机客户端桥接。
- `heang-design@0.1.0`：设计变量和交互动画；[MIT 许可证](public/heang/LICENSE)。
- 内嵌 `doubao-free-api`：[原许可证](vendor/doubao-free-api/LICENSE)。

本项目需要用户自己的客户端登录和视频权限。源码不包含登录态、密钥、生成的视频、账户数据或本机运行日志。网关默认仅监听回环地址，适合本机使用。
