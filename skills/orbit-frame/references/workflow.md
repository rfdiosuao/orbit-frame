# 从参考图到多镜头清单

使用数据清单保存图像依赖、首尾帧角色和镜头任务。由项目工作流负责自动导入、构建画布、等待依赖、持久化原请求和导出原片；Agent 不需要拖线或临时猜文件位置。

模板：`assets/existing-frames.manifest.json` 复用两张已有图片，仅需一条视频；`assets/reference-to-video.manifest.json` 复用首帧、外接编辑尾帧、再生成视频，通常需要两个新媒体任务。先复制到你的工作目录，替换真实图片路径再运行，保留原清单用于恢复。

## 数据契约

```json
{
  "project":"窗光过渡",
  "ratio":"9:16",
  "images":[
    {"image_id":"first","prompt":"已存在的原首帧","asset_paths":{"generated_image":"./first.png"}},
    {"image_id":"last","prompt":"人物和构图不变，只把蓝色窗光改成紫色星夜","provider":"openai-compatible","model":"gpt-image-2.5","required_reference_ids":["first"]}
  ],
  "shots":[
    {"shot_id":"transition","prompt":"严格使用首尾原图，窗光平滑过渡，保持人物服装和构图","first_frame_source":"first","last_frame_source":"last","model":"Seedance 2.5","duration":5}
  ]
}
```

image_id/shot_id 在同一清单中不能重名，支持字母、数字、下划线和连字符。images 每项和 shots 每项都需要非空 prompt。现成图片用 asset_paths.generated_image，也可写 asset_paths.sha256 固定素材身份；相对路径以清单所在目录为准。

参考图生图使用 required_reference_ids，每项最多 8 个引用，不能循环。视频用 first_frame_source/last_frame_source 引用图像 ID；一图自动图生、双图自动首尾帧，只有尾帧会拒绝。需要新图时明确 provider/model，不把型号藏在 prompt 中。

清单最多 1 MB、100 张图片、100 个镜头，同时受画布 500 卡、1000 连线的上限约束。准备后修改提示词、依赖、型号或镜头参数时另存新的清单路径，不复用原工作流冒充重试。

## CLI

```sh
npm run workflow -- preflight /完整路径/manifest.json
npm run workflow -- prepare /完整路径/manifest.json
# 默认最多 1 个新任务；下面允许尾帧编辑和一条视频，共 2 个
npm run workflow -- run /完整路径/manifest.json --live --max-new-tasks 2 --timeout-seconds 900
npm run workflow -- status /完整路径/manifest.json
npm run workflow -- cancel /完整路径/manifest.json
# 用户要求恢复后：保留原任务，预算只约束未开始的节点
npm run workflow -- run /完整路径/manifest.json --live --resume --max-new-tasks 1
npm run workflow -- export /完整路径/manifest.json
```

preflight 与 prepare 不消耗生成额度。预检的 ready 表示现有图片是否满足当前镜头，不代表 missing 图不能按依赖生成；需要编辑尾帧的模板可先 prepare，再在用户授权范围内 run。

run 默认 1 个、最大 5 个新媒体任务，图片和视频均计入；timeout_seconds 最大 3600。耗尽预算或等待超时后查询原工作流，下一次 run 延续原编号；不通过改清单或换 UUID 重发。cancel 先保存暂停状态，随后报告各已知上游任务的真实取消回执，不保证所有上游已停止。

## MCP

工具 manage_workflow：

```json
{"action":"preflight","manifest_path":"/完整路径/manifest.json"}
```

action 可为 preflight、prepare、run、status、pause、export。执行需要明确 live:true：

```json
{"action":"run","manifest_path":"/完整路径/manifest.json","live":true,"max_new_tasks":2,"timeout_seconds":900}
```

暂停用 pause，恢复用 run 加 resume:true；没有单独的 resume action。CLI 的 cancel 对应 MCP 的 pause。保存返回的 workflow_id、canvas_id 和 images/shots 下的 card_id、request/task 对应关系。

## 导出与交付

export 写入核验的云盘原镜头，以及 edit-manifest.json，包含实际文件、hash、时长、输入角色和任务编号。默认在项目 `data/exports/workflows`；MCP 可用启动环境的 ORBIT_FRAME_OUTPUT_DIR 调整导出基准。

只有 source_verification=matched_upload_path_and_size 的云盘原片才可交付。缺图、unknown、失败、未完成镜头保持原状态，不用普通视频卡补齐。导出只是原镜头与剪辑交接，不自动完成字幕、配音、音乐、转场或整片渲染。

本项目的多节点预算和恢复保护已做隔离测试，MCP 清单准备、幂等重复准备、状态与已完成原片导出已做真实验收；不能把这些记录当作任意大型新剧的生产通过。
