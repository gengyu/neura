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
- 向量化记忆检索与记忆索引重建
- SQLite 本地存储
- CLI 输出插件
- 系统通知输出插件
- 前端管理插件，支持 Agent、插件、记忆、审批和定时任务管理
- 高风险操作审批流
- 定时提醒与周期输入调度
- 多 Agent 数据隔离与切换
- 插件状态查看
- 运行时状态与日志

## 使用

```bash
npm run neura -- status
npm run neura -- input "我想做一个常驻运行的智能体"
npm run neura -- input-image ./data/screenshots/demo.png
npm run neura -- memory list
npm run neura -- memory search "智能体"
npm run neura -- memory reindex
npm run neura -- agents list
npm run neura -- agents create "Research Agent" --id research-agent
npm run neura -- agents use research-agent
npm run neura -- plugins list
npm run neura -- inputs list
npm run neura -- tasks list
npm run neura -- tools list
npm run neura -- approvals list
npm run neura -- schedules add --mode reminder --in 10m "十分钟后提醒我回来看 Neura"
npm run neura -- schedules list
npm run neura -- config
```

也可以启动常驻运行时：

```bash
npm run neura -- start
npm run neura -- status
npm run neura -- stop
```

## 数据

本地数据写入：

- `data/neura.db`
- `logs/neura.log`
- `logs/neura-output.log`

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

如果没有配置 API key，真实模型调用会直接失败；测试和运行时都会暴露这个问题。

模型接入使用官方/开源 SDK：

- `openai` + `zodResponseFormat` 处理 OpenAI-compatible 结构化输出
- `@anthropic-ai/sdk` + tool use 处理 Anthropic-compatible 结构化输出
- `zod` 负责结构校验

运行时也尽量使用成熟库：

- `commander` 处理 CLI
- `fastify` 处理 Webhook HTTP 服务
- `chokidar` 处理文件夹监听
- `dotenv` 处理本地环境变量
- `better-sqlite3` 处理 SQLite 存储，pnpm 仅允许它执行 native build script

Agent Loop 会先用本地向量索引检索相关记忆，并把 `relatedMemories` 作为模型上下文传入。模型仍可继续调用 `search_memory` 工具补充上下文，但已有相关记忆时不会重复进行硬性检索。

Agent Loop 会拿到统一的分析结果：

- 摘要
- 标签
- 是否值得记忆
- 重要性
- 置信度
- 是否输出

当输入为图片时，provider 会把图片文件连同文字上下文一起发送给模型做分析。

写入记忆前，Neura 会搜索相似记忆。重复或高度相似的输入会更新已有记忆，而不是不断新增。

记忆检索使用 `natural` 做分词/词干处理，并通过 `cosine-similarity` 对本地哈希向量排序；如果没有命中，再退回 SQLite LIKE 检索。

## Webhook 输入

启动 Runtime 后，可以向本地 Webhook 发送输入：

```bash
npm run neura -- start
curl -X POST http://127.0.0.1:8787/input \
  -H 'Content-Type: application/json' \
  -d '{"type":"text","content":"这是一条来自 Webhook 的输入"}'
```

受限沙箱可能不允许监听端口；这种情况下插件会被标记为 `error`，Runtime 会继续运行。

## 前端管理

启动 Runtime 后，打开本地管理界面：

```bash
npm run neura -- start
open http://127.0.0.1:8790
```

管理界面由 `admin-ui-output` 插件提供，可以查看状态、切换/创建 Agent、提交输入、启停插件、搜索记忆、重建记忆索引、处理审批、创建定时任务，并查看输入、任务、输出、日志和工具调用详情。

## 文件夹监听

启动 Runtime 后，把 `.txt`、`.md`、`.json`、图片文件放入 `data/inbox/`，Neura 会自动处理。

## 截图监听

启动 Runtime 后，把截图文件放入 `data/screenshots/`，Neura 会按图片输入处理。

## 高风险动作审批

当模型尝试执行命令、删除文件或覆盖已有文件时，Neura 会先创建待审批请求：

```bash
npm run neura -- approvals list
npm run neura -- approvals approve <requestId>
npm run neura -- approvals reject <requestId>
```

## 定时任务

Neura 支持一次性提醒和周期性输入：

```bash
npm run neura -- schedules add --mode reminder --in 30m "提醒我整理今天的设计结论"
npm run neura -- schedules add --mode input --every 1d --at 2026-05-06T09:00:00+08:00 "检查昨天新增的截图和网页收藏"
npm run neura -- schedules list
```
