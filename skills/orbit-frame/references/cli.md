# CLI 操作：生图、首尾帧与视频交付

以下命令在完整 Orbit Frame 项目目录执行。Node.js 22.13+；网关需已启动。CLI 自动读取项目的本地网关密钥，外接生图另读本机生图设置，不要把密钥写到提示词或命令参数中。

## 参数与准备

```sh
npm run video:desktop -- check
npm run image:desktop -- providers
npm run video:desktop -- upload-frame "/完整路径/首帧.png"
```

上传返回 `path`、预览、宽高、字节数和 SHA256，不会生成媒体。PNG/JPEG/WebP，最大 20 MB，每边 300–6000 像素，图片比例 2:5–5:2；会校验实际字节，不只检查后缀。

| 输入 | CLI 参数 | 自动模式 |
|---|---|---|
| 只有提示词 | 不传图片 | text_to_video |
| 一张参考图 | `--first-frame FILE` | image_to_video |
| 首帧和尾帧 | `--first-frame FILE --last-frame FILE` | first_last_frame |

视频支持请求 `Seedance 2.0 Fast` 和 `Seedance 2.5`。Fast 的代码参数范围为 1–15 秒；2.5 为 4–30 秒。比例可用 16:9、9:16、1:1、4:3、3:4。这些范围不代表全部真实生成已测过；以当前账号和上游响应为准。

新请求先创建并记录 UUID，请求编号与结果日志保存在本机。每个新的生成任务使用新的编号；恢复原任务保留旧编号。

```sh
ORBIT_REQUEST_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
```

## 一次生成并下载

```sh
# 文生视频
npm run video:desktop -- generate "云海中的浮空岛，镜头缓慢推进" \
  --model "Seedance 2.0 Fast" --duration 5 --ratio 16:9 \
  --key "$ORBIT_REQUEST_KEY" --output "/完整路径/新文件.mp4"

# 单图：原图自动上传，不能省略该图片
npm run video:desktop -- generate "保持原图人物和构图，只有衣摆轻动" \
  --first-frame "/完整路径/首帧.png" \
  --model "Seedance 2.5" --duration 5 --ratio 9:16 \
  --output "/完整路径/图生视频.mp4"

# 首尾帧：图片角色明确，后台等待云盘原片
npm run video:desktop -- generate "严格使用两张原图，从清晨自然过渡到星夜" \
  --first-frame "/完整路径/首帧.png" --last-frame "/完整路径/尾帧.png" \
  --model "Seedance 2.5" --duration 5 --ratio 9:16 \
  --timeout-seconds 900 --output "/完整路径/首尾帧视频.mp4"
```

快捷示例没有显式 key 时，CLI 自动创建；为了能在提交响应丢失时恢复，Agent 生产调用应像文生示例一样预先记录 `--key`。输出目录须存在；视频不会覆盖已有文件。stdout 为结果 JSON，stderr 为进度，重定向保存结果时勿把私有配置一起收集。

`generate` 等待任务完成再下载，输出含原 `task_id`、视频文件、云盘来源和预览信息。退出码 0 表示已完成并导出，2 表示需要按原任务继续处理，1 表示错误；退出码不等于上游是否停止，仍需阅读 JSON。

## 异步、恢复、取消与单独下载

```sh
# 立即获取任务编号，不等待生成结束
npm run video:desktop -- submit "严格使用原图，镜头缓慢推进" \
  --first-frame "/完整路径/首帧.png" --model "Seedance 2.5" \
  --duration 5 --ratio 9:16 --key "$ORBIT_REQUEST_KEY" --async

npm run video:desktop -- status TASK_ID --wait-seconds 30
# 暂停或提取失败时才主动刷新原任务
npm run video:desktop -- status TASK_ID --refresh
# 等待超时、刷新或重启以后恢复：不再传提示词或原图
npm run video:desktop -- generate --task TASK_ID --output "/完整路径/恢复导出.mp4"
npm run video:desktop -- cancel TASK_ID
# 任务完成后，使用返回的 videos[0].id
npm run video:desktop -- download VIDEO_ID "/完整路径/导出原片.mp4"
```

底层 `recover CONVERSATION_ID RUN_ID` 只用于本地任务记录缺失但仍保存了原 conversation/run 的诊断恢复；有 task_id 优先恢复 task。不要用 recover 创建新会话或重发提示词。

读取 `status/phase/error/next_action/cancellation`。unknown 不自动重发；等待确认时优先让后台监控处理，不能为同一条视频反复点生成。

## 外接生图与真正的参考图编辑

先按 [operations.md](operations.md) 配置外部服务。此项目使用 Images API，不是把图片提示词发到聊天模型。

```sh
# 生成图片：输出可作为下一步首帧
npm run image:desktop -- "原创山海经白鹿，云海日出，电影分镜构图" \
  --provider openai-compatible --model gpt-image-2.5 --ratio 9:16 \
  --key "$ORBIT_REQUEST_KEY" --output-dir "/完整路径/新图片目录"

# 参考原图编辑：真正上传原图字节，最多 8 张，参数可重复
npm run image:desktop -- "保留人物与构图，只把窗外光线改成星夜紫色" \
  --provider openai-compatible --model gpt-image-2.5 --ratio 9:16 \
  --reference-image "/完整路径/首帧.png" \
  --output-dir "/完整路径/尾帧输出目录"

# 豆包客户端生图；型号先从 providers 返回值中选择
npm run image:desktop -- "原创山海经白鹿，电影分镜构图" \
  --provider doubao-desktop --model "Seedream 4.5" --ratio 9:16

npm run image:desktop -- --task IMAGE_TASK_ID
npm run image:desktop -- cancel IMAGE_TASK_ID
```

两个图片生成是独立任务，勿共享同一个 key。取结果的 `images[0].file` 或 `media_path/path`，直接传给视频 `--first-frame/--last-frame`。结果保存父参考资产、hash、请求模型及模型核验等级。外接同步服务超时可读本地记录，但没有上游查询或取消能力；不要把图片恢复命令理解为保证取回未知结果。

## CLI 画布镜头

```sh
# 准备草稿，不生成
npm run video:desktop -- scene "蓝色窗光过渡为紫色，人物构图保持不变" \
  --title "窗光过渡" --first-frame "/完整路径/首帧.png" \
  --last-frame "/完整路径/尾帧.png" --model "Seedance 2.5" \
  --duration 5 --ratio 9:16 --key "$ORBIT_REQUEST_KEY"

npm run video:desktop -- scenes CANVAS_ID
npm run video:desktop -- generate --canvas CANVAS_ID --card CARD_ID \
  --output "/完整路径/画布原片.mp4"
```

scene 返回 canvas/card 和画布链接。传 `--canvas` 追加镜头，再传 `--card` 修改未提交镜头；已提交输入冻结。canvas/card 生成使用保存的提示词和帧，不能同时传帧、模型、时长或比例覆盖。

本 Skill 便携助手可替换 npm 命令：`node /Skill目录/scripts/orbit.mjs --project /项目目录 video ...`，图片用 image，清单用 workflow。委托命令的相对路径以项目为基准，建议图片、输出和清单都用完整路径。
