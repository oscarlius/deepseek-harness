---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-agent-task-recovery-attribution

English | [中文](2026-11-05-agent-task-recovery-attribution.zh.md)

## Summary

Adds the agent-task-recovery attribution kind for advisory correction and continuation messages.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing message variants and Session V4 envelopes are unchanged, so old records remain readable. New records carry ordinary user-role text plus notice metadata. Readers without this opt-in producer preserve the unknown source kind and JSON metadata and derive the recorded text; this attribution grants no execution, replay, validation, or permission authority. Recovery state is transient and is not reconstructed from the source kind. A missing producer retains the pre-existing stop policy. No writer-version increase is required.

<a id="verification"></a>
## Verification

The package's deterministic AgentLoop and real Loader composition tests pass; they record producer-labelled correction text and test plugin disposal. Host and client aggregate checks and a built-package external NodeNext consumer pass. No live-model or released-binary acceptance is claimed.

<a id="dev-note"></a>
## Dev Note

None.
