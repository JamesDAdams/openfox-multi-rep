import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import type { PluginVcsDiffFile, PluginContext } from 'openfox/plugin'
import { multirepoVcsProvider } from './vcs-provider.js'
import {
  recordSessionModifiedFile,
  clearSessionModifiedFiles,
  setTrackerContext,
} from './session-tracker.js'

describe('vcs-provider module', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'multirepo-vcs-test-'))
  })

  afterEach(async () => {
    clearSessionModifiedFiles()
    setTrackerContext(undefined, undefined)
    await rm(tempDir, { recursive: true, force: true })
  })

  it('has correct id and priority', () => {
    expect(multirepoVcsProvider.id).toBe('openfox-multirepo-vcs')
    expect(multirepoVcsProvider.priority).toBe(10)
  })

  it('detects false when no .openfox/openfox-multi-repo.json exists', async () => {
    const backend = join(tempDir, 'backend')
    const frontend = join(tempDir, 'frontend')
    await mkdir(join(backend, '.git'), { recursive: true })
    await mkdir(join(frontend, '.git'), { recursive: true })

    const detected = await multirepoVcsProvider.detect({ workdir: tempDir })
    expect(detected).toBe(false)
  })

  it('detects true when .openfox/openfox-multi-repo.json exists with projects', async () => {
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(openfoxDir, { recursive: true })
    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({ projects: ['backend', 'frontend'] }),
    )

    const detected = await multirepoVcsProvider.detect({ workdir: tempDir })
    expect(detected).toBe(true)
  })

  it('aggregates diff files with prefixed paths from configured git repositories', async () => {
    const backend = join(tempDir, 'backend')
    const frontend = join(tempDir, 'frontend')
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(backend, { recursive: true })
    await mkdir(frontend, { recursive: true })
    await mkdir(openfoxDir, { recursive: true })

    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({ projects: [{ name: 'backend', path: 'backend' }, { name: 'frontend', path: 'frontend' }] }),
    )

    // Init git in backend with initial commit
    execSync('git init && git config user.name "Test" && git config user.email "test@example.com"', { cwd: backend })
    await writeFile(join(backend, 'server.ts'), 'console.log("initial")')
    execSync('git add . && git commit -m "init backend"', { cwd: backend })

    // Init git in frontend with initial commit
    execSync('git init && git config user.name "Test" && git config user.email "test@example.com"', { cwd: frontend })
    await writeFile(join(frontend, 'App.tsx'), 'export const App = () => 1')
    execSync('git add . && git commit -m "init frontend"', { cwd: frontend })

    // Modify backend file
    await writeFile(join(backend, 'server.ts'), 'console.log("modified")')

    // Add untracked frontend file
    await writeFile(join(frontend, 'style.css'), 'body {}')

    const diffFiles = await multirepoVcsProvider.getDiffFiles({ workdir: tempDir })
    expect(diffFiles).toHaveLength(2)

    const backendDiff = diffFiles.find((f: PluginVcsDiffFile) => f.path === 'backend/server.ts')
    expect(backendDiff).toBeDefined()
    expect(backendDiff?.status).toBe('modified')

    const frontendDiff = diffFiles.find((f: PluginVcsDiffFile) => f.path === 'frontend/style.css')
    expect(frontendDiff).toBeDefined()
    expect(frontendDiff?.status).toBe('added')
  })

  it('resolves unified branch name when all configured repos are on the same branch', async () => {
    const backend = join(tempDir, 'backend')
    const frontend = join(tempDir, 'frontend')
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(backend, { recursive: true })
    await mkdir(frontend, { recursive: true })
    await mkdir(openfoxDir, { recursive: true })

    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({ projects: ['backend', 'frontend'] }),
    )

    execSync('git init -b main && git config user.name "Test" && git config user.email "test@example.com"', { cwd: backend })
    await writeFile(join(backend, 'a.txt'), 'a')
    execSync('git add . && git commit -m "init"', { cwd: backend })

    execSync('git init -b main && git config user.name "Test" && git config user.email "test@example.com"', { cwd: frontend })
    await writeFile(join(frontend, 'b.txt'), 'b')
    execSync('git add . && git commit -m "init"', { cwd: frontend })

    const branch = await multirepoVcsProvider.getBranch?.({ workdir: tempDir })
    expect(branch).toBe('multi [main]')
  })

  it('resolves detailed branch names when repos are on different branches', async () => {
    const backend = join(tempDir, 'backend')
    const frontend = join(tempDir, 'frontend')
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(backend, { recursive: true })
    await mkdir(frontend, { recursive: true })
    await mkdir(openfoxDir, { recursive: true })

    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({ projects: ['backend', 'frontend'] }),
    )

    execSync('git init -b main && git config user.name "Test" && git config user.email "test@example.com"', { cwd: backend })
    await writeFile(join(backend, 'a.txt'), 'a')
    execSync('git add . && git commit -m "init"', { cwd: backend })

    execSync('git init -b feat-ui && git config user.name "Test" && git config user.email "test@example.com"', { cwd: frontend })
    await writeFile(join(frontend, 'b.txt'), 'b')
    execSync('git add . && git commit -m "init"', { cwd: frontend })

    const branch = await multirepoVcsProvider.getBranch?.({ workdir: tempDir })
    expect(branch).toBe('multi [backend:main, frontend:feat-ui]')
  })

  it('formats modified files correctly', () => {
    expect(multirepoVcsProvider.formatModifiedFiles?.([], { workdir: tempDir })).toBe('(none)')
    expect(
      multirepoVcsProvider.formatModifiedFiles?.(
        [
          { path: 'backend/server.ts', status: 'modified' },
          { path: 'frontend/styles.css', status: 'added' },
        ],
        { workdir: tempDir },
      ),
    ).toBe('- backend/server.ts (modified)\n- frontend/styles.css (added)')
  })

  it('filters diff files and formats according to session modified files', async () => {
    const backend = join(tempDir, 'backend')
    const frontend = join(tempDir, 'frontend')
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(backend, { recursive: true })
    await mkdir(frontend, { recursive: true })
    await mkdir(openfoxDir, { recursive: true })

    await writeFile(
      join(openfoxDir, 'openfox-multi-repo.json'),
      JSON.stringify({ projects: [{ name: 'backend', path: 'backend' }, { name: 'frontend', path: 'frontend' }] }),
    )

    execSync('git init && git config user.name "Test" && git config user.email "test@example.com"', { cwd: backend })
    await writeFile(join(backend, 'server.ts'), 'console.log("initial")')
    execSync('git add . && git commit -m "init backend"', { cwd: backend })

    execSync('git init && git config user.name "Test" && git config user.email "test@example.com"', { cwd: frontend })
    await writeFile(join(frontend, 'App.tsx'), 'export const App = () => 1')
    execSync('git add . && git commit -m "init frontend"', { cwd: frontend })

    await writeFile(join(backend, 'server.ts'), 'console.log("modified")')
    await writeFile(join(frontend, 'style.css'), 'body {}')

    recordSessionModifiedFile('session-abc', 'backend/server.ts')

    const allDiff = await multirepoVcsProvider.getDiffFiles({ workdir: tempDir })
    expect(allDiff).toHaveLength(2)

    const sessionDiff = await multirepoVcsProvider.getDiffFiles({ workdir: tempDir, sessionId: 'session-abc' })
    expect(sessionDiff).toHaveLength(1)
    expect(sessionDiff[0]?.path).toBe('backend/server.ts')

    const formattedSession = multirepoVcsProvider.formatModifiedFiles?.(allDiff, {
      workdir: tempDir,
      sessionId: 'session-abc',
    })
    expect(formattedSession).toBe('- backend/server.ts (modified)')

    const emptySessionDiff = await multirepoVcsProvider.getDiffFiles({
      workdir: tempDir,
      sessionId: 'session-empty',
    })
    expect(emptySessionDiff).toHaveLength(0)

    const formattedEmpty = multirepoVcsProvider.formatModifiedFiles?.(allDiff, {
      workdir: tempDir,
      sessionId: 'session-empty',
    })
    expect(formattedEmpty).toBe('(none)')

    const mockDisabledContext: PluginContext = {
      id: 'test',
      version: '1.0',
      runtime: { mode: 'development', configDirectory: tempDir },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      storage: { get: () => undefined, set: vi.fn() },
      settings: () => ({ sessionModifiedFilesOnly: false }),
      notify: vi.fn(),
      publish: vi.fn(),
    }
    setTrackerContext(mockDisabledContext)

    const disabledDiff = await multirepoVcsProvider.getDiffFiles({
      workdir: tempDir,
      sessionId: 'session-abc',
    })
    expect(disabledDiff).toHaveLength(2)

    const formattedDisabled = multirepoVcsProvider.formatModifiedFiles?.(allDiff, {
      workdir: tempDir,
      sessionId: 'session-abc',
    })
    expect(formattedDisabled).toBe('- backend/server.ts (modified)\n- frontend/style.css (added)')
  })
})
