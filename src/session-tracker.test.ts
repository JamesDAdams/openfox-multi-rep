import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  normalizeRepoPath,
  recordSessionModifiedFile,
  clearSessionModifiedFiles,
  getSessionModifiedFiles,
  handleToolCompleted,
  isFileInSession,
  setTrackerContext,
  isSessionFilterEnabled,
} from './session-tracker.js'
import type { PluginContext } from 'openfox/plugin'

describe('session-tracker module', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'multirepo-tracker-test-'))
    clearSessionModifiedFiles()
    setTrackerContext(undefined, undefined)
  })

  afterEach(async () => {
    clearSessionModifiedFiles()
    setTrackerContext(undefined, undefined)
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('normalizeRepoPath', () => {
    it('normalizes relative paths and strips leading ./', () => {
      expect(normalizeRepoPath('./backend/src/index.ts')).toBe('backend/src/index.ts')
      expect(normalizeRepoPath('backend/src/index.ts')).toBe('backend/src/index.ts')
    })

    it('replaces backslashes with slashes', () => {
      expect(normalizeRepoPath('backend\\src\\index.ts')).toBe('backend/src/index.ts')
    })

    it('converts absolute paths relative to workdir', () => {
      const full = join(tempDir, 'subrepo', 'file.txt')
      expect(normalizeRepoPath(full, tempDir)).toBe('subrepo/file.txt')
    })

    it('handles empty strings gracefully', () => {
      expect(normalizeRepoPath('')).toBe('')
    })
  })

  describe('recordSessionModifiedFile and getSessionModifiedFiles', () => {
    it('records and retrieves modified files per session', () => {
      recordSessionModifiedFile('session-1', 'backend/server.ts')
      recordSessionModifiedFile('session-1', 'frontend/App.tsx')
      recordSessionModifiedFile('session-2', 'backend/db.ts')

      const s1 = getSessionModifiedFiles('session-1')
      const s2 = getSessionModifiedFiles('session-2')
      const s3 = getSessionModifiedFiles('session-3')

      expect(s1).toContain('backend/server.ts')
      expect(s1).toContain('frontend/App.tsx')
      expect(s1.size).toBe(2)

      expect(s2).toContain('backend/db.ts')
      expect(s2.size).toBe(1)

      expect(s3.size).toBe(0)
    })

    it('normalizes paths during record', () => {
      recordSessionModifiedFile('session-1', './backend/src/app.ts')
      const files = getSessionModifiedFiles('session-1')
      expect(files).toContain('backend/src/app.ts')
    })

    it('ignores empty sessionId or filePath', () => {
      recordSessionModifiedFile('', 'some/file.ts')
      recordSessionModifiedFile('session-1', '')
      expect(getSessionModifiedFiles('session-1').size).toBe(0)
    })
  })

  describe('clearSessionModifiedFiles', () => {
    it('clears a specific session', () => {
      recordSessionModifiedFile('session-1', 'file1.ts')
      recordSessionModifiedFile('session-2', 'file2.ts')

      clearSessionModifiedFiles('session-1')

      expect(getSessionModifiedFiles('session-1').size).toBe(0)
      expect(getSessionModifiedFiles('session-2').size).toBe(1)
    })

    it('clears all sessions when no id provided', () => {
      recordSessionModifiedFile('session-1', 'file1.ts')
      recordSessionModifiedFile('session-2', 'file2.ts')

      clearSessionModifiedFiles()

      expect(getSessionModifiedFiles('session-1').size).toBe(0)
      expect(getSessionModifiedFiles('session-2').size).toBe(0)
    })
  })

  describe('handleToolCompleted', () => {
    it('records file from write_file tool completion', () => {
      handleToolCompleted({
        sessionId: 'session-1',
        data: {
          result: {
            success: true,
            output: 'Successfully wrote 42 lines (1234 bytes) to backend/server.ts',
            metadata: { path: join(tempDir, 'backend/server.ts') },
          },
        },
      }, tempDir)

      const files = getSessionModifiedFiles('session-1')
      expect(files).toContain('backend/server.ts')
    })

    it('records file from edit_file tool completion', () => {
      handleToolCompleted({
        sessionId: 'session-1',
        data: {
          result: {
            success: true,
            output: 'Successfully replaced 1 occurrence(s) in frontend/src/App.tsx',
            metadata: { path: join(tempDir, 'frontend/src/App.tsx') },
            editContext: { regions: [] },
          },
        },
      }, tempDir)

      const files = getSessionModifiedFiles('session-1')
      expect(files).toContain('frontend/src/App.tsx')
    })

    it('records file when tool is explicit in data payload', () => {
      handleToolCompleted({
        sessionId: 'session-1',
        data: {
          tool: 'write_file',
          arguments: { path: 'packages/core/src/index.ts' },
          result: { success: true },
        },
      }, tempDir)

      const files = getSessionModifiedFiles('session-1')
      expect(files).toContain('packages/core/src/index.ts')
    })

    it('ignores failed tool results', () => {
      handleToolCompleted({
        sessionId: 'session-1',
        data: {
          result: {
            success: false,
            error: 'Failed to write',
            metadata: { path: 'fail.ts' },
          },
        },
      })

      expect(getSessionModifiedFiles('session-1').size).toBe(0)
    })

    it('ignores non-file tool results', () => {
      handleToolCompleted({
        sessionId: 'session-1',
        data: {
          result: {
            success: true,
            output: 'command output',
          },
        },
      })

      expect(getSessionModifiedFiles('session-1').size).toBe(0)
    })

    it('handles missing data or sessionId gracefully', () => {
      handleToolCompleted({ sessionId: undefined })
      handleToolCompleted({ sessionId: 'session-1', data: undefined })
      expect(getSessionModifiedFiles('session-1').size).toBe(0)
    })
  })

  describe('isFileInSession', () => {
    it('returns false for empty session files', () => {
      expect(isFileInSession('backend/server.ts', new Set())).toBe(false)
    })

    it('matches exact normalized path', () => {
      const set = new Set(['backend/server.ts'])
      expect(isFileInSession('backend/server.ts', set)).toBe(true)
      expect(isFileInSession('./backend/server.ts', set)).toBe(true)
    })

    it('matches relative suffix or prefix differences', () => {
      const set = new Set(['server.ts'])
      expect(isFileInSession('backend/server.ts', set)).toBe(true)

      const set2 = new Set(['backend/server.ts'])
      expect(isFileInSession('server.ts', set2)).toBe(true)
    })

    it('returns false for different files', () => {
      const set = new Set(['backend/server.ts'])
      expect(isFileInSession('frontend/server.ts', set)).toBe(false)
      expect(isFileInSession('backend/client.ts', set)).toBe(false)
    })
  })

  describe('isSessionFilterEnabled', () => {
    it('defaults to true when context is not set', () => {
      expect(isSessionFilterEnabled()).toBe(true)
    })

    it('defaults to true when setting is undefined', () => {
      const mockContext: PluginContext = {
        id: 'test',
        version: '1.0',
        runtime: { mode: 'development', configDirectory: tempDir },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        storage: { get: () => undefined, set: vi.fn() },
        settings: () => ({}),
        notify: vi.fn(),
        publish: vi.fn(),
      }
      setTrackerContext(mockContext)
      expect(isSessionFilterEnabled()).toBe(true)
    })

    it('returns true when setting is explicitly true', () => {
      const mockContext: PluginContext = {
        id: 'test',
        version: '1.0',
        runtime: { mode: 'development', configDirectory: tempDir },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        storage: { get: () => undefined, set: vi.fn() },
        settings: () => ({ sessionModifiedFilesOnly: true }),
        notify: vi.fn(),
        publish: vi.fn(),
      }
      setTrackerContext(mockContext)
      expect(isSessionFilterEnabled()).toBe(true)
    })

    it('returns false when setting is explicitly false', () => {
      const mockContext: PluginContext = {
        id: 'test',
        version: '1.0',
        runtime: { mode: 'development', configDirectory: tempDir },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        storage: { get: () => undefined, set: vi.fn() },
        settings: () => ({ sessionModifiedFilesOnly: false }),
        notify: vi.fn(),
        publish: vi.fn(),
      }
      setTrackerContext(mockContext)
      expect(isSessionFilterEnabled()).toBe(false)
    })

    it('handles context settings throwing error gracefully', () => {
      const mockContext: PluginContext = {
        id: 'test',
        version: '1.0',
        runtime: { mode: 'development', configDirectory: tempDir },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        storage: { get: () => undefined, set: vi.fn() },
        settings: () => {
          throw new Error('settings failed')
        },
        notify: vi.fn(),
        publish: vi.fn(),
      }
      setTrackerContext(mockContext)
      expect(isSessionFilterEnabled()).toBe(true)
    })
  })

  describe('SQLite fallback integration', () => {
    it('reads modified files from sessions.db events table', async () => {
      const dbPath = join(tempDir, 'sessions.db')
      const db = new DatabaseSync(dbPath)
      db.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL
        );
      `)

      const callPayload = JSON.stringify({
        messageId: 'm1',
        toolCall: {
          id: 'call-1',
          name: 'write_file',
          arguments: { path: 'packages/backend/src/main.ts' },
        },
      })
      const resultPayload = JSON.stringify({
        messageId: 'm1',
        toolCallId: 'call-1',
        result: { success: true },
      })

      db.prepare(`
        INSERT INTO events (session_id, seq, timestamp, event_type, payload)
        VALUES ('sess-db', 1, 1000, 'tool.call', ?)
      `).run(callPayload)

      db.prepare(`
        INSERT INTO events (session_id, seq, timestamp, event_type, payload)
        VALUES ('sess-db', 2, 1001, 'tool.result', ?)
      `).run(resultPayload)

      db.close()

      const files = getSessionModifiedFiles('sess-db', tempDir, tempDir)
      expect(files).toContain('packages/backend/src/main.ts')
      expect(files.size).toBe(1)
    })

    it('ignores tool calls that failed in sessions.db', async () => {
      const dbPath = join(tempDir, 'sessions.db')
      const db = new DatabaseSync(dbPath)
      db.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL
        );
      `)

      const callPayload = JSON.stringify({
        messageId: 'm1',
        toolCall: {
          id: 'call-fail',
          name: 'edit_file',
          arguments: { path: 'failed/edit.ts' },
        },
      })
      const resultPayload = JSON.stringify({
        messageId: 'm1',
        toolCallId: 'call-fail',
        result: { success: false, error: 'syntax error' },
      })

      db.prepare(`
        INSERT INTO events (session_id, seq, timestamp, event_type, payload)
        VALUES ('sess-db-fail', 1, 1000, 'tool.call', ?)
      `).run(callPayload)

      db.prepare(`
        INSERT INTO events (session_id, seq, timestamp, event_type, payload)
        VALUES ('sess-db-fail', 2, 1001, 'tool.result', ?)
      `).run(resultPayload)

      db.close()

      const files = getSessionModifiedFiles('sess-db-fail', tempDir, tempDir)
      expect(files.size).toBe(0)
    })
  })
})
