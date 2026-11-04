---
description: "在工具参数无效或待办未完成证据存在时，显式启用的有界 Agent 恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-task-recovery

[English](README.md) | 中文

## 概述

这个实验性、显式启用的插件会在仍有可观察未完成工作时避免 turn 静默结束。它绝不改写工具参数、重放工具或修改 agent loop，也不被默认 profile 启用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

只在需要有界恢复的组合中显式挂载：

```yaml
- name: '@deepseek-ai/dsh-agent-task-recovery'
  config:
    maxInvalidCalls: 3
    maxContinuations: 1
```

| 字段 | 默认值 | 可接受值 | 含义 |
|---|---:|---|---|
| `maxInvalidCalls` | `3` | 整数 >= 1 | 一个 turn 内触发 hook 取消前允许的无效参数结果数 |
| `maxContinuations` | `1` | 整数 >= 1 | 普通文本结束且仍有可观察未完成工作时允许的继续次数 |

无效配置会在插件加载时失败。对自主任务，如希望其报告可观察未完成工作、而非在普通文本响应后结束，就挂载该插件。若每次普通文本结束都必须最终结束，无论是否有无效参数或待办证据，则不要挂载。

插件会在 `INVALID_ARGS` 结果后加入纠正上下文，但绝不改写或重放失败调用。只有当前 turn 有未解决的无效参数或成功 `todo_write` 中的待办未完成项时才会继续，并且普通文本结束后的继续最多为 `maxContinuations` 次。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件拥有一个 `WeakMap<Agent, TurnState>`。当 `agent/pre-step` 报告新 turn 时，它会创建新状态，因此中途用户消息不会重置当前 turn 的计数。

`tools/post-execute` 会为非终止的 `INVALID_ARGS` 结果提供带来源标签的纠正上下文。`tools/result` 观察最终结果：它计数无效参数，在同名工具成功后清除标记，并只从完整有效的 `todo_write` 负载接受待办未完成项。达到无效调用上限时会以 hook 原因取消。

在 `agent/turn-stopping`，只有普通文本结束且没有排队工作时才可获得继续。权限拒绝、其他工具错误、`concludesTurn`、token 耗尽、用户取消和取消信号都会保持正常停止处理。短文本停止识别只是便利功能；取消信号才是权威机制。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 可观察未完成工作后的恢复上下文

#### 模型看到什么

非终止 `INVALID_ARGS` 结果之后，下一次请求会收到带来源标签的纠正消息，说明调用未被改写或重放，并要求模型读取前一条错误和当前 schema。符合条件的普通文本结束时，模型可能改为收到一条带来源标签的未完成工作继续消息。插件不添加工具 schema，也不修改正常工具调用内容。

#### Token 影响

每条纠正或继续消息都会作为下一次请求的保留历史。纠正只会出现在配置的无效调用终止结果之前；每个 turn 的继续数受 `maxContinuations` 限制。

#### KV Cache 影响

上下文追加在已有历史之后，保留此前可复用的前缀。新注入的纠正或继续只会改变下一次请求的后缀；提供方的缓存可用性和逐出不属于本包职责。

## 已知限制与延期工作

- **仅限可观察证据**——只有最终 `INVALID_ARGS` 结果和完整成功的 `todo_write` 负载能让 turn 保持活动；插件不判断业务、代码或工具结果是否正确。
- **同名成功的证据有限**——成功调用会清除该工具的无效参数标记，但不能证明更大的任务已经完成。
- **文本停止识别不完整**——它只识别少量明确的停止短语；集成方必须使用 Agent 取消信号作为权威取消方式。
- **需要当前 hook 可用**——最终结果跟踪依赖公开的 `tools/result` 事件；不为缺少该事件的运行时提供兼容。
- **消费者工作仍在包外**——profile 组合、UI 暴露、安装和真实模型验收不由本包提供。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
