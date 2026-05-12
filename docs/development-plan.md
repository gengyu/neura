# Neura 开发任务规划

本文档用于承接 `prd.md` 中已经确定的架构语义，并拆解下一阶段开发任务。

当前核心方向：

```text
输入负责进入
记忆负责沉淀
输出负责表达
Runtime 负责判断
```

Neura 不应该继续被实现成“输入处理后必然输出”的流水线。

输入插件和输出插件是 Neura Runtime 面向外部世界的两个独立接口方向。

---

# 1. 开发目标

下一阶段开发目标是让代码实现贴合新的 Runtime 模型：

```text
输入闭环：
输入插件 -> Neura Runtime -> Agent Loop -> 记忆 / 状态 / 日志

输出闭环：
Neura Runtime -> 输出决策 -> OutputEvent -> 输出插件 -> 外部世界
```

关键变化：

```text
InputEvent 不必然产生 OutputEvent
OutputEvent 不必须关联 InputEvent
Task 不必须来自 InputEvent
Agent Loop 以记忆沉淀为中心
输出决策由 Runtime 独立负责
```

---

# 2. 任务 1：调整数据模型

涉及文件：

```text
packages/storage/sqlite.ts
packages/storage/repository.ts
packages/shared/types.ts
```

## 2.1 Task 来源字段

当前 `tasks` 表主要围绕 `input_event_id` 建模。

需要演进为：

```text
source_type
source_id
```

建议兼容式处理：

```text
input_event_id 可保留但必须允许为空
新增 source_type
新增 source_id
```

字段含义：

```text
source_type = input_event | schedule | runtime_state | approval | memory_review | manual | internal
source_id = 对应来源 ID，可为空
```

目标：

```text
Task 可以来自 InputEvent
Task 也可以来自 Runtime 内部行为
Task 可以来自 schedule、approval、memory_review、manual 等来源
```

## 2.2 OutputEvent 来源字段

`output_events` 表增加：

```text
source_type
source_id
```

字段含义：

```text
source_type = runtime_state | schedule | memory_review | approval | manual | input_event | task
source_id = 对应来源 ID，可为空
```

目标：

```text
OutputEvent 可以追踪来源
OutputEvent 不强制依赖 InputEvent
Schedule / approval / runtime_state 可以直接成为输出来源
```

验收点：

```text
Task 可以没有 inputEventId
OutputEvent 可以没有 inputEventId
OutputEvent 可以保存 sourceType/sourceId
```

---

# 3. 任务 2：改造 Repository 接口

涉及文件：

```text
packages/storage/repository.ts
```

## 3.1 createTask

当前调用形式类似：

```ts
createTask(inputEvent.id, "agent_loop")
```

建议改成：

```ts
createTask({
  sourceType: "input_event",
  sourceId: inputEvent.id,
  type: "agent_loop"
})
```

内部任务示例：

```ts
createTask({
  sourceType: "schedule",
  sourceId: schedule.id,
  type: "schedule_reminder"
})
```

## 3.2 createOutputEvent

建议调用形式：

```ts
createOutputEvent({
  pluginId,
  sourceType,
  sourceId,
  type,
  content,
  status
})
```

验收点：

```text
输入事件仍能创建 agent_loop task
内部任务也能创建 task
输出事件可以追踪来源
输出事件不依赖输入事件
```

---

# 4. 任务 3：Agent Loop 改成记忆中心

涉及文件：

```text
packages/core/agent-loop.ts
packages/core/decision-engine.ts
packages/memory/memory-writer.ts
packages/core/capture-result.ts
```

## 4.1 当前问题

当前 Agent Loop 中仍然包含输出路由和输出派发语义。

需要避免这种隐含模型：

```text
InputEvent -> Agent Loop -> OutputEvent
```

## 4.2 目标流程

Agent Loop 应改成：

```text
InputEvent
-> Normalize
-> Recall
-> MemoryDecision
-> ToolStep / ApprovalPause
-> MemorySynthesis
-> MemoryWrite
-> TaskFinalize
```

核心产物是：

```text
处理状态
摘要
标签
记忆动作
任务状态变化
必要的 outputHints
```

注意：

```text
outputHints 不是 OutputEvent
outputHints 只表示 Runtime 后续可以参考的信息
```

## 4.3 需要移出的逻辑

从 `agent-loop.ts` 中移出或弱化：

```ts
const outputPlan = buildOutputPlan(...)
await this.outputDispatcher(...)
repository.createOutputEvent(...)
```

Agent Loop 可以返回：

```ts
{
  taskResult,
  memoryAction,
  memoryId,
  stateChanges,
  outputHints
}
```

但不能默认创建 OutputEvent。

验收点：

```text
普通想法输入只写记忆，不创建 OutputEvent
Agent Loop 完成后 Task 状态正常
记忆仍能创建 / 更新 / 跳过
```

---

# 5. 任务 4：新增 Output Decision 模块

新增文件：

```text
packages/core/output-decision.ts
```

## 5.1 职责

`output-decision` 负责独立判断 Runtime 是否需要表达。

它不属于输入事件处理流程的必经步骤。

它可以根据 Runtime 内部状态独立运行。

## 5.2 输入结构

建议输入：

```ts
{
  sourceType,
  sourceId,
  eventType,
  taskResult,
  runtimeState,
  schedule,
  approval,
  memoryReview
}
```

## 5.3 输出结构

建议输出：

```ts
{
  shouldOutput: boolean,
  outputType: "answer" | "summary" | "reminder" | "confirmation_request" | "error" | "status_report",
  reason: string,
  priority: "low" | "medium" | "high",
  preferredPluginIds: string[]
}
```

