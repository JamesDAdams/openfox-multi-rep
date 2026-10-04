import { describe, expect, it, afterEach } from 'vitest'
import {
  startService,
  stopService,
  stopAllServices,
  getServicesState,
  getServiceLogs,
  type ServiceStateView,
} from './dev-servers.js'

describe('dev-servers module', () => {
  afterEach(() => {
    stopAllServices()
  })

  it('starts and tracks a background dev service', async () => {
    startService('test-service', process.cwd(), 'node -e "setInterval(() => { console.log(\'tick\'); }, 50)"')
    const states = getServicesState()
    expect(states).toHaveLength(1)
    expect(states[0]?.name).toBe('test-service')
    expect(states[0]?.status).toBe('running')

    // Wait briefly to collect logs
    await new Promise((resolve) => setTimeout(resolve, 150))
    const logs = getServiceLogs('test-service')
    expect(logs.length).toBeGreaterThan(0)
  })

  it('stops a running service', async () => {
    startService('stop-service', process.cwd(), 'node -e "setInterval(() => {}, 100)"')
    expect(getServicesState().find((s: ServiceStateView) => s.name === 'stop-service')?.status).toBe('running')

    stopService('stop-service')
    expect(getServicesState().find((s: ServiceStateView) => s.name === 'stop-service')?.status).toBe('stopped')
  })

  it('restarts service when starting already running service with same name', async () => {
    startService('dup-service', process.cwd(), 'node -e "setInterval(() => {}, 100)"')
    const firstState = getServicesState().find((s: ServiceStateView) => s.name === 'dup-service')
    expect(firstState?.status).toBe('running')

    startService('dup-service', process.cwd(), 'node -e "setInterval(() => {}, 100)"')
    const secondState = getServicesState().find((s: ServiceStateView) => s.name === 'dup-service')
    expect(secondState?.status).toBe('running')
  })
})
