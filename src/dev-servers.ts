import { spawn, type ChildProcess } from 'node:child_process'

export interface RunningService {
  name: string
  process: ChildProcess | null
  status: 'running' | 'stopped' | 'error'
  logs: string[]
  cwd?: string
  command?: string
}

export interface ServiceStateView {
  name: string
  status: 'running' | 'stopped' | 'error'
  logCount: number
}

const runningServices = new Map<string, RunningService>()
const MAX_LOGS = 500

export function startService(name: string, cwd: string, command: string): void {
  stopService(name)

  try {
    const proc = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const service: RunningService = {
      name,
      process: proc,
      status: 'running',
      logs: [],
      cwd,
      command,
    }

    const appendLog = (data: Buffer | string) => {
      const lines = data.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          service.logs.push(line)
          if (service.logs.length > MAX_LOGS) {
            service.logs.shift()
          }
        }
      }
    }

    proc.stdout?.on('data', appendLog)
    proc.stderr?.on('data', appendLog)

    proc.on('error', (err) => {
      service.status = 'error'
      service.logs.push(`Error: ${err.message}`)
    })

    proc.on('close', (code) => {
      if (service.status === 'running') {
        service.status = code === 0 ? 'stopped' : 'error'
      }
    })

    runningServices.set(name, service)
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    runningServices.set(name, {
      name,
      process: null,
      status: 'error',
      logs: [`Failed to spawn service: ${errorMsg}`],
      cwd,
      command,
    })
  }
}

export function stopService(name: string): void {
  const s = runningServices.get(name)
  if (s) {
    if (s.process && !s.process.killed) {
      try {
        s.process.kill()
      } catch {
        // Ignore kill errors
      }
    }
    s.status = 'stopped'
  }
}

export function stopAllServices(): void {
  for (const name of runningServices.keys()) {
    stopService(name)
  }
  runningServices.clear()
}

export function getServicesState(): ServiceStateView[] {
  return Array.from(runningServices.entries()).map(([name, s]) => ({
    name,
    status: s.status,
    logCount: s.logs.length,
  }))
}

export function getServiceLogs(name: string): string[] {
  return runningServices.get(name)?.logs ?? []
}
