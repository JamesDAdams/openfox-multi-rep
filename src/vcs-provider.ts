import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { PluginVcsContext, PluginVcsDiffFile, PluginVcsProvider } from 'openfox/plugin'
import { findSubGitRepos, isMultiRepoProject, type GitRepoInfo } from './discovery.js'
import { getSessionModifiedFiles, isSessionFilterEnabled, isFileInSession } from './session-tracker.js'

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let stdout = ''
    proc.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    proc.on('close', (code) => resolve({ stdout, code: code ?? 0 }))
    proc.on('error', () => resolve({ stdout: '', code: 1 }))
  })
}

async function getRepoDiff(repo: GitRepoInfo): Promise<PluginVcsDiffFile[]> {
  const [diffRes, statusRes] = await Promise.all([
    runGit(repo.absolutePath, ['diff', '--ignore-submodules=none', '--name-status', 'HEAD']),
    runGit(repo.absolutePath, ['status', '--porcelain', '--ignore-submodules=none']),
  ])

  const files: PluginVcsDiffFile[] = []
  const seenPaths = new Set<string>()

  const addFile = (rawPath: string, status: PluginVcsDiffFile['status']) => {
    let filePath = rawPath.trim()
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1)
    }
    if (!filePath) return

    const relativePath = repo.relativePath === '.' ? filePath : join(repo.relativePath, filePath)
    if (!seenPaths.has(relativePath)) {
      seenPaths.add(relativePath)
      files.push({ path: relativePath, status })
    }
  }

  // Parse git status --porcelain (captures staged, unstaged, untracked, deleted, renamed)
  if (statusRes.code === 0) {
    for (const rawLine of statusRes.stdout.split('\n')) {
      const line = rawLine.trimEnd()
      if (!line || line.length < 3) continue
      const statusCode = line.slice(0, 2)
      let filePath = line.slice(3).trim()

      if (filePath.includes(' -> ')) {
        filePath = filePath.split(' -> ')[1]!.trim()
      }

      let status: PluginVcsDiffFile['status'] = 'modified'
      if (statusCode.includes('A') || statusCode.includes('?')) {
        status = 'added'
      } else if (statusCode.includes('D')) {
        status = 'deleted'
      } else {
        status = 'modified'
      }

      addFile(filePath, status)
    }
  }

  // Also parse git diff HEAD
  if (diffRes.code === 0) {
    for (const rawLine of diffRes.stdout.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      const [statusChar, ...parts] = line.split('\t')
      const filePath = parts.join('\t') || ''
      if (!filePath) continue

      const status: PluginVcsDiffFile['status'] =
        statusChar === 'A' ? 'added' : statusChar === 'D' ? 'deleted' : 'modified'
      addFile(filePath, status)
    }
  }

  return files
}

async function getRepoBranch(repo: GitRepoInfo): Promise<string | null> {
  const res = await runGit(repo.absolutePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : null
}

export const multirepoVcsProvider: PluginVcsProvider = {
  id: 'openfox-multirepo-vcs',
  priority: 10,

  async detect(context: PluginVcsContext): Promise<boolean> {
    return isMultiRepoProject(context.workdir)
  },

  async getDiffFiles(context: PluginVcsContext): Promise<PluginVcsDiffFile[]> {
    const repos = await findSubGitRepos(context.workdir)
    const diffArrays = await Promise.all(repos.map((repo) => getRepoDiff(repo)))
    const allFiles = diffArrays.flat()

    if (!context.sessionId || !isSessionFilterEnabled(context.projectId)) {
      return allFiles
    }

    const sessionFiles = getSessionModifiedFiles(context.sessionId, context.workdir)
    return allFiles.filter((f) => isFileInSession(f.path, sessionFiles, context.workdir))
  },

  async getBranch(context: PluginVcsContext): Promise<string | null> {
    const repos = await findSubGitRepos(context.workdir)
    if (repos.length === 0) return null

    const branches = await Promise.all(
      repos.map(async (r) => ({ name: r.name, branch: (await getRepoBranch(r)) ?? 'detached' })),
    )

    const uniqueBranches = new Set(branches.map((b) => b.branch))
    if (uniqueBranches.size === 1) {
      return `multi [${[...uniqueBranches][0]}]`
    }

    return `multi [${branches.map((b) => `${b.name}:${b.branch}`).join(', ')}]`
  },

  formatModifiedFiles(files: PluginVcsDiffFile[], context?: PluginVcsContext): string {
    let targetFiles = files
    if (context?.sessionId && isSessionFilterEnabled(context?.projectId)) {
      const sessionFiles = getSessionModifiedFiles(context.sessionId, context.workdir)
      targetFiles = files.filter((f) => isFileInSession(f.path, sessionFiles, context.workdir))
    }

    if (targetFiles.length === 0) return '(none)'
    return targetFiles.map((f) => `- ${f.path} (${f.status})`).join('\n')
  },
}
