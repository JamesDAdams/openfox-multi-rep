import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findSubGitRepos,
  isMultiRepoProject,
  discoverDevServices,
  loadMultiRepoConfig,
} from './discovery.js'

describe('discovery & configuration module', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'multirepo-config-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns null and false when .openfox/openfox-multi-repo.json does not exist', async () => {
    await mkdir(join(tempDir, 'backend', '.git'), { recursive: true })
    await mkdir(join(tempDir, 'frontend', '.git'), { recursive: true })

    const config = await loadMultiRepoConfig(tempDir)
    expect(config).toBeNull()

    const repos = await findSubGitRepos(tempDir)
    expect(repos).toHaveLength(0)

    const isMulti = await isMultiRepoProject(tempDir)
    expect(isMulti).toBe(false)

    const devServices = await discoverDevServices(tempDir)
    expect(devServices).toHaveLength(0)
  })

  it('loads projects explicitly defined in .openfox/openfox-multi-repo.json (standard format)', async () => {
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(openfoxDir, { recursive: true })

    const configContent = {
      projects: [
        { name: 'API Server', path: 'services/api', dev: 'npm run dev:api' },
        { name: 'Web Client', path: 'apps/web', dev: 'npm run dev:web' },
      ],
    }

    await writeFile(join(openfoxDir, 'openfox-multi-repo.json'), JSON.stringify(configContent, null, 2))

    const config = await loadMultiRepoConfig(tempDir)
    expect(config).not.toBeNull()
    expect(config?.projects).toHaveLength(2)

    const isMulti = await isMultiRepoProject(tempDir)
    expect(isMulti).toBe(true)

    const repos = await findSubGitRepos(tempDir)
    expect(repos).toHaveLength(2)
    expect(repos[0]).toEqual({
      name: 'API Server',
      relativePath: 'services/api',
      absolutePath: join(tempDir, 'services/api'),
    })
    expect(repos[1]).toEqual({
      name: 'Web Client',
      relativePath: 'apps/web',
      absolutePath: join(tempDir, 'apps/web'),
    })

    const devServices = await discoverDevServices(tempDir)
    expect(devServices).toHaveLength(2)
    expect(devServices[0]?.command).toBe('npm run dev:api')
    expect(devServices[1]?.command).toBe('npm run dev:web')
  })

  it('handles user format with relative path as key like {"name": "bff", "./hubgpat-bff": "bff"}', async () => {
    const openfoxDir = join(tempDir, '.openfox')
    const libVieDir = join(tempDir, 'lib-vie-workspace')
    await mkdir(openfoxDir, { recursive: true })
    await mkdir(libVieDir, { recursive: true })

    // lib-vie has a package.json with dev script, but no "dev" key in openfox-multi-repo.json
    await writeFile(
      join(libVieDir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'tsc --watch' } }),
    )

    const userJson = {
      projects: [
        { name: 'gpat', './hub-gan-pat-mobile': 'frontend', dev: 'npm run start-pprod' },
        { name: 'bff', './hubgpat-bff': 'bff', dev: 'npm run dev' },
        { name: 'lib-vie', './lib-vie-workspace': 'lib' },
      ],
    }

    await writeFile(join(openfoxDir, 'openfox-multi-repo.json'), JSON.stringify(userJson, null, 2))

    const repos = await findSubGitRepos(tempDir)
    expect(repos).toHaveLength(3)

    expect(repos[0]).toEqual({
      name: 'gpat',
      relativePath: 'hub-gan-pat-mobile',
      absolutePath: join(tempDir, 'hub-gan-pat-mobile'),
    })
    expect(repos[1]).toEqual({
      name: 'bff',
      relativePath: 'hubgpat-bff',
      absolutePath: join(tempDir, 'hubgpat-bff'),
    })
    expect(repos[2]).toEqual({
      name: 'lib-vie',
      relativePath: 'lib-vie-workspace',
      absolutePath: join(tempDir, 'lib-vie-workspace'),
    })

    const devServices = await discoverDevServices(tempDir)
    expect(devServices).toHaveLength(2)
    expect(devServices[0]?.name).toBe('gpat')
    expect(devServices[0]?.command).toBe('npm run start-pprod')
    expect(devServices[0]?.relativePath).toBe('hub-gan-pat-mobile')

    expect(devServices[1]?.name).toBe('bff')
    expect(devServices[1]?.command).toBe('npm run dev')
    expect(devServices[1]?.relativePath).toBe('hubgpat-bff')
  })

  it('supports string array and falls back to package.json for dev scripts if dev command not specified in JSON', async () => {
    const openfoxDir = join(tempDir, '.openfox')
    const backendDir = join(tempDir, 'backend')
    await mkdir(openfoxDir, { recursive: true })
    await mkdir(backendDir, { recursive: true })

    await writeFile(
      join(backendDir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'tsx watch server.ts' } }),
    )

    const configContent = {
      projects: ['backend'],
    }

    await writeFile(join(openfoxDir, 'openfox-multi-repo.json'), JSON.stringify(configContent, null, 2))

    const repos = await findSubGitRepos(tempDir)
    expect(repos).toHaveLength(1)
    expect(repos[0]?.name).toBe('backend')
    expect(repos[0]?.relativePath).toBe('backend')

    const devServices = await discoverDevServices(tempDir)
    expect(devServices).toHaveLength(1)
    expect(devServices[0]?.command).toBe('npm run dev')
  })

  it('supports multiple servers and commands per project with name and icon', async () => {
    const openfoxDir = join(tempDir, '.openfox')
    await mkdir(openfoxDir, { recursive: true })

    const userJson = {
      projects: [
        {
          name: 'gpat',
          path: 'hub-gan-pat-mobile',
          dev: [
            { name: 'start-pprod', command: 'npm run start-pprod', icon: 'PlayIcon' },
            { name: 'metro', command: 'npm run metro' },
          ],
          commands: [
            { name: 'build', command: 'npm run build', icon: 'GearIcon' },
            { icon: 'CheckIcon', command: 'npm run lint' },
          ],
        },
        {
          name: 'bff',
          path: 'hubgpat-bff',
          dev: 'npm run dev',
        },
      ],
    }

    await writeFile(join(openfoxDir, 'openfox-multi-repo.json'), JSON.stringify(userJson, null, 2))

    const devServices = await discoverDevServices(tempDir)
    expect(devServices).toHaveLength(5)

    // gpat start-pprod (server)
    expect(devServices[0]?.projectName).toBe('gpat')
    expect(devServices[0]?.name).toBe('start-pprod')
    expect(devServices[0]?.command).toBe('npm run start-pprod')
    expect(devServices[0]?.icon).toBe('PlayIcon')
    expect(devServices[0]?.kind).toBe('server')

    // gpat metro (server)
    expect(devServices[1]?.projectName).toBe('gpat')
    expect(devServices[1]?.name).toBe('metro')
    expect(devServices[1]?.command).toBe('npm run metro')
    expect(devServices[1]?.icon).toBeUndefined()
    expect(devServices[1]?.kind).toBe('server')

    // gpat build (command)
    expect(devServices[2]?.projectName).toBe('gpat')
    expect(devServices[2]?.name).toBe('build')
    expect(devServices[2]?.command).toBe('npm run build')
    expect(devServices[2]?.icon).toBe('GearIcon')
    expect(devServices[2]?.kind).toBe('command')

    // gpat lint (command - icon only)
    expect(devServices[3]?.projectName).toBe('gpat')
    expect(devServices[3]?.name).toBeUndefined()
    expect(devServices[3]?.command).toBe('npm run lint')
    expect(devServices[3]?.icon).toBe('CheckIcon')
    expect(devServices[3]?.kind).toBe('command')

    // bff dev (server)
    expect(devServices[4]?.projectName).toBe('bff')
    expect(devServices[4]?.name).toBe('bff')
    expect(devServices[4]?.command).toBe('npm run dev')
    expect(devServices[4]?.kind).toBe('server')
  })
})
