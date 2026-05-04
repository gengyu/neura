# Neura

Neura 是一个无 UI 优先、长期运行的个人智能体运行时原型。

当前 MVP 已跑通：

- CLI 输入插件
- Agent Loop 基础处理
- 模型推理抽象，默认使用本地规则 provider
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

`packages/model` 提供模型 provider 抽象。当前默认是 `rule-based`，不需要网络，也不需要 API key。

Agent Loop 会先拿到统一的分析结果：

- 摘要
- 标签
- 是否值得记忆
- 重要性
- 置信度
- 是否输出

写入记忆前，Neura 会搜索相似记忆。重复或高度相似的输入会更新已有记忆，而不是不断新增。
