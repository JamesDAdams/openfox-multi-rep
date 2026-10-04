import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type DevItemKind = 'server' | 'command'

export interface GitRepoInfo {
  name: string
  relativePath: string
  absolutePath: string
}

export interface DevServerService {
  id: string
  kind: DevItemKind
  name?: string
  icon?: string
  command: string
  projectName: string
  relativePath: string
  absolutePath: string
  port?: number
  separateLine?: boolean
}

export interface MultiRepoConfigProject {
  name: string
  relativePath: string
  absolutePath: string
  command?: string
  port?: number
  services?: DevServerService[]
}

export interface MultiRepoConfig {
  projects: MultiRepoConfigProject[]
}

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

function normalizePath(p: string): string {
  const trimmed = p.trim().replace(/^\.\//, '')
  return trimmed || '.'
}

function parseSingleServiceEntry(
  item: unknown,
  defaultKind: DevItemKind,
  projectName: string,
  relativePath: string,
  absolutePath: string,
  index: number,
): DevServerService | null {
  if (typeof item === 'string' && item.trim()) {
    const cmd = item.trim()
    return {
      id: `${projectName}:${defaultKind}:${index}:${cmd}`,
      kind: defaultKind,
      name: projectName,
      command: cmd,
      projectName,
      relativePath,
      absolutePath,
    }
  }

  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>
    const command =
      typeof obj['command'] === 'string' ? obj['command'].trim() :
      typeof obj['cmd'] === 'string' ? obj['cmd'].trim() :
      typeof obj['dev'] === 'string' ? obj['dev'].trim() :
      typeof obj['script'] === 'string' ? obj['script'].trim() :
      undefined

    if (!command) return null

    const kind: DevItemKind =
      obj['type'] === 'command' || obj['type'] === 'task' || defaultKind === 'command'
        ? 'command'
        : 'server'

    const name = typeof obj['name'] === 'string' && obj['name'].trim() ? obj['name'].trim() : undefined
    const icon = typeof obj['icon'] === 'string' && obj['icon'].trim() ? obj['icon'].trim() : undefined
    const port = typeof obj['port'] === 'number' ? obj['port'] : undefined
    const separateLine =
      obj['separateLine'] === true ||
      obj['newLine'] === true ||
      obj['dedicatedLine'] === true ||
      obj['line'] === 'dedicated' ||
      obj['line'] === 'separate'

    return {
      id: `${projectName}:${kind}:${index}:${name ?? command}`,
      kind,
      ...(name ? { name } : {}),
      ...(icon ? { icon } : {}),
      command,
      projectName,
      relativePath,
      absolutePath,
      ...(typeof port === 'number' ? { port } : {}),
      ...(separateLine ? { separateLine: true } : {}),
    }
  }

  return null
}

function parseServiceEntries(
  raw: unknown,
  defaultKind: DevItemKind,
  projectName: string,
  relativePath: string,
  absolutePath: string,
  startIndex = 0,
): DevServerService[] {
  if (!raw) return []

  if (typeof raw === 'string' && raw.trim()) {
    const cmd = raw.trim()
    return [
      {
        id: `${projectName}:${defaultKind}:${startIndex}:${cmd}`,
        kind: defaultKind,
        name: projectName,
        command: cmd,
        projectName,
        relativePath,
        absolutePath,
      },
    ]
  }

  if (Array.isArray(raw)) {
    const results: DevServerService[] = []
    raw.forEach((item, idx) => {
      const parsed = parseSingleServiceEntry(
        item,
        defaultKind,
        projectName,
        relativePath,
        absolutePath,
        startIndex + idx,
      )
      if (parsed) results.push(parsed)
    })
    return results
  }

  if (typeof raw === 'object') {
    const parsed = parseSingleServiceEntry(
      raw,
      defaultKind,
      projectName,
      relativePath,
      absolutePath,
      startIndex,
    )
    return parsed ? [parsed] : []
  }

  return []
}

async function tryDetectDevScript(projectDir: string): Promise<string | undefined> {
  try {
    const pkgJsonPath = join(projectDir, 'package.json')
    const content = await readFile(pkgJsonPath, 'utf8')
    const pkg = JSON.parse(content) as { scripts?: Record<string, string> }
    if (pkg.scripts?.['dev']) {
      return 'npm run dev'
    }
    if (pkg.scripts?.['start']) {
      return 'npm start'
    }
    return undefined
  } catch {
    return undefined
  }
}

