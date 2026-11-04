/** The optional plugin must compose through a real cordis.yml Loader entry. */
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Recovery from '../src/index.ts'

class CompositionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const argumentsJson = '{}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('invalid'), name: 'edit', arguments: argumentsJson } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'corrected' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let ctx: Context | undefined
let root: string | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
})

it('loads from cordis.yml and logs stable generic correction text for the next model request', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-agent-task-recovery-'))
  const configPath = join(root, 'cordis.yml')
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', Llm], ['@deepseek-ai/dsh-session', Sessions], ['@deepseek-ai/dsh-session-projection', Projections],
    ['@deepseek-ai/dsh-system-prompt', Prompt], ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-tool-executor-native', NativeExecutor],
    ['@deepseek-ai/dsh-agent', Agents], ['@deepseek-ai/dsh-agent-loop', AgentLoop], ['@deepseek-ai/dsh-agent-task-recovery', Recovery],
  ])
  await writeFile(configPath, await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8'))
  const context = ctx = new Context(); context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader); context.loader.builtins.include = Include
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`Unexpected fixture module: ${specifier}`)
      return Promise.resolve(module)
    },
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
    resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  context.loader.internal = internal
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  const adapter = new CompositionAdapter()
  context.llm.registerAdapter(['fixture'], adapter)
  context.tools.register(defineTool({ name: 'edit', description: 'fixture edit', parameters: { file_path: { type: 'string', required: true } }, output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] }, async execute() { return {} } }))
  const agent = await context.agentLoop.create(SessionId('loader-composition'), { provider: 'fixture', model: 'offline' })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Edit the fixture.' }] })); await agent.whenIdle()
  // The unresolved call gets its correction on request two, then the bounded
  // normal-stop recovery makes one final request before cancellation.
  expect(adapter.requests).toHaveLength(3)
  const correction = adapter.requests[1]?.messages.find(message => message.source?.kind === 'agent-task-recovery')
  expect(correction).toMatchObject({
    role: 'user',
    source: { kind: 'agent-task-recovery', form: 'notice', summary: 'Tool arguments need correction' },
    content: [{ type: 'text', text:
      'The edit call failed argument validation and was not changed or replayed. '
      + 'Read the previous error and the currently visible tool schema, then make a new call with valid arguments. '
      + 'Do not invent values for optional fields or assume their defaults. Do not invent business inputs or change permissions. '
      + 'If required user information, authorization, or an external condition is missing, state the precise blocker and wait.',
    }],
  })
  const events = agent.session.snapshotEvents()
  await context.fiber.dispose()
  ctx = undefined
  const restored = Session.create(SessionId('without-recovery-plugin'), structuredClone(events))
  expect(restored.snapshotEvents().slice(0, events.length)).toEqual(events)
  expect(restored.snapshotEvents().at(-1)?.type).toBe('session/end-seed')
})
