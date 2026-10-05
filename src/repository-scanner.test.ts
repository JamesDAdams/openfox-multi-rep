import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanGitRepositories,
  getConfiguredProjectPaths,
  addProjectsToMultiRepoConfig,
  syncProjectsWithMultiRepoConfig,
} from './repository-scanner.js'

describe('repository-scanner module', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'multirepo-scan-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('detects git repositories with .git directory and .git file beneath root', async () => {
    // Child repo with .git directory
    await mkdir(join(tempDir, 'backend', '.git'), { recursive: true })
    // Child repo with .git file (e.g. submodule or worktree)
    await mkdir(join(tempDir, 'frontend'), { recursive: true })
    await writeFile(join(tempDir, 'frontend', '.git'), 'gitdir: ../.git/worktrees/frontend')

    const result = await scanGitRepositories(tempDir)
    expect(result.errors).toHaveLength(0)
    expect(result.repos).toHaveLength(2)
    expect(result.repos[0]?.name).toBe('backend')
    expect(result.repos[0]?.relativePath).toBe('backend')
    expect(result.repos[1]?.name).toBe('frontend')
    expect(result.repos[1]?.relativePath).toBe('frontend')
  })

  it('detects nested git repositories', async () => {
    // packages/mono/service-a with .git
    await mkdir(join(tempDir, 'packages', 'mono', 'service-a', '.git'), { recursive: true })
    // packages/mono/service-b with .git
    await mkdir(join(tempDir, 'packages', 'mono', 'service-b', '.git'), { recursive: true })

    const result = await scanGitRepositories(tempDir)
    expect(result.errors).toHaveLength(0)
    expect(result.repos).toHaveLength(2)
    expect(result.repos[0]?.relativePath).toBe('packages/mono/service-a')
    expect(result.repos[1]?.relativePath).toBe('packages/mono/service-b')
  })

  it('excludes node_modules, dist, build, .cache, .openfox, .venv and other excluded directories', async () => {
    // Valid repo
    await mkdir(join(tempDir, 'services', 'valid-api', '.git'), { recursive: true })
    // False repos in excluded directories
    await mkdir(join(tempDir, 'node_modules', 'some-pkg', '.git'), { recursive: true })
    await mkdir(join(tempDir, 'dist', 'bundle-repo', '.git'), { recursive: true })
    await mkdir(join(tempDir, '.openfox', 'internal-repo', '.git'), { recursive: true })
    await mkdir(join(tempDir, '.cache', 'cached-repo', '.git'), { recursive: true })
    await mkdir(join(tempDir, 'build', 'build-repo', '.git'), { recursive: true })

    const result = await scanGitRepositories(tempDir)
    expect(result.repos).toHaveLength(1)
    expect(result.repos[0]?.relativePath).toBe('services/valid-api')
  })

  it('ignores symbolic links', async () => {
    await mkdir(join(tempDir, 'real-repo', '.git'), { recursive: true })
    // Symlink to real-repo
    try {
      await symlink(join(tempDir, 'real-repo'), join(tempDir, 'symlink-repo'), 'dir')
    } catch {
      // Symlink creation might require privileges on some systems
    }

    const result = await scanGitRepositories(tempDir)
    // Only real-repo is returned
    expect(result.repos.map((r) => r.relativePath)).toContain('real-repo')
    expect(result.repos.map((r) => r.relativePath)).not.toContain('symlink-repo')
  })

  it('reads configured project paths with path, dynamic keys, or string shorthand', async () => {
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(openfoxDir, { recursive: true })

    const config = {
      projects: [
        { name: 'openfox', path: './openfox', dev: 'npm run dev' },
        { name: 'agent-office', path: 'agent-office' },
        { name: 'legacy', './legacy-repo': 'frontend' },
        'string-repo',
      ],
    }

    await writeFile(join(openfoxDir, 'openfox-multi-repo.json'), JSON.stringify(config, null, 2))

    const configured = await getConfiguredProjectPaths(tempDir)
    expect(configured.has('openfox')).toBe(true)
    expect(configured.has('agent-office')).toBe(true)
    expect(configured.has('legacy-repo')).toBe(true)
    expect(configured.has('string-repo')).toBe(true)
    expect(configured.has('unknown')).toBe(false)
  })

  it('creates .openfox/openfox-multi-repo.json if not present and adds projects with only name and path', async () => {
    const result = await addProjectsToMultiRepoConfig(tempDir, [
      { name: 'service-a', relativePath: 'services/service-a' },
      { name: 'service-b', relativePath: 'services/service-b' },
    ])

    expect(result.success).toBe(true)
    expect(result.addedCount).toBe(2)

    const content = await readFile(join(tempDir, '.openfox', 'openfox-multi-repo.json'), 'utf8')
    const parsed = JSON.parse(content) as { projects: Array<{ name: string; path: string; dev?: unknown; commands?: unknown }> }

    expect(parsed.projects).toHaveLength(2)
    expect(parsed.projects[0]).toEqual({
      name: 'service-a',
      path: './services/service-a',
    })
    expect(parsed.projects[1]).toEqual({
      name: 'service-b',
      path: './services/service-b',
    })
    // No dev or commands added
    expect(parsed.projects[0]?.dev).toBeUndefined()
    expect(parsed.projects[0]?.commands).toBeUndefined()
  })

  it('appends to existing config preserving unknown properties, existing projects and dev servers', async () => {
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(openfoxDir, { recursive: true })

    const initial = {
      $schema: 'https://openfox.dev/schema.json',
      customSetting: 42,
      projects: [
        {
          name: 'existing-api',
          path: './existing-api',
          dev: [{ name: 'dev', command: 'npm run dev' }],
        },
      ],
    }
    await writeFile(join(openfoxDir, 'openfox-multi-repo.json'), JSON.stringify(initial, null, 2))

    const result = await addProjectsToMultiRepoConfig(tempDir, [
      { name: 'new-client', relativePath: 'new-client' },
    ])

    expect(result.success).toBe(true)
    expect(result.addedCount).toBe(1)

    const content = await readFile(join(openfoxDir, 'openfox-multi-repo.json'), 'utf8')
    const parsed = JSON.parse(content) as Record<string, unknown>

    expect(parsed['$schema']).toBe('https://openfox.dev/schema.json')
    expect(parsed['customSetting']).toBe(42)

    const projects = parsed['projects'] as Array<{ name: string; path: string; dev?: unknown }>
    expect(projects).toHaveLength(2)
    expect(projects[0]?.name).toBe('existing-api')
    expect(projects[0]?.dev).toBeDefined()
    expect(projects[1]).toEqual({
      name: 'new-client',
      path: './new-client',
    })
  })

  it('deduplicates and skips projects whose paths are already in config', async () => {
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(openfoxDir, { recursive: true })

    const initial = {
      projects: [
        { name: 'openfox', path: './openfox' },
      ],
    }
    await writeFile(join(openfoxDir, 'openfox-multi-repo.json'), JSON.stringify(initial, null, 2))

    const result = await addProjectsToMultiRepoConfig(tempDir, [
      { name: 'openfox', relativePath: 'openfox' },
      { name: 'agent-office', relativePath: 'agent-office' },
    ])

    expect(result.success).toBe(true)
    expect(result.addedCount).toBe(1)

    const content = await readFile(join(openfoxDir, 'openfox-multi-repo.json'), 'utf8')
    const parsed = JSON.parse(content) as { projects: Array<{ name: string; path: string }> }
    expect(parsed.projects).toHaveLength(2)
    expect(parsed.projects[1]?.name).toBe('agent-office')
  })

  it('rejects path traversal attempts outside workspace', async () => {
    const result = await addProjectsToMultiRepoConfig(tempDir, [
      { name: 'escaped', relativePath: '../../escaped-repo' },
    ])

    expect(result.success).toBe(false)
    expect(result.addedCount).toBe(0)
    expect(result.error).toContain('outside workspace')
  })

  it('rejects without overwriting if existing config contains invalid JSON', async () => {
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(openfoxDir, { recursive: true })
    const brokenJson = '{ invalid json content'
    await writeFile(join(openfoxDir, 'openfox-multi-repo.json'), brokenJson)

    const result = await addProjectsToMultiRepoConfig(tempDir, [
      { name: 'test', relativePath: 'test' },
    ])

    expect(result.success).toBe(false)
    expect(result.addedCount).toBe(0)
    expect(result.error).toContain('invalid JSON')

    // Verify file content is intact and was not overwritten
    const content = await readFile(join(openfoxDir, 'openfox-multi-repo.json'), 'utf8')
    expect(content).toBe(brokenJson)
  })

  it('syncProjectsWithMultiRepoConfig adds new, keeps existing with dev commands, and removes deselected', async () => {
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(openfoxDir, { recursive: true })

    const initial = {
      projects: [
        {
          name: 'project-a',
          path: './project-a',
          dev: [{ name: 'dev', command: 'npm run dev' }],
        },
        {
          name: 'project-b',
          path: './project-b',
        },
      ],
    }
    await writeFile(join(openfoxDir, 'openfox-multi-repo.json'), JSON.stringify(initial, null, 2))

    const discovered = [
      { name: 'project-a', relativePath: 'project-a', absolutePath: join(tempDir, 'project-a') },
      { name: 'project-b', relativePath: 'project-b', absolutePath: join(tempDir, 'project-b') },
      { name: 'project-c', relativePath: 'project-c', absolutePath: join(tempDir, 'project-c') },
    ]

    // User keeps project-a, unchecks project-b, and checks project-c
    const selected = new Set(['project-a', 'project-c'])

    const result = await syncProjectsWithMultiRepoConfig(tempDir, selected, discovered)
    expect(result.success).toBe(true)
    expect(result.addedCount).toBe(1)
    expect(result.removedCount).toBe(1)
    expect(result.totalConfigured).toBe(2)

    const raw = await readFile(join(openfoxDir, 'openfox-multi-repo.json'), 'utf8')
    const parsed = JSON.parse(raw) as {
      projects: Array<{ name: string; path: string; dev?: unknown }>
    }

    expect(parsed.projects).toHaveLength(2)
    // project-a kept with dev intact
    expect(parsed.projects[0]?.name).toBe('project-a')
    expect(parsed.projects[0]?.dev).toBeDefined()
    // project-b removed
    expect(parsed.projects.find((p) => p.name === 'project-b')).toBeUndefined()
    // project-c added without dev
    const projC = parsed.projects.find((p) => p.name === 'project-c')
    expect(projC).toBeDefined()
    expect(projC?.path).toBe('./project-c')
    expect(projC?.dev).toBeUndefined()
  })
})