export async function loadMultiRepoConfig(rootWorkdir: string): Promise<MultiRepoConfig | null> {
  try {
    const configPath = join(rootWorkdir, '.openfox', 'openfox-multi-repo.json')
    const content = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(content) as { projects?: Array<string | Record<string, unknown>> }
    if (!parsed || !Array.isArray(parsed.projects) || parsed.projects.length === 0) {
      return null
    }

    const projects: MultiRepoConfigProject[] = []

    for (const item of parsed.projects) {
      if (typeof item === 'string') {
        const relativePath = normalizePath(item)
        if (!relativePath) continue
        const absolutePath = join(rootWorkdir, relativePath)
        const command = await tryDetectDevScript(absolutePath)
        const services: DevServerService[] = command
          ? [
              {
                id: `${relativePath}:server:0:${command}`,
                kind: 'server',
                name: relativePath,
                command,
                projectName: relativePath,
                relativePath,
                absolutePath,
              },
            ]
          : []
        projects.push({
          name: relativePath,
          relativePath,
          absolutePath,
          ...(command ? { command } : {}),
          services,
        })
      } else if (item && typeof item === 'object') {
        let explicitPath: string | undefined =
          typeof item['path'] === 'string' ? item['path'] :
          typeof item['dir'] === 'string' ? item['dir'] :
          typeof item['folder'] === 'string' ? item['folder'] :
          typeof item['cwd'] === 'string' ? item['cwd'] :
          typeof item['directory'] === 'string' ? item['directory'] :
          typeof item['location'] === 'string' ? item['location'] :
          typeof item['repo'] === 'string' ? item['repo'] :
          typeof item['repository'] === 'string' ? item['repository'] :
          undefined

        // Look for custom keys formatted like "./hubgpat-bff": "bff" or "hubgpat-bff": "..."
        if (!explicitPath) {
          for (const key of Object.keys(item)) {
            if (key.startsWith('./') || key.startsWith('../') || key.includes('/')) {
              explicitPath = key
              break
            }
          }
        }

        if (!explicitPath) {
          for (const key of Object.keys(item)) {
            if (!RESERVED_METADATA_KEYS.has(key)) {
              explicitPath = key
              break
            }
          }
        }

        const relativePath = normalizePath(explicitPath ?? (typeof item['name'] === 'string' ? item['name'] : '.'))
        const name = typeof item['name'] === 'string' && item['name'].trim()
          ? item['name'].trim()
          : (relativePath !== '.' ? relativePath : 'root')

        const absolutePath = join(rootWorkdir, relativePath)

        const devServices = parseServiceEntries(item['dev'], 'server', name, relativePath, absolutePath, 0)
        const serverServices = parseServiceEntries(item['servers'], 'server', name, relativePath, absolutePath, devServices.length)
        const cmdServices = parseServiceEntries(item['commands'] ?? item['scripts'], 'command', name, relativePath, absolutePath, devServices.length + serverServices.length)

        let services = [...devServices, ...serverServices, ...cmdServices]

        if (services.length === 0) {
          const fallbackCmd =
            typeof item['command'] === 'string' ? item['command'].trim() :
            typeof item['start'] === 'string' ? item['start'].trim() :
            undefined
          if (fallbackCmd) {
            services = [
              {
                id: `${name}:server:0:${fallbackCmd}`,
                kind: 'server',
                name,
                command: fallbackCmd,
                projectName: name,
                relativePath,
                absolutePath,
                ...(typeof item['port'] === 'number' ? { port: item['port'] } : {}),
              },
            ]
          }
        }

        const port = typeof item['port'] === 'number' ? item['port'] : undefined
        const firstCmd = services[0]?.command

        projects.push({
          name,
          relativePath,
          absolutePath,
          ...(firstCmd ? { command: firstCmd } : {}),
          ...(typeof port === 'number' ? { port } : {}),
          services,
        })
      }
    }

    if (projects.length === 0) {
      return null
    }

    return { projects }
  } catch {
    return null
  }
}

export async function findSubGitRepos(rootWorkdir: string): Promise<GitRepoInfo[]> {
  const config = await loadMultiRepoConfig(rootWorkdir)
  if (!config) return []

  return config.projects.map((p) => ({
    name: p.name,
    relativePath: p.relativePath,
    absolutePath: p.absolutePath,
  }))
}

export async function isMultiRepoProject(workdir: string): Promise<boolean> {
  const config = await loadMultiRepoConfig(workdir)
  return !!config && config.projects.length > 0
}

export async function discoverDevServices(rootWorkdir: string): Promise<DevServerService[]> {
  const config = await loadMultiRepoConfig(rootWorkdir)
  if (!config) return []

  return config.projects.flatMap((p) => p.services ?? [])
}
