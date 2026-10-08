import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { register, deactivate, getSessionModifiedFiles } from './index.js'
import type { PluginRegistry, PluginToolContext } from 'openfox/plugin'

function createMockRegistry() {
  const calls: Record<string, unknown[]> = {}
  const rpcs: Record<string, (params: Record<string, unknown>, context: PluginToolContext) => Promise<unknown>> = {}

  const record = (key: string) => (value: unknown) => {
    calls[key] = [...(calls[key] ?? []), value]
  }

  const registry: PluginRegistry = {
    runtime: { mode: 'development', configDirectory: '/tmp' },
    context: {
      id: 'openfox-multirepo-plugin',
      version: '1.0.0',
      runtime: { mode: 'development', configDirectory: '/tmp' },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      storage: { get: () => undefined, set: vi.fn() },
      settings: () => ({}),
      notify: vi.fn(),
      publish: vi.fn(),
    },
    registerAuth: record('auth'),
    registerTransport: record('transport'),
    registerPreset: record('preset'),
    registerModelMetadataProvider: record('modelMetadata'),
    registerTool: record('tool'),
    registerCommand: record('command'),
    registerSkillSource: record('skillSource'),
    registerSettings: record('settings'),
    registerUiAction: record('uiAction'),
    registerUiBadge: record('uiBadge'),
    registerUiPanel: record('uiPanel'),
    registerSettingsTab: record('settingsTab'),
    registerUiComponent: record('uiComponent'),
    registerUiOverride: record('uiOverride'),
    registerHook: (event: string, handler: unknown) => record(`hook:${event}`)(handler),
    registerTransitionHandler: (name: string, handler: unknown) => record(`transition:${name}`)(handler),
    registerRpc: (method: string, handler: (params: Record<string, unknown>, context: PluginToolContext) => Promise<unknown>) => {
      record(`rpc:${method}`)(handler)
      rpcs[method] = handler
    },
    registerAsset: record('asset'),
    registerMessageTransform: record('messageTransform'),
    registerDangerLevel: record('dangerLevel'),
    registerVcsProvider: record('vcsProvider'),
    registerThinkingGuard: record('thinkingGuard'),
  }

  return { registry, calls, rpcs }
}

