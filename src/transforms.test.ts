import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMMessage, PluginMessageTransformContext } from 'openfox/plugin'
import { multirepoAgentTransform } from './transforms.js'

describe('transforms module', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'multirepo-transforms-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('has correct id and priority', () => {
    expect(multirepoAgentTransform.id).toBe('multirepo-agent-guidance')
    expect(multirepoAgentTransform.priority).toBe(50)
  })

  it('leaves system prompt unmodified when no .openfox/openfox-multi-repo.json exists', async () => {
    await mkdir(join(tempDir, 'backend', '.git'), { recursive: true })
    const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }]
    const context: PluginMessageTransformContext = {
      sessionId: 'sess-1',
      workdir: tempDir,
      model: 'gpt-4',
      systemPrompt: 'Base prompt',
    }

    const result = await multirepoAgentTransform.transform(messages, context)
    if (Array.isArray(result)) {
      expect(result).toEqual(messages)
    } else {
      expect(result.systemPrompt).toBe('Base prompt')
      expect(result.messages).toEqual(messages)
    }
  })

  it('injects multi-repo instructions when .openfox/openfox-multi-repo.json is configured', async () => {
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(openfoxDir, { recursive: true })
    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({ projects: ['backend', 'frontend'] }),
    )

    const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }]
    const context: PluginMessageTransformContext = {
      sessionId: 'sess-1',
      workdir: tempDir,
      model: 'gpt-4',
      systemPrompt: 'Base prompt',
    }

    const result = await multirepoAgentTransform.transform(messages, context)
    expect(Array.isArray(result)).toBe(false)
    if (!Array.isArray(result)) {
      expect(result.systemPrompt).toContain('Multi-Repository Workspace Notice')
      expect(result.systemPrompt).toContain('- `backend`')
      expect(result.systemPrompt).toContain('- `frontend`')
      expect(result.systemPrompt).toContain('git -C <subrepo_path>')
    }
  })
})
