# Neura

Neura 是一个无 UI 优先、长期运行的个人智能体运行时原型。

当前 MVP 已跑通：

- CLI 输入插件
- Webhook 输入插件
- 文件夹监听输入插件
- Agent Loop 基础处理
- 模型推理抽象，支持 DeepSeek OpenAI-compatible 和 Anthropic-compatible 入口
- 摘要与标签生成
- 长期记忆判断、写入、相似记忆更新
- SQLite 本地存储
- CLI 输出插件
- 插件状态查看
- 运行时状态与日志

## 使用

```bash
npm run neura -- status
npm run neura -- input "我想做一个常驻运行的智能体"
npm run neura -- memory list
npm run neura -- memory search "智能体"
npm run neura -- plugins list
npm run neura -- inputs list
npm run neura -- tasks list
npm run neura -- tools list
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

如果没有配置 API key，运行时会自动 fallback 到本地 `rule-based` provider。

模型接入使用官方/开源 SDK：

- `openai` + `zodResponseFormat` 处理 OpenAI-compatible 结构化输出
- `@anthropic-ai/sdk` + tool use 处理 Anthropic-compatible 结构化输出
- `zod` 负责结构校验

运行时也尽量使用成熟库：

- `commander` 处理 CLI
- `fastify` 处理 Webhook HTTP 服务
- `chokidar` 处理文件夹监听
- `dotenv` 处理本地环境变量
- `node:sqlite` 处理 SQLite 存储，避免 shell 调用和手写数据库驱动

Agent Loop 会先拿到统一的分析结果：

- 摘要
- 标签
- 是否值得记忆
- 重要性
- 置信度
- 是否输出

写入记忆前，Neura 会搜索相似记忆。重复或高度相似的输入会更新已有记忆，而不是不断新增。

## Webhook 输入

启动 Runtime 后，可以向本地 Webhook 发送输入：

```bash
npm run neura -- start
curl -X POST http://127.0.0.1:8787/input \
  -H 'Content-Type: application/json' \
  -d '{"type":"text","content":"这是一条来自 Webhook 的输入"}'
```

受限沙箱可能不允许监听端口；这种情况下插件会被标记为 `error`，Runtime 会继续运行。

## 文件夹监听

启动 Runtime 后，把 `.txt`、`.md`、`.json` 文件放入 `data/inbox/`，Neura 会自动处理。
