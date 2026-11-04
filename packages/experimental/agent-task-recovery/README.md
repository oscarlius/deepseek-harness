---
description: "Opt-in bounded recovery after invalid tool arguments or incomplete todo evidence."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-task-recovery

English | [中文](README.zh.md)

## Summary

This experimental, opt-in plugin prevents a turn from silently ending while it has observable unfinished work. It never changes tool arguments, replays tools, or changes the agent loop. No default profile enables it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin explicitly where bounded recovery is useful:

```yaml
- name: '@deepseek-ai/dsh-agent-task-recovery'
  config:
    maxInvalidCalls: 3
    maxContinuations: 1
```

| Field | Default | Accepted values | Meaning |
|---|---:|---|---|
| `maxInvalidCalls` | `3` | integer >= 1 | Invalid-argument results allowed in one turn before hook cancellation |
| `maxContinuations` | `1` | integer >= 1 | Continuations allowed after a normal text stop with observable unfinished work |

Invalid configuration fails at plugin load. Mount it for an autonomous task that should report observable unfinished work instead of ending after a normal text response. Do not mount it when each normal text stop must remain final regardless of invalid-argument or todo evidence.

The plugin adds correction context after an `INVALID_ARGS` result, but never changes or repeats the failed call. It continues only when the current turn has unresolved invalid arguments or pending todos from a successful `todo_write`; it then has at most `maxContinuations` normal-stop continuations.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin owns a `WeakMap<Agent, TurnState>`. It creates a fresh state when `agent/pre-step` reports a new turn, so an interleaved user message does not reset the current turn's counters.

`tools/post-execute` supplies source-labelled correction context for non-terminal `INVALID_ARGS` results. `tools/result` observes the final result: it counts invalid arguments, clears a same-name marker after a successful call, and accepts pending todos only from a complete valid `todo_write` payload. The configured invalid-call limit cancels with a hook reason.

At `agent/turn-stopping`, only a normal text stop with no queued work can receive a continuation. Permission denial, another tool error, `concludesTurn`, max-token output, user cancellation, and cancellation signals preserve normal stop handling. The short text-stop recognizer is a convenience only; the cancellation signal is authoritative.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Recovery contexts after observable unfinished work

#### What the model sees

After a non-terminal `INVALID_ARGS` result, the next request receives a source-labelled correction that says the call was not changed or replayed and directs the model to the prior error and current schema. At a qualifying normal text stop, it may instead receive one source-labelled incomplete-work continuation. The plugin adds no tool schema and does not alter normal tool-call content.

#### Token effect

Each correction or continuation is retained history for the next request. Corrections occur only before the configured invalid-call terminal result; continuations are capped by `maxContinuations` per turn.

#### KV Cache effect

Contexts append after existing history, preserving the earlier reusable prefix. A newly injected correction or continuation changes only the next request suffix; provider cache availability and eviction remain outside this package.

## Known Limitations and Deferred Work

- **Observable evidence only** — only final `INVALID_ARGS` results and complete successful `todo_write` payloads can keep a turn active; the plugin does not judge business, code, or tool-result correctness.
- **Same-name success is limited evidence** — a successful call clears that tool's invalid-argument marker without proving the wider task complete.
- **Text stop recognition is incomplete** — it recognizes only a small set of explicit stop phrases; integrations must use the agent cancellation signal for authoritative cancellation.
- **Current hook availability is required** — final-result tracking depends on the public `tools/result` event; compatibility with runtimes that lack it is not provided.
- **Consumer work remains external** — profile composition, UI exposure, installation, and real-model acceptance are not supplied by this package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
