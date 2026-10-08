import { readdir, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, basename } from 'node:path'
import { parseCompactTableString } from './discovery.js'

export interface DiscoveredGitRepo {
  name: string
  relativePath: string
  absolutePath: string
}

export interface ScanResult {
  repos: DiscoveredGitRepo[]
  errors: string[]
}

export interface SaveProjectsResult {
  success: boolean
  addedCount: number
  error?: string
}

const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  '__pycache__',
  '.openfox',
  '.venv',
  'venv',
  'target',
  'tmp',
  'temp',
])

const RESERVED_METADATA_KEYS = new Set([
  'name',
  'dev',
  'servers',
  'commands',
  'command',
  'start',
  'port',
  'type',
  'scripts',
  'description',
])

export function normalizeRepoPath(p: string): string {
  const trimmed = p.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  return trimmed || '.'
}

/**
 * Recursively scans for Git repositories beneath `rootWorkdir`.
 * Skips symlinks, Git internals, and dependency/build/cache directories.
 * Recurses into subdirectories (even within detected repositories) to find nested repos.
 */
export async function scanGitRepositories(rootWorkdir: string): Promise<ScanResult> {
  const repos: DiscoveredGitRepo[] = []
  const errors: string[] = []

  async function walk(currentAbs: string, currentRel: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(currentAbs, { withFileTypes: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(msg)
      return
    }

    // Check if the current directory itself has a .git entry (directory or regular file, not a symlink)
    // Only consider subdirectories below rootWorkdir (currentRel !== '')
    if (currentRel !== '') {
      const gitEntry = entries.find((e) => e.name === '.git')
      if (gitEntry && !gitEntry.isSymbolicLink() && (gitEntry.isDirectory() || gitEntry.isFile())) {
        const repoName = basename(currentRel) || currentRel
        repos.push({
          name: repoName,
          relativePath: currentRel,
          absolutePath: currentAbs,
        })
      }
    }

    // Traverse child directories
    for (const entry of entries) {
      // Exclude symlinks
      if (entry.isSymbolicLink()) {
        continue
      }
      if (!entry.isDirectory()) {
        continue
      }
      if (EXCLUDED_DIR_NAMES.has(entry.name)) {
        continue
      }

      const nextRel = currentRel ? `${currentRel}/${entry.name}` : entry.name
      const nextAbs = join(currentAbs, entry.name)
      await walk(nextAbs, nextRel)
    }
  }

  await walk(rootWorkdir, '')

  repos.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

  return { repos, errors }
}

export function getProjectPathFromConfigEntry(item: unknown): string | null {
  if (typeof item === 'string') {
    return normalizeRepoPath(item)
  }
  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>
    let p: string | undefined =
      typeof obj['path'] === 'string' ? obj['path'] :
      typeof obj['dir'] === 'string' ? obj['dir'] :
      typeof obj['folder'] === 'string' ? obj['folder'] :
      typeof obj['cwd'] === 'string' ? obj['cwd'] :
      typeof obj['directory'] === 'string' ? obj['directory'] :
      typeof obj['location'] === 'string' ? obj['location'] :
      typeof obj['repo'] === 'string' ? obj['repo'] :
      typeof obj['repository'] === 'string' ? obj['repository'] :
      undefined

    if (!p) {
      for (const key of Object.keys(obj)) {
        if (key.startsWith('./') || key.startsWith('../') || key.includes('/')) {
          p = key
          break
        }
      }
    }

    if (!p) {
      for (const key of Object.keys(obj)) {
        if (!RESERVED_METADATA_KEYS.has(key)) {
          p = key
          break
        }
      }
    }

    if (p) {
      return normalizeRepoPath(p)
    }
    if (typeof obj['name'] === 'string') {
      return normalizeRepoPath(obj['name'])
    }
  }
  return null
}

/**
 * Extracts normalized relative paths for all projects currently declared in .openfox/openfox-multi-repo.json
 */
export async function getConfiguredProjectPaths(rootWorkdir: string): Promise<Set<string>> {
  const configured = new Set<string>()
  try {
    const configPath = join(rootWorkdir, '.openfox', 'openfox-multi-repo.json')
    const content = await readFile(configPath, 'utf8')
    let rawProjects: Array<unknown> = []
    if (content.trim().startsWith('[')) {
      rawProjects = parseCompactTableString(content)
    } else {
      const parsed = JSON.parse(content) as { projects?: Array<unknown> | string }
      if (Array.isArray(parsed?.projects)) {
        rawProjects = parsed.projects
      } else if (typeof parsed?.projects === 'string') {
        rawProjects = parseCompactTableString(parsed.projects)
      }
    }

    for (const item of rawProjects) {
      const p = getProjectPathFromConfigEntry(item)
      if (p) {
        configured.add(p)
      }
    }
  } catch {
    // Missing or invalid config returns empty set
  }

  return configured
}