describe('plugin index & integration', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'multirepo-index-test-'))
  })

  afterEach(async () => {
    deactivate()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('registers all capabilities: VCS, transforms, UI overrides, tools, panel, command, settings, components, RPCs', () => {
    const { registry, calls, rpcs } = createMockRegistry()
    register(registry)

    expect(calls['vcsProvider']).toHaveLength(1)
    expect(calls['messageTransform']).toHaveLength(1)
    expect(calls['tool']).toHaveLength(2)
    expect(calls['uiOverride']).toHaveLength(2)
    expect(calls['uiBadge']).toBeUndefined()
    expect(calls['uiPanel']).toHaveLength(3)
    expect(calls['uiComponent']).toHaveLength(1)
    expect(calls['command']).toHaveLength(1)
    expect(calls['settings']).toHaveLength(1)
    const settingsSchema = calls['settings']?.[0] as { fields: Array<{ key: string; default?: unknown }> }
    const sessionSetting = settingsSchema.fields.find((f) => f.key === 'sessionModifiedFilesOnly')
    expect(sessionSetting).toBeDefined()
    expect(sessionSetting?.default).toBe(true)

    expect(calls['hook:tool.completed']).toHaveLength(1)

    expect(rpcs['getGitSidebarUi']).toBeDefined()
    expect(rpcs['getDevServerUi']).toBeDefined()
    expect(rpcs['startDevService']).toBeDefined()
    expect(rpcs['stopDevService']).toBeDefined()
    expect(rpcs['openBranchModal']).toBeDefined()
    expect(rpcs['switchBranchRpc']).toBeDefined()
    expect(rpcs['createBranchRpc']).toBeDefined()
    expect(rpcs['openDevLogsModal']).toBeDefined()
    expect(rpcs['refreshDevLogsRpc']).toBeDefined()
    expect(rpcs['openDevHelpModal']).toBeDefined()
  })

  it('returns empty result for default OpenFox fallback when .openfox/openfox-multi-repo.json is absent', async () => {
    const { registry, rpcs } = createMockRegistry()
    register(registry)

    const context: PluginToolContext = { sessionId: 'sess-1', workdir: tempDir }

    const gitUi = (await rpcs['getGitSidebarUi']?.({}, context)) as { content?: unknown }
    expect(gitUi).toEqual({})

    const devUi = (await rpcs['getDevServerUi']?.({}, context)) as { content?: unknown }
    expect(devUi).toEqual({})
  })

  it('tracks tool.completed hooks and clears state on deactivate', async () => {
    const { registry, calls } = createMockRegistry()
    register(registry)

    const hookHandler = calls['hook:tool.completed']?.[0] as (payload: unknown) => Promise<void>
    expect(hookHandler).toBeDefined()

    await hookHandler({
      sessionId: 'session-hook-test',
      data: {
        tool: 'write_file',
        arguments: { path: 'packages/sub/file.ts' },
        result: {
          success: true,
          output: 'Successfully wrote 10 lines to packages/sub/file.ts',
          metadata: { path: join(tempDir, 'packages/sub/file.ts') },
        },
      },
    })

    const filesBefore = getSessionModifiedFiles('session-hook-test', tempDir)
    expect(filesBefore).toContain('packages/sub/file.ts')

    deactivate()

    const filesAfter = getSessionModifiedFiles('session-hook-test', tempDir)
    expect(filesAfter.size).toBe(0)
  })

  it('provides declarative Git sidebar UI per repo with branch, edit button, and diffs when configured', async () => {
    const backend = join(tempDir, 'backend')
    const frontend = join(tempDir, 'frontend')
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(backend, { recursive: true })
    await mkdir(frontend, { recursive: true })
    await mkdir(openfoxDir, { recursive: true })

    execSync('git init -b main && git config user.name "Test" && git config user.email "test@example.com"', { cwd: backend })
    await writeFile(join(backend, 'server.ts'), 'console.log("init")')
    execSync('git add . && git commit -m "init backend"', { cwd: backend })
    await writeFile(join(backend, 'server.ts'), 'console.log("modified")')

    execSync('git init -b develop && git config user.name "Test" && git config user.email "test@example.com"', { cwd: frontend })
    await writeFile(join(frontend, 'App.tsx'), 'export const App = 1')
    execSync('git add . && git commit -m "init frontend"', { cwd: frontend })

    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({ projects: ['backend', 'frontend'] }),
    )

    const { registry, rpcs } = createMockRegistry()
    register(registry)

    const context: PluginToolContext = { sessionId: 'sess-1', workdir: tempDir }
    const result = (await rpcs['getGitSidebarUi']?.({}, context)) as {
      content: {
        type: string
        children: unknown[]
      }
    }

    expect(result).toBeDefined()
    expect(result.content.type).toBe('stack')
    expect(result.content.children.length).toBe(2) // 2 clean repo cards

    // Check that changed file in backend is a clickable text node with openUrl
    const backendCard = result.content.children[0] as {
      type: string
      children: Array<{
        type: string
        children?: Array<{
          type: string
          text?: { en: string; fr: string }
          onActivate?: { kind: string; url: string }
        }>
      }>
    }
    const diffStack = backendCard.children[2]
    expect(diffStack?.type).toBe('stack')
    const fileNode = diffStack?.children?.[0]
    expect(fileNode?.type).toBe('text')
    expect(fileNode?.text?.en).toBe('• server.ts')
    expect(fileNode?.onActivate?.kind).toBe('openUrl')
    expect(fileNode?.onActivate?.url).toMatch(/^vscode:\/\/file\/.*\/backend\/server\.ts:1:1\?windowId=_blank$/)
  })

  it('correctly creates editor URLs for added, deleted and modified files', async () => {
    const repoDir = join(tempDir, 'repo')
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(repoDir, { recursive: true })
    await mkdir(openfoxDir, { recursive: true })

    execSync('git init -b main && git config user.name "Test" && git config user.email "test@example.com"', { cwd: repoDir })
    await writeFile(join(repoDir, 'existing.ts'), 'export const a = 1')
    await writeFile(join(repoDir, 'to_delete.ts'), 'export const del = 1')
    execSync('git add . && git commit -m "init"', { cwd: repoDir })

    // Modify existing, delete to_delete, add new
    await writeFile(join(repoDir, 'existing.ts'), 'export const a = 2')
    execSync('rm to_delete.ts', { cwd: repoDir })
    await writeFile(join(repoDir, 'added.ts'), 'export const added = true')

    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({ projects: ['repo'] }),
    )

    const { registry, rpcs } = createMockRegistry()
    register(registry)

    const context: PluginToolContext = { sessionId: 'sess-1', workdir: tempDir }
    const result = (await rpcs['getGitSidebarUi']?.({}, context)) as {
      content: {
        children: Array<{
          children: Array<{
            children?: Array<{
              type: string
              text?: { en: string; fr: string }
              title?: { en: string; fr: string }
              className?: string
              onActivate?: { kind: string; url: string }
            }>
          }>
        }>
      }
    }

    const diffNodes = result.content.children[0]?.children[2]?.children ?? []
    expect(diffNodes.length).toBe(3)

    const addedNode = diffNodes.find((n) => n.text?.en.includes('added.ts'))
    expect(addedNode?.type).toBe('text')
    expect(addedNode?.text?.en).toBe('+ added.ts')
    expect(addedNode?.className).toContain('text-accent-success')
    expect(addedNode?.title?.en).toBe('Open added.ts in VSCode')
    expect(addedNode?.onActivate?.kind).toBe('openUrl')
    expect(addedNode?.onActivate?.url).toContain('vscode://file/')

    const deletedNode = diffNodes.find((n) => n.text?.en.includes('to_delete.ts'))
    expect(deletedNode?.type).toBe('text')
    expect(deletedNode?.text?.en).toBe('- to_delete.ts')
    expect(deletedNode?.className).toContain('text-accent-error')
    expect(deletedNode?.title?.en).toBe('Open to_delete.ts in VSCode')
    expect(deletedNode?.onActivate?.kind).toBe('openUrl')

    const modifiedNode = diffNodes.find((n) => n.text?.en.includes('existing.ts'))
    expect(modifiedNode?.type).toBe('text')
    expect(modifiedNode?.text?.en).toBe('• existing.ts')
    expect(modifiedNode?.className).toContain('text-purple-400')
    expect(modifiedNode?.title?.en).toBe('Open existing.ts in VSCode')
    expect(modifiedNode?.onActivate?.kind).toBe('openUrl')
  })

  it('handles branch modal RPCs (open, switch, create)', async () => {
    const backend = join(tempDir, 'backend')
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(backend, { recursive: true })
    await mkdir(openfoxDir, { recursive: true })

    execSync('git init -b main && git config user.name "Test" && git config user.email "test@example.com"', { cwd: backend })
    await writeFile(join(backend, 'README.md'), '# backend')
    execSync('git add . && git commit -m "init"', { cwd: backend })

    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({ projects: [{ name: 'backend', path: 'backend' }] }),
    )

    const { registry, rpcs } = createMockRegistry()
    register(registry)

    const context: PluginToolContext = { sessionId: 'sess-1', workdir: tempDir }

    // Open branch modal
    const modalRes = (await rpcs['openBranchModal']?.({ repoName: 'backend' }, context)) as {
      openPanel: string
      content: Array<{ type: string; children: Array<{ type: string; children?: unknown[] }> }>
    }
    expect(modalRes.openPanel).toBe('multirepo-branch-modal')
    expect(modalRes.content.length).toBeGreaterThan(0)
    const modalRoot = modalRes.content[0]
    expect(modalRoot?.type).toBe('stack')
    expect(modalRoot?.children?.length).toBe(2) // Branches section and Create new branch section

    // Verify current branch badge and search input
    const branchesSection = modalRoot?.children?.[0] as {
      type: string
      children: Array<{ type: string; id?: string; icon?: string; placeholder?: { en: string }; className?: string }>
    }
    expect(branchesSection.children[1]?.id).toBe('branch-search')
    expect(branchesSection.children[1]?.icon).toBe('SearchIcon')
    expect(branchesSection.children[1]?.placeholder?.en).toBe('Search branches…')

    // Branch list: current branch row shows (current), non-current rows expose a link-style Switch button
    const branchList = branchesSection.children[2] as unknown as {
      children: Array<{ type: string; className?: string; children: Array<Record<string, unknown>> }>
    }
    const currentRow = branchList.children.find((row) => row.className?.includes('bg-accent-primary/10'))
    expect(currentRow).toBeDefined()
    const currentTrailing = currentRow?.children.at(-1) as { type: string; text?: { en: string } }
    expect(currentTrailing.type).toBe('text')
    expect(currentTrailing.text?.en).toBe('(current)')

    // Create section: bare input with branch icon inside a bordered container + full-width primary button
    const createSection = modalRoot?.children?.[1] as {
      children: Array<{ type: string; className?: string; children?: Array<Record<string, unknown>>; variant?: string }>
    }
    const createFieldContainer = createSection.children[1] as { type: string; className?: string; children: Array<Record<string, unknown>> }
    expect(createFieldContainer.className).toContain('focus-within:border-accent-primary')
    const bareInput = createFieldContainer.children[1] as { type: string; bare?: boolean; id?: string }
    expect(bareInput.bare).toBe(true)
    expect(bareInput.id).toBe('new-branch-name')
    const createButton = createSection.children.at(-1) as { type: string; variant?: string; className?: string }
    expect(createButton.variant).toBe('primary')
    expect(createButton.className).toContain('w-full')

    // Typing a branch name reveals the optional source-branch field
    const draftRes = (await rpcs['setBranchNameRpc']?.({ repoName: 'backend', value: 'feat/draft' }, context)) as {
      content: Array<{ children: Array<{ children: Array<Record<string, unknown>> }> }>
    }
    const draftCreateSection = draftRes.content[0]?.children[1] as { children: Array<Record<string, unknown>> }
    const sourceFieldIds = draftCreateSection.children
      .filter((child) => child['type'] === 'stack' && Array.isArray(child['children']))
      .flatMap((child) => (child['children'] as Array<{ id?: string }>).map((c) => c.id))
    expect(sourceFieldIds).toContain('source-branch')

    // Create new branch
    const createRes = (await rpcs['createBranchRpc']?.(
      { repoName: 'backend', value: 'feat/test' },
      context,
    )) as {
      success: boolean
      openPanel: string
    }
    expect(createRes.success).toBe(true)

    // Switch branch back to main
    const switchRes = (await rpcs['switchBranchRpc']?.({ repoName: 'backend', branch: 'main' }, context)) as {
      success: boolean
      openPanel: string
    }
    expect(switchRes.success).toBe(true)
  })

  it('registers a Cancel footer on the branch modal panel', () => {
    const { registry, calls } = createMockRegistry()
    register(registry)
    const panels = calls['uiPanel'] as Array<{
      id: string
      footer?: Array<{ children: Array<{ onActivate?: { kind: string } }> }>
    }>
    const branchPanel = panels.find((p) => p.id === 'multirepo-branch-modal')
    expect(branchPanel?.footer?.[0]?.children?.[0]?.onActivate?.kind).toBe('closePanel')
  })

  it('provides DevServer UI and handles start/stop RPCs and logs modal when configured', async () => {
    const backend = join(tempDir, 'backend')
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(backend, { recursive: true })
    await mkdir(openfoxDir, { recursive: true })

    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({ projects: [{ name: 'backend', path: 'backend', dev: 'node -e "setInterval(()=>{},100)"' }] }),
    )

    const { registry, rpcs } = createMockRegistry()
    register(registry)

    const context: PluginToolContext = { sessionId: 'sess-1', workdir: tempDir }
    const uiResult = (await rpcs['getDevServerUi']?.({}, context)) as {
      content: {
        type: string
        children: Array<{
          children: Array<{
            children: Array<{
              children?: Array<{
                type: string
                icon?: string
                title?: { en: string; fr: string }
                label?: { en: string; fr: string }
                onActivate?: { kind: string; method?: string; params?: Record<string, unknown> }
              }>
            }>
          }>
        }>
      }
    }
    expect(uiResult).toBeDefined()
    expect(uiResult.content.type).toBe('card')

    // Check header with title and info icon button
    const headerRow = uiResult.content.children[0] as unknown as {
      type: string
      children: Array<{
        type: string
        text?: { en: string }
        icon?: string
        onActivate?: { kind: string; method?: string }
      }>
    }
    expect(headerRow.type).toBe('stack')
    expect(headerRow.children[0]?.text?.en).toBe('Dev Servers')
    expect(headerRow.children[1]?.icon).toBe('InfoIcon')
    expect(headerRow.children[1]?.onActivate?.method).toBe('openDevHelpModal')

    // Test opening help guide modal
    const helpModalRes = (await rpcs['openDevHelpModal']?.({}, context)) as {
      openPanel: string
      content: Array<{ type: string }>
    }
    expect(helpModalRes.openPanel).toBe('multirepo-dev-help-modal')
    expect(helpModalRes.content.length).toBeGreaterThan(0)

    // Check Logs and Start buttons (icon-only buttons)
    const contentStack = uiResult.content.children[1] as unknown as {
      children: Array<{
        children: Array<{
          children: Array<{
            icon?: string
            title?: { en: string }
            onActivate?: { kind: string; method?: string }
          }>
        }>
      }>
    }
    const rowButtons = contentStack.children[0]?.children[1]?.children ?? []
    expect(rowButtons.length).toBe(2)
    expect(rowButtons[0]?.icon).toContain('lucide-terminal')
    expect(rowButtons[0]?.title?.en).toContain('Logs')
    expect(rowButtons[0]?.onActivate?.kind).toBe('rpc')
    expect(rowButtons[0]?.onActivate?.method).toBe('openDevLogsModal')

    expect(rowButtons[1]?.icon).toContain('lucide-play')
    expect(rowButtons[1]?.title?.en).toContain('Start')

    const startRes = (await rpcs['startDevService']?.(
      { name: 'backend', cwd: backend, command: 'node -e "setInterval(()=>{},100)"' },
      context,
    )) as { success: boolean; content?: unknown }
    expect(startRes.success).toBe(true)
    expect(startRes.content).toBeDefined()

    // Test opening logs modal
    const logsModalRes = (await rpcs['openDevLogsModal']?.({ name: 'backend' }, context)) as {
      openPanel: string
      content: Array<{ type: string; children: Array<{ type: string }> }>
    }
    expect(logsModalRes.openPanel).toBe('multirepo-dev-logs-modal')
    expect(logsModalRes.content).toBeDefined()

    const stopRes = (await rpcs['stopDevService']?.({ name: 'backend' }, context)) as {
      success: boolean
      content?: unknown
    }
    expect(stopRes.success).toBe(true)
    expect(stopRes.content).toBeDefined()
  })

  it('renders mixed servers and direct commands with icons and distinct buttons', async () => {
    const gpatDir = join(tempDir, 'hub-gan-pat-mobile')
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(gpatDir, { recursive: true })
    await mkdir(openfoxDir, { recursive: true })

    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({
        projects: [
          {
            name: 'gpat',
            path: 'hub-gan-pat-mobile',
            dev: [
              { name: 'start-pprod', command: 'node -e "setInterval(()=>{},100)"', icon: 'PlayIcon' },
            ],
            commands: [
              { name: 'build', command: 'node -e "console.log(\'built\')"', icon: 'GearIcon' },
              { icon: 'CheckIcon', command: 'node -e "console.log(\'linted\')"' },
              { name: 'migrate', command: 'node -e "console.log(\'migrated\')"', separateLine: true },
            ],
          },
        ],
      }),
    )

    const { registry, rpcs } = createMockRegistry()
    register(registry)

    const context: PluginToolContext = { sessionId: 'sess-1', workdir: tempDir }
    const uiResult = (await rpcs['getDevServerUi']?.({}, context)) as {
      content: {
        children: Array<{
          children: Array<{
            children: Array<{
              children?: Array<{
                type: string
                text?: { en: string }
                label?: { en: string; fr: string }
                icon?: string
                title?: { en: string }
                variant?: string
              }>
            }>
          }>
        }>
      }
    }

    const rows = uiResult.content.children[1]?.children ?? []
    expect(rows.length).toBe(2) // 1 server row with inline commands + 1 dedicated command row

    // Row 1: server start-pprod with inline commands
    // Left: status dot ● + text 'gpat'
    const serverRowLeft = rows[0]?.children[0]?.children ?? []
    expect(serverRowLeft[0]?.type).toBe('text')
    expect(serverRowLeft[0]?.text?.en).toBe('●')
    expect(serverRowLeft[1]?.type).toBe('text')
    expect(serverRowLeft[1]?.text?.en).toBe('gpat')

    // Right: 4 compact icon buttons: [GearIcon/settings (build)], [CheckIcon (lint)], [TerminalIcon (Logs)], [PlayIcon (Start)]
    const serverRowRight = rows[0]?.children[1]?.children ?? []
    expect(serverRowRight.length).toBe(4)
    expect(serverRowRight[0]?.icon).toContain('lucide-settings')
    expect(serverRowRight[0]?.title?.en).toContain('build')
    expect(serverRowRight[1]?.icon).toContain('lucide-check')
    expect(serverRowRight[1]?.title?.en).toContain('lint')
    expect(serverRowRight[2]?.icon).toContain('lucide-terminal') // only 1 logs button for the dev server
    expect(serverRowRight[3]?.icon).toContain('lucide-play') // start button for the dev server
    expect(serverRowRight[3]?.variant).toBe('success')
    expect(serverRowRight[3]?.title?.en).toContain('start-pprod')

    // Row 2: dedicated-line command migrate
    const dedicatedRowLeft = rows[1]?.children[0]?.children ?? []
    expect(dedicatedRowLeft[0]?.text?.en).toContain('migrate')

    const dedicatedRowRight = rows[1]?.children[1]?.children ?? []
    expect(dedicatedRowRight.length).toBe(1) // only 1 Run button, NO logs button
    expect(dedicatedRowRight[0]?.icon).toContain('lucide-play')
    expect(dedicatedRowRight[0]?.title?.en).toContain('migrate')
  })

  it('openDevHelpModal renders auto-detect section, canonical path examples, and lists discovered repos', async () => {
    // Create sub-repos in tempDir
    await mkdir(join(tempDir, 'sub-a', '.git'), { recursive: true })
    await mkdir(join(tempDir, 'sub-b', '.git'), { recursive: true })
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(openfoxDir, { recursive: true })

    // sub-a is already configured
    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({
        projects: [{ name: 'sub-a', path: './sub-a' }],
      }),
    )

    const { registry, rpcs } = createMockRegistry()
    register(registry)

    const context: PluginToolContext = { sessionId: 'sess-help-1', workdir: tempDir }
    const res = (await rpcs['openDevHelpModal']?.({}, context)) as {
      openPanel: string
      content: Array<Record<string, unknown>>
    }

    expect(res.openPanel).toBe('multirepo-dev-help-modal')
    expect(res.content.length).toBeGreaterThan(0)

    const stack = res.content[0] as { children: Array<Record<string, unknown>> }
    expect(stack.children.length).toBeGreaterThanOrEqual(4)

    // First child is Auto-Detect card
    const autoDetectCard = stack.children[0] as {
      title?: { en: string; fr: string }
      children: Array<Record<string, unknown>>
    }
    expect(autoDetectCard.title?.en).toBe('Auto-Detect Git Projects')
    expect(autoDetectCard.title?.fr).toBe('Détection automatique des projets Git')

    // Find the example card and verify canonical path is used
    const exampleCard = stack.children.find(
      (c) => (c as { title?: { en: string } }).title?.en?.includes('Complete Example'),
    ) as { children: Array<{ text?: { en: string } }> } | undefined
    expect(exampleCard).toBeDefined()
    expect(exampleCard?.children[0]?.text?.en).toContain('"path": "./frontend"')
    expect(exampleCard?.children[0]?.text?.en).not.toContain('"./hub-gan-pat-mobile"')

    // Test selectAllHelpReposRpc selects both sub-a and sub-b
    const selectAllRes = (await rpcs['selectAllHelpReposRpc']?.({}, context)) as {
      content: Array<Record<string, unknown>>
    }
    expect(selectAllRes.content).toBeDefined()

    // Add selected projects to config
    const addRes = (await rpcs['addSelectedReposToConfig']?.({}, context)) as {
      content: Array<Record<string, unknown>>
    }
    expect(addRes.content).toBeDefined()

    // Verify config file was updated with both sub-a and sub-b
    const updatedRaw = await readFile(join(openfoxDir, 'openfox-multi-repo.json'), 'utf8')
    const updatedParsed = JSON.parse(updatedRaw) as {
      projects: Array<{ name: string; path: string; dev?: unknown; commands?: unknown }>
    }
    expect(updatedParsed.projects).toHaveLength(2)
    expect(updatedParsed.projects[0]?.name).toBe('sub-a')
    expect(updatedParsed.projects[1]).toEqual({
      name: 'sub-b',
      path: './sub-b',
    })
    expect(updatedParsed.projects[1]?.dev).toBeUndefined()
    expect(updatedParsed.projects[1]?.commands).toBeUndefined()

    // Uncheck sub-a: toggle directly updates and removes sub-a in real-time
    await rpcs['toggleHelpRepoSelection']?.({ repoPath: 'sub-a', value: 'false' }, context)

    const updatedRaw2 = await readFile(join(openfoxDir, 'openfox-multi-repo.json'), 'utf8')
    const updatedParsed2 = JSON.parse(updatedRaw2) as {
      projects: Array<{ name: string; path: string }>
    }
    expect(updatedParsed2.projects).toHaveLength(1)
    expect(updatedParsed2.projects[0]?.name).toBe('sub-b')

    // Test unselectAllHelpReposRpc directly removes all
    const unselectAllRes = (await rpcs['unselectAllHelpReposRpc']?.({}, context)) as {
      content: Array<Record<string, unknown>>
    }
    expect(unselectAllRes.content).toBeDefined()

    const updatedRaw3 = await readFile(join(openfoxDir, 'openfox-multi-repo.json'), 'utf8')
    const updatedParsed3 = JSON.parse(updatedRaw3) as {
      projects: Array<{ name: string; path: string }>
    }
    expect(updatedParsed3.projects).toHaveLength(0)
  })
})