## 5.4 基础规则

```text
approval pending -> 输出确认请求
schedule reminder -> 输出提醒
runtime error -> 输出错误
manual output request -> 输出
普通 memory capture -> 不输出
```

验收点：

```text
输出判断可以在没有 InputEvent 的情况下运行
普通输入不会默认输出
提醒 / 审批 / 错误可以独立输出
```

---

# 6. 任务 5：调整 Output Routing 和 Dispatcher

涉及文件：

```text
packages/core/output-routing.ts
packages/core/output-dispatcher.ts
```

## 6.1 模块分工

新的分工：

```text
output-decision.ts
判断要不要输出

output-routing.ts
判断 OutputEvent 发到哪里

output-dispatcher.ts
负责实际发送
```

## 6.2 改造目标

`output-routing` 不再负责判断是否应该输出。

它只回答：

```text
这个 OutputEvent 应该交给哪些输出插件
```

`output-dispatcher` 不关心 OutputEvent 来源。

它只负责：

```text
接收 OutputEvent
选择可用输出插件
调用插件发送
记录发送状态
```

验收点：

```text
OutputDispatcher 不读取 InputEvent 必要字段
OutputRouting 可以处理 sourceType=schedule 的 OutputEvent
OutputRouting 可以处理 sourceType=approval 的 OutputEvent
```

---

# 7. 任务 6：Runtime 增加内部任务入口

涉及文件：

```text
packages/core/runtime.ts
```

## 7.1 新增内部任务能力

建议新增：

```ts
async runInternalTask(type, content, options = {}) {
  const task = repository.createTask({
    sourceType: options.sourceType ?? "internal",
    sourceId: options.sourceId ?? null,
    type
  })

  // 根据 type 进入 schedule / approval / memory_review / status_report 等处理
}
```

也可以先做更小接口：

```ts
async emitOutput(source, content) {
  const decision = buildOutputDecision(source)
  if (!decision.shouldOutput) return null

  const outputEvent = repository.createOutputEvent(...)
  await outputDispatcher.send(outputEvent)
  return outputEvent
}
```

验收点：

```text
Runtime 可以不经过 input() 也创建 OutputEvent
Runtime 可以以 schedule / approval / runtime_state 作为来源表达信息
```

---

# 8. 任务 7：Schedule 改造

涉及文件：

```text
packages/core/schedule-manager.ts
packages/storage/repository.ts
packages/core/output-decision.ts
```

## 8.1 reminder 模式

当前 reminder 不应该伪装成输入事件。

目标流程：

```text
schedule due
-> create Task(sourceType=schedule, sourceId=schedule.id)
-> build output decision
-> create OutputEvent(sourceType=schedule, sourceId=schedule.id)
-> dispatch
-> mark schedule run
```

验收点：

```text
提醒可以在没有新 InputEvent 的情况下输出
OutputEvent.sourceType = schedule
OutputEvent.sourceId = schedule.id
```

## 8.2 input 模式

`mode=input` 可以继续进入输入闭环：

```text
schedule
-> runtime.input(..., internal=true)
```

但要明确：

```text
mode=input 是主动生成内部输入
mode=reminder 是 Runtime 输出表达
```

---

# 9. 任务 8：Approval 改造

涉及文件：

```text
packages/tools/tools.ts
packages/storage/repository.ts
packages/core/output-decision.ts
```

## 9.1 当前行为

高风险工具会返回：

```ts
confirmationRequired: true
```

## 9.2 目标行为

approval 应该成为 Runtime 内部状态来源。

建议流程：

```text
createConfirmationRequest
-> create Task(sourceType=approval, sourceId=request.id, type=approval_required)
-> output decision
-> OutputEvent(sourceType=approval, sourceId=request.id)
```

验收点：

```text
高风险动作不会直接执行
会产生 confirmation request
必要时产生 OutputEvent
OutputEvent 不依赖原始输入
```

---

# 10. 任务 9：CLI 体验层单独处理

涉及文件：

```text
bin/neura.ts
plugins/inputs/cli-input/plugin.ts
plugins/outputs/cli-output/plugin.ts
```

## 10.1 需要区分两个概念

架构语义：

```text
输入不必然输出
```

命令体验：

```text
用户执行 neura input 后，可以在终端看到处理摘要
```

CLI 命令可以打印 `runtime.input()` 的返回结果。

但这不代表 Runtime 创建了 OutputEvent。

建议在代码和文档中区分：

```text
command response
OutputEvent
```

验收点：

```text
neura input 仍可在终端看到处理结果
普通输入不会额外创建 OutputEvent
```

---

# 11. 任务 10：测试补齐

涉及文件：

```text
scripts/smoke-test.ts
tests/*
```

建议新增场景：

```text
普通想法输入 -> 写入记忆 -> 不创建 OutputEvent
用户明确查询 -> 可以产生命令响应，但 Runtime 不默认绑定 OutputEvent
schedule reminder -> 无 InputEvent -> 创建 OutputEvent
approval request -> sourceType=approval -> 创建 OutputEvent
Task sourceType/sourceId 正确保存
OutputEvent sourceType/sourceId 正确保存
```

---

# 12. 建议开发顺序

第一批最小改动：

```text
1. SQLite schema 增加 source_type/source_id
2. Repository createTask/createOutputEvent 改造
3. Agent Loop 移除直接 dispatch output
4. 新增 output-decision.ts
5. Schedule reminder 走独立 OutputEvent
6. 补 smoke test
```

这批做完后，Neura 的代码语义应该变成：

```text
输入负责进入
记忆负责沉淀
输出负责表达
Runtime 负责判断
```