export interface SyncProjectsResult {
  success: boolean
  addedCount: number
  removedCount: number
  totalConfigured: number
  error?: string
}

/**
 * Synchronizes selected projects with .openfox/openfox-multi-repo.json atomically.
 * - Selected projects not in config are appended as { name, path }
 * - Selected projects already in config are preserved with their dev/commands intact
 * - Deselected projects previously in config are removed
 * - Preserves unknown top-level properties and unmonitored projects
 */
export async function syncProjectsWithMultiRepoConfig(
  rootWorkdir: string,
  selectedRelativePaths: Set<string>,
  discoveredProjects: DiscoveredGitRepo[],
): Promise<SyncProjectsResult> {
  // 1. Path containment validation
  for (const relPath of selectedRelativePaths) {
    const abs = resolve(rootWorkdir, relPath)
    const rel = relative(rootWorkdir, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        success: false,
        addedCount: 0,
        removedCount: 0,
        totalConfigured: 0,
        error: `Invalid path outside workspace: ${relPath}`,
      }
    }
  }

  const openfoxDir = join(rootWorkdir, '.openfox')
  const configPath = join(openfoxDir, 'openfox-multi-repo.json')

  let existingParsed: Record<string, unknown> | null = null
  let fileExisted = false

  try {
    const raw = await readFile(configPath, 'utf8')
    fileExisted = true
    try {
      existingParsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {
        success: false,
        addedCount: 0,
        removedCount: 0,
        totalConfigured: 0,
        error: 'Existing .openfox/openfox-multi-repo.json contains invalid JSON. File not modified.',
      }
    }
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code
    if (code !== 'ENOENT') {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        addedCount: 0,
        removedCount: 0,
        totalConfigured: 0,
        error: `Cannot read configuration: ${msg}`,
      }
    }
  }

  if (fileExisted && (typeof existingParsed !== 'object' || existingParsed === null || Array.isArray(existingParsed))) {
    return {
      success: false,
      addedCount: 0,
      removedCount: 0,
      totalConfigured: 0,
      error: 'Existing configuration root is not a valid JSON object.',
    }
  }

  const baseObject: Record<string, unknown> = existingParsed ? { ...existingParsed } : {}
  const existingProjectsList: unknown[] = Array.isArray(baseObject['projects'])
    ? [...baseObject['projects']]
    : []

  const detectedNormMap = new Map<string, DiscoveredGitRepo>()
  for (const repo of discoveredProjects) {
    detectedNormMap.set(normalizeRepoPath(repo.relativePath), repo)
  }

  const selectedNormSet = new Set<string>()
  for (const p of selectedRelativePaths) {
    selectedNormSet.add(normalizeRepoPath(p))
  }

  let addedCount = 0
  let removedCount = 0
  const nextProjects: unknown[] = []
  const retainedNormPaths = new Set<string>()

  const deselectedNames = new Set<string>()
  for (const repo of discoveredProjects) {
    const norm = normalizeRepoPath(repo.relativePath)
    if (!selectedNormSet.has(norm)) {
      deselectedNames.add(repo.name)
    }
  }

  for (const item of existingProjectsList) {
    const norm = getProjectPathFromConfigEntry(item)
    const itemObj = item && typeof item === 'object' ? (item as Record<string, unknown>) : null
    const itemName = itemObj && typeof itemObj['name'] === 'string' ? itemObj['name'] : (typeof item === 'string' ? item : null)

    const isUnderTmp = norm && (norm.startsWith('tmp/') || norm.startsWith('openfox/tmp/') || norm.includes('/tmp/'))
    const isDetected = norm && detectedNormMap.has(norm)
    const isNameDeselected = itemName && deselectedNames.has(itemName) && !selectedNormSet.has(norm ?? '')

    if (isUnderTmp) {
      removedCount++
      continue
    }

    if (isDetected) {
      if (selectedNormSet.has(norm!)) {
        nextProjects.push(item)
        retainedNormPaths.add(norm!)
      } else {
        removedCount++
      }
    } else if (isNameDeselected) {
      removedCount++
    } else {
      nextProjects.push(item)
      if (norm) {
        retainedNormPaths.add(norm)
      }
    }
  }

  for (const norm of selectedNormSet) {
    if (!retainedNormPaths.has(norm)) {
      const discovered = detectedNormMap.get(norm)
      const name = discovered?.name ?? (basename(norm) || norm)
      nextProjects.push({
        name,
        path: `./${norm}`,
      })
      retainedNormPaths.add(norm)
      addedCount++
    }
  }

  const updatedConfig: Record<string, unknown> = {
    ...baseObject,
    projects: nextProjects,
  }

  await mkdir(openfoxDir, { recursive: true })
  const tempPath = join(
    openfoxDir,
    `openfox-multi-repo.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  )

  try {
    const jsonOutput = JSON.stringify(updatedConfig, null, 2) + '\n'
    await writeFile(tempPath, jsonOutput, 'utf8')
    await rename(tempPath, configPath)
    return {
      success: true,
      addedCount,
      removedCount,
      totalConfigured: nextProjects.length,
    }
  } catch (err: unknown) {
    try {
      await rm(tempPath, { force: true })
    } catch {
      // ignore
    }
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      addedCount: 0,
      removedCount: 0,
      totalConfigured: 0,
      error: `Failed to write configuration: ${msg}`,
    }
  }
}

/**
 * Adds selected projects to .openfox/openfox-multi-repo.json atomically.
 * Appends objects containing only name and path (no dev/commands).
 * Preserves existing projects and top-level fields, avoids duplicate paths, and rejects malformed JSON.
 */
export async function addProjectsToMultiRepoConfig(
  rootWorkdir: string,
  newProjects: Array<{ name: string; relativePath: string }>,
): Promise<SaveProjectsResult> {
  if (!newProjects || newProjects.length === 0) {
    return { success: true, addedCount: 0 }
  }

  // 1. Path containment validation
  for (const proj of newProjects) {
    const abs = resolve(rootWorkdir, proj.relativePath)
    const rel = relative(rootWorkdir, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        success: false,
        addedCount: 0,
        error: `Invalid path outside workspace: ${proj.relativePath}`,
      }
    }
  }

  const openfoxDir = join(rootWorkdir, '.openfox')
  const configPath = join(openfoxDir, 'openfox-multi-repo.json')

  let existingParsed: Record<string, unknown> | null = null
  let fileExisted = false

  try {
    const raw = await readFile(configPath, 'utf8')
    fileExisted = true
    try {
      existingParsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {
        success: false,
        addedCount: 0,
        error: 'Existing .openfox/openfox-multi-repo.json contains invalid JSON. File not modified.',
      }
    }
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code
    if (code !== 'ENOENT') {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        addedCount: 0,
        error: `Cannot read configuration: ${msg}`,
      }
    }
  }

  if (fileExisted && (typeof existingParsed !== 'object' || existingParsed === null || Array.isArray(existingParsed))) {
    return {
      success: false,
      addedCount: 0,
      error: 'Existing configuration root is not a valid JSON object.',
    }
  }

  // 2. Identify currently configured paths
  const configuredPaths = await getConfiguredProjectPaths(rootWorkdir)

  // 3. Filter candidate projects to avoid duplicates
  const projectsToAdd: Array<{ name: string; path: string }> = []
  for (const proj of newProjects) {
    const norm = normalizeRepoPath(proj.relativePath)
    if (configuredPaths.has(norm)) {
      continue
    }
    configuredPaths.add(norm)
    projectsToAdd.push({
      name: proj.name,
      path: `./${norm}`,
    })
  }

  if (projectsToAdd.length === 0) {
    return { success: true, addedCount: 0 }
  }

  // 4. Build output data preserving unknown properties and existing projects
  const baseObject: Record<string, unknown> = existingParsed ? { ...existingParsed } : {}
  const existingProjectsList: unknown[] = Array.isArray(baseObject['projects'])
    ? [...baseObject['projects']]
    : []

  const updatedConfig: Record<string, unknown> = {
    ...baseObject,
    projects: [...existingProjectsList, ...projectsToAdd],
  }

  // 5. Atomic write
  await mkdir(openfoxDir, { recursive: true })
  const tempPath = join(
    openfoxDir,
    `openfox-multi-repo.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  )

  try {
    const jsonOutput = JSON.stringify(updatedConfig, null, 2) + '\n'
    await writeFile(tempPath, jsonOutput, 'utf8')
    await rename(tempPath, configPath)
    return {
      success: true,
      addedCount: projectsToAdd.length,
    }
  } catch (err: unknown) {
    try {
      await rm(tempPath, { force: true })
    } catch {
      // ignore cleanup errors
    }
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      addedCount: 0,
      error: `Failed to write configuration: ${msg}`,
    }
  }
}
