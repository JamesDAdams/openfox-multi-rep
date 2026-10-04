import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { getCurrentBranch, listRepoBranches, switchRepoBranch, createRepoBranch } from './git-ops.js'

describe('git-ops module', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'multirepo-gitops-test-'))
    execSync('git init -b main && git config user.name "Test" && git config user.email "test@example.com"', { cwd: tempDir })
    await writeFile(join(tempDir, 'README.md'), '# test')
    execSync('git add . && git commit -m "init"', { cwd: tempDir })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('gets current branch name', async () => {
    const branch = await getCurrentBranch(tempDir)
    expect(branch).toBe('main')
  })

  it('lists repository branches', async () => {
    execSync('git branch feat/test-1', { cwd: tempDir })
    execSync('git branch feat/test-2', { cwd: tempDir })

    const branches = await listRepoBranches(tempDir)
    expect(branches).toContain('main')
    expect(branches).toContain('feat/test-1')
    expect(branches).toContain('feat/test-2')
  })

  it('creates and switches branches', async () => {
    const createRes = await createRepoBranch(tempDir, 'feat/new-feature')
    expect(createRes.success).toBe(true)
    expect(await getCurrentBranch(tempDir)).toBe('feat/new-feature')

    const switchRes = await switchRepoBranch(tempDir, 'main')
    expect(switchRes.success).toBe(true)
    expect(await getCurrentBranch(tempDir)).toBe('main')
  })
})
