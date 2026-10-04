import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { multirepoStatusTool, multirepoDevTool } from './tools.js'
import { stopAllServices } from './dev-servers.js'
import type { PluginToolContext } from 'openfox/plugin'

describe('tools module', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'multirepo-tools-test-'))
  })

  afterEach(async () => {
    stopAllServices()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('multirepo_status returns message when no config is present', async () => {
    const context: PluginToolContext = { sessionId: 'sess-1', workdir: tempDir }
    const res = await multirepoStatusTool.execute({}, context)
    expect(res.success).toBe(true)
    expect(res.output).toContain('Aucun projet multi-dépôt configuré')
  })

  it('multirepo_status returns clean tree message for configured repositories', async () => {
    const backend = join(tempDir, 'backend')
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(backend, { recursive: true })
    await mkdir(openfoxDir, { recursive: true })

    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({ projects: ['backend'] }),
    )

    execSync('git init -b main && git config user.name "Test" && git config user.email "test@example.com"', { cwd: backend })
    await writeFile(join(backend, 'README.md'), '# backend')
    execSync('git add . && git commit -m "init"', { cwd: backend })

    const context: PluginToolContext = { sessionId: 'sess-1', workdir: tempDir }
    const res = await multirepoStatusTool.execute({}, context)

    expect(res.success).toBe(true)
    expect(res.output).toContain('=== Dépôt: backend (backend) [Branche: main] ===')
    expect(res.output).toContain('(working tree clean)')
  })

  it('multirepo_dev controls and inspects configured services', async () => {
    const backend = join(tempDir, 'backend')
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(backend, { recursive: true })
    await mkdir(openfoxDir, { recursive: true })

    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({ projects: [{ name: 'backend', path: 'backend', dev: 'node -e "setInterval(()=>{},100)"' }] }),
    )

    const context: PluginToolContext = { sessionId: 'sess-1', workdir: tempDir }

    // List
    const listRes = await multirepoDevTool.execute({ action: 'list' }, context)
    expect(listRes.success).toBe(true)
    expect(listRes.output).toContain('backend (backend): node -e "setInterval(()=>{},100)"')

    // Start
    const startRes = await multirepoDevTool.execute({ action: 'start', name: 'backend' }, context)
    expect(startRes.success).toBe(true)

    // Status
    const statusRes = await multirepoDevTool.execute({ action: 'status' }, context)
    expect(statusRes.success).toBe(true)
    expect(statusRes.output).toContain('backend: running')

    // Stop
    const stopRes = await multirepoDevTool.execute({ action: 'stop', name: 'backend' }, context)
    expect(stopRes.success).toBe(true)
  })
})
