# Neura

Neura 是一个无 UI 优先、长期运行的个人智能体运行时原型。

当前 MVP 已跑通：

- CLI 输入插件
- CLI 图片输入
- Webhook 输入插件
- 文件夹监听输入插件
- 截图目录监听输入插件
- Agent Loop 基础处理
- 模型推理抽象，支持 DeepSeek OpenAI-compatible 和 Anthropic-compatible 入口
- 摘要与标签生成
- 长期记忆判断、写入、相似记忆更新
- LangChain 记忆检索
- SQLite 本地存储
- CLI 输出插件
- 系统通知输出插件
- 前端管理插件，支持 Agent、插件、记忆、审批和定时任务管理
- 高风险操作审批流
- 定时提醒与周期输入调度
- 多 Agent 数据隔离与切换
- 插件状态查看
- 运行时状态与日志

当前代码栈已收敛为：

- TypeScript
- Bun Runtime
- `bun:sqlite` 本地存储

## 架构文档

如果目标是尽快完整理解整个项目，优先阅读：

- [docs/project-architecture.md](/Users/gengyu/github/neura/docs/project-architecture.md)
- [docs/product-logic-coverage.md](/Users/gengyu/github/neura/docs/product-logic-coverage.md)

## 使用

```bash
cp .env.example .env
pnpm install
pnpm run doctor
bun run neura -- status
bun run neura -- input "我想做一个常驻运行的智能体"
bun run neura -- input-file ./docs/project-architecture.md
bun run neura -- input-url https://example.com "收藏这个链接"
bun run neura -- input-image ./data/screenshots/demo.png
bun run neura -- memory list
bun run neura -- memory search "智能体"
bun run neura -- memory edit <memoryId> --summary "新的摘要"
bun run neura -- memory merge <targetMemoryId> <sourceMemoryId> --yes
bun run neura -- memory delete <memoryId> --yes
bun run neura -- memory import ./exports/neura-memories.json --yes
bun run neura -- agents list
bun run neura -- agents create "Research Agent" --id research-agent
bun run neura -- agents use research-agent
bun run neura -- plugins list
bun run neura -- inputs list
bun run neura -- tasks list
bun run neura -- tools list
bun run neura -- approvals list
bun run neura -- schedules add --mode reminder --in 10m "十分钟后提醒我回来看 Neura"
bun run neura -- schedules list
bun run neura -- model doctor
bun run neura -- model test
bun run neura -- config
```

也可以启动常驻运行时：

```bash
bun run start
bun run status
bun run stop
```

## 本地生产部署

Neura v1 的推荐形态是本地终端部署：数据默认写入本机 SQLite，不需要云账号。

```bash
cp .env.example .env
# 编辑 .env，至少配置 DEEPSEEK_API_KEY 或切换 NEURA_MODEL_PROVIDER=mock 做本地试用
pnpm install
pnpm test
pnpm run doctor
pnpm run model:doctor
pnpm start
```

如果希望在任意终端直接使用 `neura`：

```bash
pnpm run install:local
neura doctor
neura start
```

长期运行前建议确认：

- `pnpm run doctor` 没有高风险 `WARN`
- `NEURA_REQUIRE_CONFIRMATION=true`
- `NEURA_ALLOW_COMMAND_EXECUTION=false`，除非你明确需要 shell 工具
- Webhook/Admin 默认绑定 `127.0.0.1`；如果改成外部可访问地址，请配置 `NEURA_WEBHOOK_TOKEN` / `NEURA_ADMIN_TOKEN`
- 数据库和日志目录纳入你自己的本地备份策略

常用数据维护命令：

```bash
neura backup create
neura backup list
neura memory export --format md
neura memory export --format json
neura memory import ./exports/neura-memories-default-agent.json --yes
```

## npm 包发布

发布前先确认包内容和验收测试：

```bash
pnpm run release:check
pnpm run pack:npm
```

正式发布：

```bash
pnpm run publish:npm
```

如果后续改成 scoped 包并需要公开发布，可以使用：

```bash
pnpm run publish:npm:public
```

npm 包通过 `files` 白名单发布源码和运行所需资源，不会包含 `data/`、`logs/`、`backups/`、`exports/` 或 `.env`。

## 数据

本地数据写入：

- `data/neura.db`
- `logs/neura.log`
- `logs/neura-output.log`

## 大输入与成本控制

Neura 不会默认把大文件、大段文本或大文件夹内容一次性塞进模型上下文。输入会先经过本地预算层：

- 长文本/大文件会生成前后片段预览和本地分块索引。
- 超过 `NEURA_MAX_FILE_READ_BYTES` 的文件只读取预算内字节。
- PDF、Office 等二进制文档默认只记录元信息，不做高 token 深度解析。
- URL 默认只记录链接和说明，不自动抓取网页正文。
- 文件夹监听按文件逐个处理，单个文件仍受同一预算限制。

可通过 `.env` 调整：

```bash
NEURA_MAX_MODEL_INPUT_CHARS=24000
NEURA_MAX_FILE_READ_BYTES=512000
NEURA_INGEST_CHUNK_CHARS=6000
NEURA_INGEST_MAX_CHUNKS=12
```

## 说明

本项目按 PRD 先实现最小闭环：

