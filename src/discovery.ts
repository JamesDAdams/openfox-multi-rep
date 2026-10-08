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

export function parseCompactTableString<T = Record<string, unknown>>(input: string): T[] {
  if (typeof input !== 'string') return []
  const trimmed = input.trim()
  if (!trimmed) return []

  const firstLineEnd = trimmed.indexOf('\n')
  const headerLine = firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd)
  const headerMatch = headerLine.match(/^\[\d+\]\{([^}]+)\}/)
  if (!headerMatch) return []

  const schemaCols = headerMatch[1]!.split(',').map((c) => {
    const [name, type] = c.split(':')
    return { name: name!.trim(), type: type?.trim() || 'string' }
  })

  const rest = firstLineEnd === -1 ? '' : trimmed.slice(firstLineEnd + 1)
  if (!rest.trim()) return []

  const rows: string[][] = []
  let curRow: string[] = []
  let curField = ''
  let inQuotes = false
  let bracketDepth = 0
  let i = 0

  while (i < rest.length) {
    const ch = rest[i]
    if (inQuotes) {
      if (ch === '\\' && i + 1 < rest.length && rest[i + 1] === '"') {
        curField += '"'
        i += 2
        continue
      }
      if (ch === '"') {
        if (i + 1 < rest.length && rest[i + 1] === '"') {
          curField += '"'
          i += 2
          continue
        } else {
          inQuotes = false
          i++
          continue
        }
      } else {
        curField += ch
        i++
      }
    } else {
      if (ch === '"' && curField.length === 0) {
        inQuotes = true
        i++
      } else if (ch === '[' || ch === '{') {
        bracketDepth++
        curField += ch
        i++
      } else if (ch === ']' || ch === '}') {
        bracketDepth = Math.max(0, bracketDepth - 1)
        curField += ch
        i++
      } else if (ch === ',' && bracketDepth === 0) {
        curRow.push(curField)
        curField = ''
        i++
      } else if ((ch === '\n' || (ch === '\r' && rest[i + 1] === '\n')) && bracketDepth === 0) {
        if (ch === '\r') i++
        curRow.push(curField)
        curField = ''
        if (curRow.length > 0 && curRow.some((f) => f.trim() !== '')) {
          rows.push(curRow)
        }
        curRow = []
        i++
      } else {
        curField += ch
        i++
      }
    }
  }
  if (curField !== '' || curRow.length > 0) {
    curRow.push(curField)
    if (curRow.some((f) => f.trim() !== '')) {
      rows.push(curRow)
    }
  }

  return rows.map((row) => {
    const obj: Record<string, unknown> = {}
    schemaCols.forEach((col, idx) => {
      let val = row[idx]
      if (val === undefined || val === '') {
        obj[col.name] = undefined
        return
      }
      if (col.type.startsWith('json')) {
        try {
          obj[col.name] = JSON.parse(val)
        } catch {
          try {
            const unescaped = val.replace(/""/g, '"')
            obj[col.name] = JSON.parse(unescaped)
          } catch {
            obj[col.name] = val
          }
        }
      } else if (col.type.startsWith('bool')) {
        obj[col.name] = val === 'true' || val === '1'
      } else if (col.type.startsWith('int') || col.type.startsWith('number')) {
        obj[col.name] = Number(val)
      } else {
        obj[col.name] = val
      }
    })
    return obj as T
  })
}

export function extractPortFromCommand(command: string): number | undefined {
  if (!command) return undefined
  const envMatch = command.match(/\b[A-Za-z0-9_]*PORT\s*=\s*(\d{2,5})\b/i)
  if (envMatch && envMatch[1]) {
    const p = parseInt(envMatch[1], 10)
    if (p > 0 && p < 65536) return p
  }
  const flagMatch = command.match(/(?:--port|-p)(?:\s+|=)(\d{2,5})\b/i)
  if (flagMatch && flagMatch[1]) {
    const p = parseInt(flagMatch[1], 10)
    if (p > 0 && p < 65536) return p
  }
  const urlMatch = command.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})\b/i)
  if (urlMatch && urlMatch[1]) {
    const p = parseInt(urlMatch[1], 10)
    if (p > 0 && p < 65536) return p
  }
  return undefined
}

