import { spawn } from 'node:child_process'

export function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }))
    proc.on('error', (err) => resolve({ stdout: '', stderr: err.message, code: 1 }))
  })
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  const res = await runGit(repoPath, ['branch', '--show-current'])
  if (res.code === 0 && res.stdout.trim()) {
    return res.stdout.trim()
  }
  const rev = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return rev.code === 0 && rev.stdout.trim() ? rev.stdout.trim() : 'HEAD (detached)'
}

export async function listRepoBranches(repoPath: string): Promise<string[]> {
  const res = await runGit(repoPath, ['branch', '--format=%(refname:short)'])
  if (res.code !== 0) return []

  return res.stdout
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
}

export async function switchRepoBranch(repoPath: string, branchName: string): Promise<{ success: boolean; error?: string }> {
  const res = await runGit(repoPath, ['checkout', branchName])
  if (res.code === 0) {
    return { success: true }
  }
  return { success: false, error: res.stderr.trim() || `Failed to checkout ${branchName}` }
}

export async function getRepoDefaultBranch(repoPath: string): Promise<string> {
  const head = await runGit(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.code === 0 && head.stdout.trim()) {
    return head.stdout.trim().replace(/^origin\//, '')
  }
  const init = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])
  if (init.code === 0 && init.stdout.trim()) {
    return init.stdout.trim().replace(/^origin\//, '')
  }
  return 'main'
}

export async function createRepoBranch(
  repoPath: string,
  branchName: string,
  sourceBranch?: string,
): Promise<{ success: boolean; error?: string }> {
  const args = sourceBranch ? ['checkout', '-b', branchName, sourceBranch] : ['checkout', '-b', branchName]
  const res = await runGit(repoPath, args)
  if (res.code === 0) {
    return { success: true }
  }
  return { success: false, error: res.stderr.trim() || `Failed to create branch ${branchName}` }
}
