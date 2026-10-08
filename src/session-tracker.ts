import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative } from 'node:path'
import type { PluginContext, PluginRuntime } from 'openfox/plugin'

function getDatabaseSyncClass(): (new (path: string, options?: { readOnly?: boolean }) => {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] }
  close: () => void
}) | null {
  try {
    const req = createRequire(import.meta.url)
    return req('node:sqlite')?.DatabaseSync ?? null
  } catch {
    return null
  }
}

const sessionModifiedFiles = new Map<string, Set<string>>()
let activePluginContext: PluginContext | undefined
let activePluginRuntime: PluginRuntime | undefined

export function setTrackerContext(ctx?: PluginContext, runtime?: PluginRuntime): void {
  activePluginContext = ctx
  activePluginRuntime = runtime
}

export function getTrackerContext(): { context?: PluginContext; runtime?: PluginRuntime } {
  return { context: activePluginContext, runtime: activePluginRuntime }
}

export function isSessionFilterEnabled(projectId?: string): boolean {
  if (!activePluginContext) return true
  try {
    const settings =
      (activePluginContext.settings && activePluginContext.settings('project', projectId)) ??
      (activePluginContext.settings && activePluginContext.settings()) ??
      {}
    const val = settings['sessionModifiedFilesOnly']
    return val !== undefined ? Boolean(val) : true
  } catch {
    return true
  }
}

export function normalizeRepoPath(filePath: string, workdir?: string): string {
  let normalized = filePath.replace(/\\/g, '/')
  if (workdir && isAbsolute(normalized)) {
    const normWorkdir = workdir.replace(/\\/g, '/')
    normalized = relative(normWorkdir, normalized).replace(/\\/g, '/')
  }
  return normalized.replace(/^\.\//, '').trim()
}

export function recordSessionModifiedFile(sessionId: string, filePath: string, workdir?: string): void {
  if (!sessionId || !filePath) return
  let set = sessionModifiedFiles.get(sessionId)
  if (!set) {
    set = new Set()
    sessionModifiedFiles.set(sessionId, set)
  }
  const normalized = normalizeRepoPath(filePath, workdir)
  if (normalized) {
    set.add(normalized)
  }
}

export function clearSessionModifiedFiles(sessionId?: string): void {
  if (sessionId) {
    sessionModifiedFiles.delete(sessionId)
  } else {
    sessionModifiedFiles.clear()
  }
}

export function handleToolCompleted(
  payload: {
    sessionId?: string
    data?: Record<string, unknown>
  },
  workdir?: string,
): void {
  if (!payload?.sessionId) return
  const data = payload.data
  const result = data?.['result'] as
    | {
        success?: boolean
        output?: unknown
        metadata?: Record<string, unknown>
        editContext?: unknown
      }
    | undefined

  if (!result || !result.success) return

  const metadataPath = typeof result.metadata?.['path'] === 'string' ? result.metadata['path'] : undefined
  const outputStr = typeof result.output === 'string' ? result.output : ''

  const isWrite = outputStr.startsWith('Successfully wrote')
  const isEdit = outputStr.startsWith('Successfully replaced') || result.editContext !== undefined
  const toolName = typeof data?.['tool'] === 'string' ? data['tool'] : undefined
  const isKnownTool = toolName === 'write_file' || toolName === 'edit_file'

  if ((isWrite || isEdit || isKnownTool) && metadataPath) {
    recordSessionModifiedFile(payload.sessionId, metadataPath, workdir)
    return
  }

  const argPath =
    typeof (data?.['arguments'] as Record<string, unknown> | undefined)?.['path'] === 'string'
      ? ((data?.['arguments'] as Record<string, unknown>)['path'] as string)
      : undefined

  if (isKnownTool && argPath) {
    recordSessionModifiedFile(payload.sessionId, argPath, workdir)
  }
}

export function getSessionModifiedFiles(sessionId: string, workdir?: string, configDirectory?: string): Set<string> {
  const set = new Set<string>()
  const inMemory = sessionModifiedFiles.get(sessionId)
  if (inMemory) {
    for (const p of inMemory) {
      set.add(normalizeRepoPath(p, workdir))
    }
  }

  const effectiveConfigDir = configDirectory ?? activePluginRuntime?.configDirectory
  if (effectiveConfigDir) {
    try {
      const dbPath = join(effectiveConfigDir, 'sessions.db')
      if (existsSync(dbPath)) {
        const DatabaseSyncClass = getDatabaseSyncClass()
        if (DatabaseSyncClass) {
          const db = new DatabaseSyncClass(dbPath, { readOnly: true })
          try {
            const stmt = db.prepare(`
              SELECT json_extract(c.payload, '$.toolCall.arguments.path') as path
              FROM events c
              WHERE c.session_id = ?
                AND c.event_type = 'tool.call'
                AND json_extract(c.payload, '$.toolCall.name') IN ('write_file', 'edit_file')
                AND EXISTS (
                  SELECT 1 FROM events r
                  WHERE r.session_id = c.session_id
                    AND r.event_type = 'tool.result'
                    AND json_extract(r.payload, '$.toolCallId') = json_extract(c.payload, '$.toolCall.id')
                    AND json_extract(r.payload, '$.result.success') = 1
                )
            `)
            const rows = stmt.all(sessionId) as Array<{ path?: string | null }>
            for (const row of rows) {
              if (row?.path) {
                const normalized = normalizeRepoPath(row.path, workdir)
                if (normalized) {
                  set.add(normalized)
                }
              }
            }
          } finally {
            db.close()
          }
        }
      }
    } catch {
    }
  }

  return set
}

export function isFileInSession(diffPath: string, sessionFiles: Set<string>, workdir?: string): boolean {
  if (sessionFiles.size === 0) return false
  const normDiff = normalizeRepoPath(diffPath, workdir)
  if (sessionFiles.has(normDiff)) return true

  for (const sf of sessionFiles) {
    const normSf = normalizeRepoPath(sf, workdir)
    if (normSf === normDiff) return true
    if (normDiff.endsWith('/' + normSf) || normSf.endsWith('/' + normDiff)) return true
  }
  return false
}