export function findServiceByAnyName(
  services: DevServerService[],
  query: string,
): DevServerService | undefined {
  const q = query.trim()
  if (!q) return undefined

  // 1. Exact match on id, name, or projectName
  let found = services.find((s) => s.id === q || s.name === q || s.projectName === q)
  if (found) return found

  // 2. Direct match composite formatted e.g. "openfox › dev" or "openfox > dev"
  found = services.find(
    (s) =>
      `${s.projectName} › ${s.name ?? ''}`.trim() === q ||
      `${s.projectName} > ${s.name ?? ''}`.trim() === q ||
      `${s.projectName} › ${s.command}`.trim() === q ||
      `${s.projectName} > ${s.command}`.trim() === q,
  )
  if (found) return found

  // 3. Match stripped of status indicators like " (Running)" or " (Stopped)"
  const cleaned = q.replace(/\s*\([^)]*\)\s*$/, '').trim()
  found = services.find(
    (s) =>
      s.id === cleaned ||
      s.name === cleaned ||
      s.projectName === cleaned ||
      `${s.projectName} › ${s.name ?? ''}`.trim() === cleaned ||
      `${s.projectName} > ${s.name ?? ''}`.trim() === cleaned,
  )
  if (found) return found

  // 4. Split composite: "project › service"
  const parts = cleaned.split(/\s*(?:›|>|:)\s*/)
  if (parts.length >= 2) {
    const proj = parts[0]!.toLowerCase()
    const sub = parts[1]!.toLowerCase()
    found = services.find(
      (s) =>
        s.projectName.toLowerCase() === proj &&
        (s.name?.toLowerCase() === sub ||
          s.id.toLowerCase().includes(sub) ||
          s.command.toLowerCase().includes(sub)),
    )
    if (found) return found
  }

  // 5. Fallback: match by project name (if project has services)
  const byProj = services.filter((s) => s.projectName.toLowerCase() === cleaned.toLowerCase())
  if (byProj.length > 0) return byProj[0]

  return undefined
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
    const port = extractPortFromCommand(cmd)
    return {
      id: `${projectName}:${defaultKind}:${index}:${cmd}`,
      kind: defaultKind,
      name: projectName,
      command: cmd,
      projectName,
      relativePath,
      absolutePath,
      ...(typeof port === 'number' ? { port } : {}),
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
    const port = typeof obj['port'] === 'number' ? obj['port'] : extractPortFromCommand(command)
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
    const port = extractPortFromCommand(cmd)
    return [
      {
        id: `${projectName}:${defaultKind}:${startIndex}:${cmd}`,
        kind: defaultKind,
        name: projectName,
        command: cmd,
        projectName,
        relativePath,
        absolutePath,
        ...(typeof port === 'number' ? { port } : {}),
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
    let rawProjects: Array<string | Record<string, unknown>> = []

    if (content.trim().startsWith('[')) {
      rawProjects = parseCompactTableString<Record<string, unknown>>(content)
    } else {
      const parsed = JSON.parse(content) as {
        projects?: Array<string | Record<string, unknown>> | string
      }
      if (Array.isArray(parsed?.projects)) {
        rawProjects = parsed.projects
      } else if (typeof parsed?.projects === 'string') {
        rawProjects = parseCompactTableString<Record<string, unknown>>(parsed.projects)
      }
    }

    if (!rawProjects || rawProjects.length === 0) {
      return null
    }

    const projects: MultiRepoConfigProject[] = []

    for (const item of rawProjects) {
      if (typeof item === 'string') {
        const relativePath = normalizePath(item)
        if (!relativePath) continue
        const absolutePath = join(rootWorkdir, relativePath)
        const command = await tryDetectDevScript(absolutePath)
        const detectedPort = command ? extractPortFromCommand(command) : undefined
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
                ...(typeof detectedPort === 'number' ? { port: detectedPort } : {}),
              },
            ]
          : []
        projects.push({
          name: relativePath,
          relativePath,
          absolutePath,
          ...(command ? { command } : {}),
          ...(typeof detectedPort === 'number' ? { port: detectedPort } : {}),
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
            const detectedPort =
              typeof item['port'] === 'number'
                ? item['port']
                : extractPortFromCommand(fallbackCmd)
            services = [
              {
                id: `${name}:server:0:${fallbackCmd}`,
                kind: 'server',
                name,
                command: fallbackCmd,
                projectName: name,
                relativePath,
                absolutePath,
                ...(typeof detectedPort === 'number' ? { port: detectedPort } : {}),
              },
            ]
          }
        }

        const port =
          typeof item['port'] === 'number'
            ? item['port']
            : services.find((s) => typeof s.port === 'number')?.port
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
