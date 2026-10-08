import { spawn } from 'node:child_process'
import type { PluginTool } from 'openfox/plugin'
import { findSubGitRepos, discoverDevServices, findServiceByAnyName } from './discovery.js'
import { startService, stopService, getServicesState } from './dev-servers.js'

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

export const multirepoStatusTool: PluginTool = {
  name: 'multirepo_status',
  description: 'Affiche le statut Git (branche, commits non pushés, fichiers modifiés) pour tous les sous-dépôts configurés.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(_args, context) {
    const repos = await findSubGitRepos(context.workdir)
    if (repos.length === 0) {
      return {
        success: true,
        output: 'Aucun projet multi-dépôt configuré dans .openfox/openfox-multi-repo.json.',
      }
    }

    const results: string[] = []

    for (const repo of repos) {
      const [branchRes, statusRes] = await Promise.all([
        runGit(repo.absolutePath, ['branch', '--show-current']),
        runGit(repo.absolutePath, ['status', '--short']),
      ])

      const branch = branchRes.stdout.trim() || 'detached'
      const status = statusRes.stdout.trim() || '(working tree clean)'

      results.push(`=== Dépôt: ${repo.name} (${repo.relativePath}) [Branche: ${branch}] ===\n${status}`)
    }

    return {
      success: true,
      output: results.join('\n\n'),
    }
  },
}

export const multirepoDevTool: PluginTool = {
  name: 'multirepo_dev',
  description: 'Démarre, arrête ou inspecte les serveurs de développement multi-dépôts configurés.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'start', 'stop', 'status'],
        description: 'Action à effectuer (list, start, stop, status)',
      },
      name: {
        type: 'string',
        description: 'Nom du service ciblé (pour start ou stop)',
      },
    },
    required: ['action'],
  },
  async execute(args, context) {
    const action = String(args['action'] || 'status')
    const name = args['name'] ? String(args['name']) : undefined

    if (action === 'list') {
      const services = await discoverDevServices(context.workdir)
      const states = getServicesState()
      const list = services.map((s) => {
        const displayName = s.name ?? s.command
        const state = states.find((st) => st.name === s.id || st.name === s.name)?.status ?? 'stopped'
        return `- ${s.projectName} › ${displayName} (${s.relativePath}): ${s.command} [Status: ${state}]`
      })
      return {
        success: true,
        output: list.length > 0 ? list.join('\n') : 'Aucun service dev configuré dans .openfox/openfox-multi-repo.json.',
      }
    }

    if (action === 'start') {
      if (!name) {
        return { success: false, error: 'Paramètre "name" requis pour démarrer un service.' }
      }
      const services = await discoverDevServices(context.workdir)
      const service = findServiceByAnyName(services, name)
      if (!service) {
        return { success: false, error: `Service "${name}" introuvable.` }
      }
      startService(service.id, service.absolutePath, service.command)
      return { success: true, output: `Service "${name}" démarré.` }
    }

    if (action === 'stop') {
      if (!name) {
        return { success: false, error: 'Paramètre "name" requis pour arrêter un service.' }
      }
      const services = await discoverDevServices(context.workdir)
      const service = findServiceByAnyName(services, name)
      const targetName = service?.id ?? name
      stopService(targetName)
      return { success: true, output: `Service "${name}" arrêté.` }
    }

    // status
    const services = await discoverDevServices(context.workdir)
    const states = getServicesState()
    return {
      success: true,
      output:
        states.length > 0
          ? states
              .map((s) => {
                const svc = services.find((sv) => sv.id === s.name)
                const label = svc ? (svc.name ?? svc.projectName) : s.name
                return `${label}: ${s.status} (${s.logCount} lignes de log)`
              })
              .join('\n')
          : 'Aucun serveur de dev en cours d’exécution.',
    }
  },
}
