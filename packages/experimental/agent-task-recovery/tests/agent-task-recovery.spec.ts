/** Public-hook recovery behavior with a real AgentLoop and scripted model only. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { apply, type Config } from '../src/index.ts'

type Step = { tool: string; args: object } | { text: string; maxTokens?: true }
const say = (text = 'done'): Step => ({ text })
const edit = (args: object): Step => ({ tool: 'edit', args })
const todos = (status: string): Step => ({ tool: 'todo_write', args: { todos: [{ content: 'finish fixture', status }] } })
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

class ScriptedAdapter extends LlmAdapter {
  readonly requests = new Map<string, GenerateOptions[]>()
  readonly scripts = new Map<string, Step[]>()
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const id = String(options.sessionId)
    const requests = this.requests.get(id) ?? []
    requests.push(options); this.requests.set(id, requests)
    const step = this.scripts.get(id)?.shift()
    if (step === undefined) throw new Error(`unexpected model request for ${id}`)
    if ('tool' in step) {
      const argumentsJson = JSON.stringify(step.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId(`${id}-${requests.length}`), name: step.tool, argumentsDelta: argumentsJson }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`${id}-${requests.length}`), name: step.tool, arguments: argumentsJson } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: step.text } }
    yield { type: 'finish', reason: { kind: step.maxTokens ? 'max-tokens' : 'stop' } }
  }
}

const disposals: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

async function fixture(config: Config = {}, todoResult?: { todos?: Array<null | { content: string | number; status: string }> }) {
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const recovery = await ctx.plugin(apply, config)
  const bodies: object[] = []
  ctx.tools.register(defineTool({ name: 'edit', description: 'fixture edit', parameters: {
    file_path: { type: 'string', required: true }, sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] },
  }, output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'edited' }] },
  async execute(args) { bodies.push(args); return { ok: true } } }))
  const todoItems = { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    content: { type: 'string', required: true }, status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] },
  } } } as const
  ctx.tools.register(defineTool({ name: 'todo_write', description: 'fixture todo output', parameters: { todos: todoItems },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [{ type: 'text', text: 'todo written' }] },
    async execute(args) { return todoResult ?? { todos: args.todos } } }))
  async function create(id: string, script: Step[], parent?: Agent): Promise<Agent> {
    adapter.scripts.set(id, script)
    const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'fixture', model: 'offline' },
      ...parent === undefined ? {} : { parentAgent: parent, meta: { parentSession: parent.session.id, origin: 'subagent', delegationDepth: 1 } } })
    disposals.push(() => handle.dispose())
    return handle.agent
  }
  return { ctx, adapter, bodies, create, recovery }
}

async function ask(agent: Agent): Promise<void> { agent.followup(user('Complete the authorized fixture task.')); await agent.whenIdle() }
function outcome(agent: Agent) { return agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason }
function notices(agent: Agent): string[] {
  return agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'agent-task-recovery')
    .flatMap(event => event.type === 'user/message' ? event.data.content : []).filter(block => block.type === 'text').map(block => block.text)
}

describe('agent-task-recovery', () => {
  it('repairs invalid arguments without mutating or replaying the original call', async () => {
    const f = await fixture()
    const agent = await f.create('repair', [edit({ file_path: 'fixture.txt', sandbox_permissions: 'use_default' }), edit({ file_path: 'fixture.txt' }), say()])
    await ask(agent)
    expect(f.bodies).toEqual([{ file_path: 'fixture.txt' }])
    expect(f.adapter.requests.get('repair')).toHaveLength(3)
    expect(notices(agent)).toHaveLength(1)
    expect(notices(agent)[0]).toContain('was not changed or replayed')
    expect(JSON.stringify(agent.session.snapshotEvents())).toContain('use_default')
    expect(outcome(agent)).toEqual({ kind: 'completed' })
  })

  it('counts final INVALID_ARGS results and cancels on the configured third error', async () => {
    const f = await fixture()
    const agent = await f.create('invalid-limit', [edit({}), edit({ file_path: 42 }), edit({ sandbox_permissions: 'use_default' })])
    await ask(agent)
    expect(f.bodies).toEqual([])
    expect(f.adapter.requests.get('invalid-limit')).toHaveLength(3)
    // The final invalid result aborts the turn, so only recoverable calls get model context.
    expect(notices(agent)).toHaveLength(2)
    expect(JSON.stringify(outcome(agent))).toContain('3 invalid')
  })

  it('clears a successful same-name call and does not continue it at normal stop', async () => {
    const f = await fixture()
    const agent = await f.create('clear', [edit({}), edit({ file_path: 'fixture.txt' }), say()])
    await ask(agent)
    expect(f.adapter.requests.get('clear')).toHaveLength(3)
    expect(notices(agent)).toHaveLength(1)
    expect(outcome(agent)).toEqual({ kind: 'completed' })
  })

  it('uses canonical successful todo results to steer exactly once then cancels if still incomplete', async () => {
    const f = await fixture()
    const agent = await f.create('todo', [todos('pending'), say('need more?'), say('still waiting')])
    await ask(agent)
    expect(f.adapter.requests.get('todo')).toHaveLength(3)
    expect(notices(agent)).toHaveLength(1)
    expect(notices(agent)[0]).toContain('todo item(s) remain pending')
    expect(JSON.stringify(outcome(agent))).toContain('configured recovery continuations')
  })

  it('accepts an eventually completed todo list after one continuation', async () => {
    const f = await fixture()
    const agent = await f.create('completed-todo', [todos('in_progress'), say(), todos('completed'), say()])
    await ask(agent)
    expect(f.adapter.requests.get('completed-todo')).toHaveLength(4)
    expect(notices(agent)).toHaveLength(1)
    expect(outcome(agent)).toEqual({ kind: 'completed' })
  })

  it('preserves user cancellation, denied calls, concluding tools, and max-token stops', async () => {
    const f = await fixture()
    f.ctx.on('tools/pre-execute', (exec, next) => exec.name === 'edit' ? Promise.resolve({ kind: 'deny', reason: 'fixture denied' }) : next())
    f.ctx.tools.register(defineTool({ name: 'ask_user', description: 'conclude', parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] }, async execute(_args, exec) { exec.concludeTurn(); return {} } }))
    const denied = await f.create('denied', [todos('pending'), edit({ file_path: 'fixture.txt' }), say()])
    const concluded = await f.create('concluded', [todos('pending'), { tool: 'ask_user', args: {} }])
    const tokens = await f.create('tokens', [todos('pending'), { text: 'partial', maxTokens: true }])
    const cancelled = await f.create('cancelled', [todos('pending')])
    let didCancel = false
    f.ctx.on('tools/result', (exec) => { if (!didCancel && exec.agent === cancelled) { didCancel = true; exec.agent.cancel({ kind: 'user' }) } })
    await ask(denied); await ask(concluded); await ask(tokens); await ask(cancelled)
    expect(notices(denied)).toEqual([])
    expect(notices(concluded)).toEqual([])
    expect(notices(tokens)).toEqual([])
    expect(notices(cancelled)).toEqual([])
    expect(outcome(tokens)).toEqual({ kind: 'max-tokens' })
    expect(outcome(cancelled)).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it('keeps parent and child recovery state independent', async () => {
    const f = await fixture()
    const parent = await f.create('parent', [todos('pending'), say(), say()])
    const child = await f.create('child', [todos('pending'), say(), say()], parent)
    await Promise.all([ask(parent), ask(child)])
    for (const agent of [parent, child]) {
      expect(notices(agent)).toHaveLength(1)
      expect(outcome(agent)).toMatchObject({ kind: 'aborted', reason: { kind: 'hook' } })
    }
  })

  it.each([{}, { todos: [null] }, { todos: [{ content: 7, status: 'pending' }] }, { todos: [{ content: 'item', status: 'unknown' }] }])(
    'does not infer pending work from an unrecognized successful todo payload %o', async (value) => {
      const f = await fixture({}, value)
      const agent = await f.create('malformed-todo', [todos('pending'), say()])
      await ask(agent)
      expect(f.adapter.requests.get('malformed-todo')).toHaveLength(2)
      expect(notices(agent)).toEqual([])
      expect(outcome(agent)).toEqual({ kind: 'completed' })
    },
  )

  it('honors a user stop message without a recovery continuation', async () => {
    const f = await fixture()
    const agent = await f.create('text-stop', [todos('pending'), say()])
    agent.followup(user('停止。'))
    await agent.whenIdle()
    expect(f.adapter.requests.get('text-stop')).toHaveLength(2)
    expect(notices(agent)).toEqual([])
    expect(outcome(agent)).toEqual({ kind: 'completed' })
  })

  it('ignores late tool and stream events after the agent becomes idle', async () => {
    const f = await fixture()
    let lateTool: (() => void) | undefined
    let lateStream: (() => void) | undefined
    f.ctx.on('tools/result', (exec, result) => { lateTool = () => { f.ctx.emit('tools/result', exec, result) } })
    f.ctx.on('agent/assistant-stream', (payload) => { lateStream = () => { f.ctx.emit('agent/assistant-stream', payload) } })
    const agent = await f.create('late-events', [edit({ file_path: 'fixture.txt' }), say()])
    await ask(agent)
    expect(lateTool).toBeDefined()
    expect(lateStream).toBeDefined()
    lateTool?.()
    lateStream?.()
    expect(f.adapter.requests.get('late-events')).toHaveLength(2)
    expect(notices(agent)).toEqual([])
    expect(outcome(agent)).toEqual({ kind: 'completed' })
  })

  it.each([{ maxInvalidCalls: 0 }, { maxInvalidCalls: 1.5 }, { maxContinuations: 0 }, { maxContinuations: 1.5 }])('fails fast on invalid configuration %o', async (config) => {
    const ctx = new Context()
    try {
      expect(() => { apply(ctx, { maxInvalidCalls: 3, maxContinuations: 1, ...config }) }).toThrow(/integer >= 1/)
    } finally { await ctx.fiber.dispose() }
  })

  it('removes its behavior when its fiber is unloaded (HMR safety)', async () => {
    const f = await fixture()
    await f.recovery.dispose()
    const agent = await f.create('unloaded', [edit({}), say()])
    await ask(agent)
    expect(notices(agent)).toEqual([])
    expect(outcome(agent)).toEqual({ kind: 'completed' })
  })
})
