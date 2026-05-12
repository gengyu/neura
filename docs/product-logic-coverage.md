# Neura Product Logic Coverage

Neura 的本地终端产品闭环按下面业务分支验收。任何发布都应至少通过 `pnpm test`，并在改动相关模块时补充对应分支的 smoke case。

## 1. 配置与启动

- 配置来源：终端环境变量 > `.env.local` > `.env` > 默认配置。
- 模型配置：支持 `mock`、`deepseek`、`openai-compatible`、`anthropic-compatible`、`deepseek-anthropic`。
- 模型诊断：`neura model doctor` 不发起模型请求，只检查 provider、model、API key、base URL、timeout 和明显错配。
- 模型连通：`neura model test` 发起最小请求，验证真实 provider 能完成一次调用。
- 本地部署检查：`neura doctor` 必须覆盖数据库、模型 key、Webhook/Admin 暴露面、高风险审批、Shell 权限。
- 常驻运行：`neura start/status/stop` 必须维护 runtime heartbeat、PID、插件状态和错误日志。

## 2. 输入分支

- CLI 文本：直接进入 Agent Loop，默认需要用户可见处理结果。
- CLI 图片：携带图片路径、mime、备注，由模型分析视觉上下文。
- CLI 文件：读取预算内文本，超长文件走预览/分块策略，二进制文档默认只记录元信息。
- CLI URL：默认只记录链接和说明，不自动抓取网页正文，避免隐形网络与 token 消耗。
- Webhook：支持 text/event/image payload，记录来源并脱敏敏感 header。
- 文件夹监听：支持文本、代码、JSON、PDF 元信息和图片文件。
- 大文件夹：按文件逐个处理，不把文件夹整体作为一次模型上下文。
- 截图监听：按视觉捕获处理，形成截图上下文。
- 定时输入：由 schedule manager 以内置输入源回放。

## 3. 分析与决策

- 标准化：每个输入都要形成 `scenario`、`taskType`、关键词、信号、检索查询。
- 预算控制：任何超长输入进入模型前必须经过 ingest budget，形成预算内 `modelContent`、预览、分块索引和用户可见 warning。
- 模型分析：真实模型优先结构化输出；失败时必须有启发式兜底，不能轻易丢输入。
- 决策类型：至少覆盖捕获、记忆、当前总结、历史查询、提醒、行动请求、事件、文件、图片、决策、偏好。
- 输出克制：普通沉淀不广播；查询、提醒、审批、错误和主动请求才输出。

## 4. 记忆分支

- 写入：只有长期价值输入写入记忆，原始输入不等于记忆。
- 更新：相似记忆应合并/更新，避免重复堆积。
- 跳过：低价值、临时或已处理内容可以跳过，但要在记录里可追踪。
- 来源：每条记忆必须保留 `sourceType/sourceId/sourceInputId`。
- 用户维护：支持标签更新、导出、备份、归档记录。
- 用户纠错：支持编辑记忆摘要/内容/标签/重要性/置信度。
- 用户清理：支持删除错误记忆，合并重复或相近记忆，破坏性操作必须显式确认。
- 数据迁移：支持 JSON 导出后重新导入，导入时应尽量更新相似记忆而不是制造重复。

## 5. 检索分支

- 查询构造：结合标题、场景、任务类型、关键词和正文构造 recall query。
- 混合召回：使用语义哈希向量、关键词 IDF、短语命中、标签命中、文本相似度。
- 重排：结合重要性和更新时间，让高价值且近期的相关记忆更靠前。
- 可解释：CLI 搜索结果必须显示相关性分数和命中原因。
- 兜底：无向量命中时回退 SQLite LIKE 检索。

## 6. 定时任务分支

- 自然语言提醒：支持相对时间、明天/今晚/下周、月日和 ISO 时间。
- 周期任务：支持每天/每周/每月近似周期。
- 到期提醒：输出到系统通知/CLI/日志，并记录任务来源。
- 到期输入：以内置输入插件重新进入 Agent Loop。
- 状态管理：支持 active、paused、completed、delete。

## 7. 工具与审批

- 高风险动作：覆盖写已有文件、删除文件、执行命令。
- 默认策略：本地生产默认禁用 Shell；文件覆盖和敏感路径需要审批。
- 审批结果：批准后执行，拒绝后记录 rejected tool call。
- 通知：待审批必须产生可见输出和任务记录。

## 8. 输出分支

- 路由：根据任务来源、输出类型和优先级选择 CLI、日志、系统通知、Admin。
- 本地日志：所有输出和 runtime 日志落盘，便于诊断。
- Admin UI：用于观察和控制，不是核心产品本体。

## 9. 数据与发布

- SQLite：启用 WAL、busy timeout、索引和 schema migration 记录。
- 备份：`neura backup create/list` 可用。
- 导出：`neura memory export --format md|json` 可用。
- 导入：`neura memory import <json> --yes` 可用。
- npm 发布：`pnpm run pack:npm` 必须通过 release check，包内容不得包含本地数据。