```text
输入插件 -> Neura Runtime -> Agent Loop -> 记忆 -> 输出插件
```

工具系统和更复杂的模型推理接口已经保留模块位置，后续可以继续扩展 Webhook、文件夹监听、截图监听和真实模型调用。

## 当前推理与记忆策略

`packages/model` 提供模型 provider 抽象。当前默认配置为 DeepSeek：

- OpenAI-compatible base URL: `https://api.deepseek.com`
- Anthropic-compatible base URL: `https://api.deepseek.com/anthropic`
- 默认模型：`deepseek-chat`
- API key 环境变量：`DEEPSEEK_API_KEY`

为了让验收不依赖外网，项目也内置了 `mock` provider：

- `bun test` 默认走 `NEURA_MODEL_PROVIDER=mock`
- 真实运行时仍然可以继续使用 `.env` 中配置的 DeepSeek / OpenAI-compatible / Anthropic-compatible API

如果没有配置 API key，只有在真正处理需要模型推理的输入时才会失败；状态查看、插件查看等非推理命令不再被模型初始化阻塞。

模型接入使用官方/开源 SDK：

- `openai` + `zodResponseFormat` 处理 OpenAI-compatible 结构化输出
- `@anthropic-ai/sdk` + tool use 处理 Anthropic-compatible 结构化输出
- `zod` 负责结构校验

运行时也尽量使用成熟库：

- `commander` 处理 CLI
- `fastify` 处理 Webhook HTTP 服务
- `chokidar` 处理文件夹监听
- `dotenv` 处理本地环境变量
- `bun:sqlite` 处理 SQLite 存储

Agent Loop 会先用本地向量索引检索相关记忆，并把 `relatedMemories` 作为模型上下文传入。模型仍可继续调用 `search_memory` 工具补充上下文，但已有相关记忆时不会重复进行硬性检索。

Agent Loop 现在会先把不同来源的输入标准化成统一画像，再交给模型判断。标准化结果会包含：

- 输入场景，例如 `idea_capture`、`webhook_event`、`screenshot_capture`、`file_ingest`
- 统一文本内容
- 关键词
- 文件/图片描述
- 用户是否主动请求回应、是否像提醒、是否像偏好或决策等信号

模型会返回更完整的结构化分析结果，而不只是简单摘要：

- 摘要
- 标签
- 任务类型，例如 `query`、`action_request`、`reminder`、`knowledge_ingest`
- 分类与意图
- 是否值得记忆、记忆类型、记忆动作倾向
- 重要性
- 置信度
- 是否输出、输出类型、输出原因
- 提取出的关键事实

如果真实模型分析失败，Agent Loop 会自动退回到启发式兜底分析，保证任务尽量继续完成，而不是整个输入直接失败。

输出阶段也不再默认广播到所有输出插件，而是会按任务类型和输入来源路由：

- CLI 查询/请求优先走 `cli-output`
- 提醒类任务优先走系统通知
- Webhook / 后台事件更偏向管理端与日志
- 文件日志输出默认保留，用于追踪结果

当输入为图片时，provider 会把图片文件连同文字上下文一起发送给模型做分析。

写入记忆前，Neura 会搜索相似记忆。重复或高度相似的输入会更新已有记忆，而不是不断新增。

记忆检索使用 `natural` 做分词/词干处理，并通过 `cosine-similarity` 对本地哈希向量排序；如果没有命中，再退回 SQLite LIKE 检索。

## Webhook 输入

启动 Runtime 后，可以向本地 Webhook 发送输入：

```bash
bun run start
curl -X POST http://127.0.0.1:8787/input \
  -H 'Content-Type: application/json' \
  -d '{"type":"text","content":"这是一条来自 Webhook 的输入"}'
```

受限沙箱可能不允许监听端口；这种情况下插件会被标记为 `error`，Runtime 会继续运行。

## 前端管理

启动 Runtime 后，打开本地管理界面：

```bash
bun run start
open http://127.0.0.1:8790
```

管理界面由 `admin-ui-output` 插件提供，可以查看状态、切换/创建 Agent、提交输入、启停插件、搜索记忆、处理审批、创建定时任务，并查看输入、任务、输出、日志和工具调用详情。

如果配置了 `NEURA_ADMIN_TOKEN`，首次打开可以使用：

```bash
open "http://127.0.0.1:8790?token=$NEURA_ADMIN_TOKEN"
```

## 文件夹监听

启动 Runtime 后，把 `.txt`、`.md`、`.json`、`.js`、`.ts`、`.pdf` 和图片文件放入 `data/inbox/`，Neura 会自动处理。

## 截图监听

启动 Runtime 后，把截图文件放入 `data/screenshots/`，Neura 会按图片输入处理。

## 高风险动作审批

当模型尝试执行命令、删除文件或覆盖已有文件时，Neura 会先创建待审批请求：

```bash
bun run neura -- approvals list
bun run neura -- approvals approve <requestId>
bun run neura -- approvals reject <requestId>
```

## 定时任务

Neura 支持一次性提醒和周期性输入：

```bash
bun run neura -- schedules add --mode reminder --in 30m "提醒我整理今天的设计结论"
bun run neura -- schedules add --mode input --every 1d --at 2026-05-06T09:00:00+08:00 "检查昨天新增的截图和网页收藏"
bun run neura -- schedules list
```
