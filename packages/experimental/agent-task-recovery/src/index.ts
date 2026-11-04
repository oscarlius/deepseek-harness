/** Opt-in bounded recovery for observable unfinished agent work. @module */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Advisory recovery notices; readers preserve them without this plugin.
     * @persistenceAttribution
     */
    'agent-task-recovery': { kind: 'agent-task-recovery' } & ContextFormed
  }
}

export const name = 'agent-task-recovery'
export const inject = ['agents', 'tools']

/** Bounded recovery controls. Limits are checked when the plugin loads. */
export interface Config {
  /** Invalid argument results permitted in one turn before hook cancellation (default 3). */
  maxInvalidCalls?: number
  /** Normal text-stop continuations permitted for observable unfinished work (default 1). */
  maxContinuations?: number
}

export const Config: z<Config> = z.object({
  maxInvalidCalls: z.number().default(3),
  maxContinuations: z.number().default(1),
})

interface TurnState {
  turn: number
  invalidCalls: number
  unresolvedTools: Set<string>
  pendingTodos: number
  continuations: number
  normalStop: boolean
  preserveStop: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function invalidArguments(result: Readonly<ToolExecutionResult>): boolean {
  return result.isError && result.error.info?.code === 'INVALID_ARGS'
}

function notice(summary: string, text: string): UserMessage {
  return createUserMessage({
    source: { kind: 'agent-task-recovery', form: 'notice', summary },
    content: [{ type: 'text', text }],
  })
}

function correction(exec: Readonly<ToolExecution>): UserMessage {
  return notice('Tool arguments need correction',
    `The ${exec.name} call failed argument validation and was not changed or replayed. `
    + 'Read the previous error and the currently visible tool schema, then make a new call with valid arguments. '
    + 'Do not invent values for optional fields or assume their defaults. Do not invent business inputs or change permissions. '
    + 'If required user information, authorization, or an external condition is missing, state the precise blocker and wait.')
}

function pendingTodoCount(result: Readonly<ToolExecutionResult>): number {
  const todos = record(result.value)?.todos
  if (!Array.isArray(todos)) return 0
  const accepted = new Set(['pending', 'in_progress', 'completed'])
  if (!todos.every((item) => {
    const todo = record(item)
    return typeof todo?.content === 'string' && accepted.has(String(todo.status))
  })) return 0
  return todos.filter(item => record(item)?.status !== 'completed').length
}

function validLimit(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`agent-task-recovery: \`${name}\` must be an integer >= 1`)
  }
  return value
}

/**
 * Installs recovery listeners. The plugin never mutates arguments, replays a
 * tool call, or changes the agent loop; it only contributes public-hook context
 * or a bounded hook cancellation.
 * @param ctx - Plugin context.
 * @param config - Validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = {
    maxInvalidCalls: config.maxInvalidCalls ?? 3,
    maxContinuations: config.maxContinuations ?? 1,
  }
  const maxInvalidCalls = validLimit('maxInvalidCalls', resolved.maxInvalidCalls)
  const maxContinuations = validLimit('maxContinuations', resolved.maxContinuations)
  const states = new WeakMap<Agent, TurnState>()

  function stateFor(agent: Agent, turn: number): TurnState {
    const existing = states.get(agent)
    if (existing && existing.turn === turn) return existing
    const state: TurnState = {
      turn,
      invalidCalls: 0,
      unresolvedTools: new Set(),
      pendingTodos: 0,
      continuations: 0,
      normalStop: false,
      preserveStop: false,
    }
    states.set(agent, state)
    return state
  }

  ctx.on('agent/pre-step', ({ agent, turn, messages }, next): Promise<PreStepDecision> => {
    const state = stateFor(agent, turn)
    for (const message of messages) {
      if (message.source.kind !== 'user') continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
      const stop = /^(?:请|先|现在|please\s+)?(?:停止|停下|暂停|取消|不要继续|别继续|不用继续|不必继续|stop\b|pause\b|cancel\b|don't continue\b)/iu
      if (stop.test(text)) state.preserveStop = true
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    const agent = exec.agent
    const state = agent && states.get(agent)
    if (!agent || !state || exec.signal.aborted || state.preserveStop || decision.kind !== 'accept'
      || !invalidArguments(result) || state.invalidCalls >= maxInvalidCalls - 1) return decision
    return { ...decision, additionalContexts: [...decision.additionalContexts ?? [], correction(exec)] }
  })

  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
    const state = agent && states.get(agent)
    if (!agent || !state || exec.signal.aborted) return
    if (invalidArguments(result)) {
      state.unresolvedTools.add(exec.name)
      state.invalidCalls++
      if (!state.preserveStop && state.invalidCalls >= maxInvalidCalls) {
        agent.cancel({ kind: 'hook', reason: `Task incomplete after ${maxInvalidCalls} invalid tool calls in one turn.` })
      }
      return
    }
    if (result.isError || result.concludesTurn) {
      state.preserveStop = true
      return
    }
    state.unresolvedTools.delete(exec.name)
    if (exec.name === 'todo_write') state.pendingTodos = pendingTodoCount(result)
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const state = states.get(agent)
    if (!state) return
    if (frame.type === 'start') state.normalStop = false
    if (frame.type === 'chunk' && frame.chunk.type === 'finish') {
      state.normalStop = frame.chunk.reason.kind === 'stop'
      if (frame.chunk.reason.kind === 'max-tokens') state.preserveStop = true
    }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    const state = states.get(agent)
    if (!state || state.turn !== turn || state.preserveStop || !state.normalStop || signal.aborted
      || agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0
      || (state.unresolvedTools.size === 0 && state.pendingTodos === 0)) return
    if (state.continuations >= maxContinuations) {
      agent.cancel({ kind: 'hook', reason: 'Task incomplete after the configured recovery continuations.' })
      return
    }
    state.continuations++
    agent.steer(notice('Observable work remains incomplete',
      `${state.unresolvedTools.size} tool argument error(s) remain unresolved and ${state.pendingTodos} todo item(s) remain pending. `
      + 'Follow the latest user instruction. If the work remains authorized, correct the call or complete the next item. '
      + 'Do not claim completion merely to end this turn. If information, authorization, or an external condition is missing, state the precise blocker and wait.'))
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') states.delete(agent)
  })
}
