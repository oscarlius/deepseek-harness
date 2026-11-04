---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-05-agent-task-recovery-attribution

[English](2026-11-05-agent-task-recovery-attribution.md) | 中文

## 概述

为建议性的参数纠正与继续消息添加 agent-task-recovery 来源标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-agent-task-recovery-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "57bb1cfb9b7773b094a1460be63db617d081c311e2f4fa33a2faaf213b1e6525"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "46dc2e36e46e25eb743d8ae51dc18c624ba64d107319cd05f78b7d7c4ffebbc1"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "e07b30065b3f4199da2b3164d65d0fb1c610f2719b053dfb9d0368871e9f778c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "27d050da9dc5f2a3f755e04a77aea39462c44e59b6a2511c4282f0bf0d6f73e2"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有消息变体与 Session V4 信封不变，因此旧记录仍可读取。新记录携带普通 user 角色文本与 notice 元数据。未加载这个可选生产者的读取方会保留未知来源 kind 及 JSON 元数据，并派生已记录的文本；该来源标记不授予执行、重放、校验或权限能力。恢复状态只在内存中保存，不会由来源 kind 重建。生产者缺失时保持原有停止策略，无需增加写入版本。

<a id="verification"></a>
## 验证

本包的确定性 AgentLoop 与真实 Loader 组合测试通过，覆盖带生产者标记的纠正文本记录与插件卸载。Host 和 Client 聚合检查及构建产物的外部 NodeNext 消费者检查通过。未声称真实模型或已发布二进制验收通过。

<a id="dev-note"></a>
## 开发备注

无。
