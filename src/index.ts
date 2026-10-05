import { join, basename } from 'node:path'
import type { DeclarativeNode, PluginRegistry, PluginToolContext } from 'openfox/plugin'
import { multirepoVcsProvider } from './vcs-provider.js'
import { multirepoAgentTransform } from './transforms.js'
import { multirepoGitUiOverride, multiDevServerUiOverride, multirepoBranchModal, multirepoDevLogsModal, multirepoDevHelpModal } from './ui.js'
import { multirepoStatusTool, multirepoDevTool } from './tools.js'
import { startService, stopService, stopAllServices, getServicesState, getServiceLogs } from './dev-servers.js'
import { findSubGitRepos, discoverDevServices, type DevServerService } from './discovery.js'
import { getCurrentBranch, listRepoBranches, switchRepoBranch, createRepoBranch, getRepoDefaultBranch } from './git-ops.js'
import { resolveLucideIcon } from './icons.js'
import {
  scanGitRepositories,
  getConfiguredProjectPaths,
  addProjectsToMultiRepoConfig,
  syncProjectsWithMultiRepoConfig,
  normalizeRepoPath,
  type DiscoveredGitRepo,
} from './repository-scanner.js'
export * from './icons.js'

interface BranchModalDraft {
  query: string
  newName: string
  sourceBranch: string
  error?: string | undefined
}

const branchDrafts = new Map<string, BranchModalDraft>()

function getBranchDraft(repoName: string): BranchModalDraft {
  return branchDrafts.get(repoName) ?? { query: '', newName: '', sourceBranch: '' }
}

function setBranchDraft(repoName: string, patch: Partial<BranchModalDraft>): BranchModalDraft {
  const next = { ...getBranchDraft(repoName), ...patch }
  branchDrafts.set(repoName, next)
  return next
}

interface HelpModalDraft {
  selectedPaths: Set<string>
  statusMessage?: { en: string; fr: string } | undefined
  statusTone?: 'success' | 'danger' | 'info' | undefined
  discovered?: DiscoveredGitRepo[] | undefined
  scanErrors?: string[] | undefined
}

const helpModalDrafts = new Map<string, HelpModalDraft>()

function getHelpModalDraft(workdir: string): HelpModalDraft {
  let draft = helpModalDrafts.get(workdir)
  if (!draft) {
    draft = { selectedPaths: new Set() }
    helpModalDrafts.set(workdir, draft)
  }
  return draft
}

async function buildBranchModalContent(repoName: string, repoAbsolutePath: string): Promise<DeclarativeNode[]> {
  const draft = getBranchDraft(repoName)
  const [currentBranch, allBranches, defaultBranch] = await Promise.all([
    getCurrentBranch(repoAbsolutePath),
    listRepoBranches(repoAbsolutePath),
    getRepoDefaultBranch(repoAbsolutePath),
  ])

  const query = draft.query.trim().toLowerCase()
  const filteredBranches = query ? allBranches.filter((b) => b.toLowerCase().includes(query)) : allBranches

  const branchRows: DeclarativeNode[] = filteredBranches.map((branch) => {
    const isCurrent = branch === currentBranch
    const trailing: DeclarativeNode = isCurrent
      ? {
          type: 'text',
          text: { en: '(current)', fr: '(actuelle)' },
          className: 'ml-auto text-xs text-text-muted shrink-0',
        }
      : {
          type: 'button',
          label: { en: 'Switch', fr: 'Changer' },
          variant: 'link',
          onActivate: {
            kind: 'rpc',
            method: 'switchBranchRpc',
            params: { repoName, branch },
          },
        }

    return {
      type: 'stack',
      direction: 'row',
      align: 'center',
      gap: 'sm',
      className: isCurrent
        ? 'w-full text-left px-3 py-1.5 text-sm rounded transition-colors bg-accent-primary/10 text-accent-primary cursor-default'
        : 'w-full text-left px-3 py-1.5 text-sm rounded transition-colors hover:bg-bg-tertiary text-text-secondary',
      children: [
        { type: 'icon', icon: 'BranchIcon', className: 'w-3.5 h-3.5 shrink-0' },
        { type: 'text', text: { en: branch, fr: branch }, className: 'font-mono truncate min-w-0' },
        trailing,
      ],
    }
  })

  const sourceBranchField: DeclarativeNode = {
    type: 'stack',
    direction: 'column',
    align: 'stretch',
    gap: 'none',
    className: 'w-full mt-2 mb-3',
    children: [
      {
        type: 'text',
        text: {
          en: `From branch (optional — defaults to ${defaultBranch})`,
          fr: `Depuis la branche (facultatif — défaut : ${defaultBranch})`,
        },
        className: 'text-xs text-text-muted mb-1',
      },
      {
        type: 'input',
        id: 'source-branch',
        inputType: 'text',
        icon: 'BranchIcon',
        placeholder: { en: defaultBranch, fr: defaultBranch },
        defaultValue: draft.sourceBranch,
        onChange: {
          kind: 'rpc',
          method: 'setSourceBranchRpc',
          params: { repoName },
        },
      },
    ],
  }

  const createSectionChildren: DeclarativeNode[] = [
    {
      type: 'text',
      text: { en: 'Create new branch', fr: 'Créer une nouvelle branche' },
      className: 'text-sm font-medium text-text-primary mb-2',
    },
    {
      type: 'stack',
      direction: 'row',
      align: 'center',
      gap: 'sm',
      className:
        'w-full px-3 py-2 rounded border border-border bg-bg-primary focus-within:border-accent-primary mb-3',
      children: [
        { type: 'icon', icon: 'BranchIcon', className: 'w-4 h-4 shrink-0 text-text-muted' },
        {
          type: 'input',
          id: 'new-branch-name',
          inputType: 'text',
          bare: true,
          placeholder: { en: 'feature/my-branch', fr: 'feature/ma-branche' },
          defaultValue: draft.newName,
          onChange: {
            kind: 'rpc',
            method: 'setBranchNameRpc',
            params: { repoName },
          },
        },
      ],
    },
  ]

  if (draft.newName.trim()) {
    createSectionChildren.push(sourceBranchField)
  }

  createSectionChildren.push({
    type: 'button',
    label: { en: 'Create Branch', fr: 'Créer la branche' },
    variant: 'primary',
    className: 'w-full',
    onActivate: {
      kind: 'rpc',
      method: 'createBranchRpc',
      params: { repoName },
    },
  })

  const sections: DeclarativeNode[] = [
    // Branches section
    {
      type: 'stack',
      direction: 'column',
      align: 'stretch',
      gap: 'none',
      className: 'w-full mb-4',
      children: [
        {
          type: 'text',
          text: { en: 'Branches', fr: 'Branches' },
          className: 'text-sm font-medium text-text-primary mb-2',
        },
        {
          type: 'input',
          id: 'branch-search',
          inputType: 'text',
          icon: 'SearchIcon',
          placeholder: { en: 'Search branches…', fr: 'Rechercher des branches…' },
          defaultValue: draft.query,
          className: 'mb-2',
          onChange: {
            kind: 'rpc',
            method: 'filterBranchesRpc',
            params: { repoName },
          },
        },
        {
          type: 'stack',
          direction: 'column',
          align: 'stretch',
          gap: 'none',
          className: 'w-full max-h-48 overflow-y-auto space-y-0.5 bg-bg-tertiary/30 rounded p-2',
          children:
            branchRows.length > 0
              ? branchRows
              : [
                  {
                    type: 'text',
                    text: { en: 'No branches match', fr: 'Aucune branche ne correspond' },
                    className: 'text-xs text-text-muted py-2 text-center',
                  },
                ],
        },
      ],
    },
    // Create new branch section (CreateInputSection)
    {
      type: 'stack',
      direction: 'column',
      align: 'stretch',
      gap: 'none',
      className: 'w-full',
      children: createSectionChildren,
    },
  ]

  if (draft.error) {
    sections.push({
      type: 'text',
      text: { en: draft.error, fr: draft.error },
      className: 'mt-3 text-sm text-accent-error bg-accent-error/10 p-2 rounded',
    })
  }

  return [
    {
      type: 'stack',
      direction: 'column',
      align: 'stretch',
      gap: 'none',
      className: 'w-full',
      children: sections,
    },
  ]
}

function encodePath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

export function buildEditorUrl(filePath: string, line?: number): string {
  const normalized = filePath.replace(/\\/g, '/')
  const encoded = encodePath(normalized)
  const slashPrefix = encoded.startsWith('/') ? '' : '/'
  return `vscode://file${slashPrefix}${encoded}:${line ?? 1}:1?windowId=_blank`
}

async function buildGitSidebarUi(context: PluginToolContext) {
  const repos = await findSubGitRepos(context.workdir)
  if (repos.length === 0) {
    return {}
  }

  const diffFiles = await multirepoVcsProvider.getDiffFiles(context)

  const repoCards: DeclarativeNode[] = await Promise.all(
    repos.map(async (repo) => {
      const branch = await getCurrentBranch(repo.absolutePath)
      const repoRel = repo.relativePath === '.' ? '.' : repo.relativePath.replace(/^\.\//, '')
      const repoDiffs = diffFiles.filter((f) => {
        if (repoRel === '.') return true
        return f.path === repoRel || f.path.startsWith(`${repoRel}/`)
      })

      const diffNodeList: DeclarativeNode[] =
        repoDiffs.length > 0
          ? repoDiffs.slice(0, 20).map((f) => {
              const fileName = f.path.startsWith(`${repoRel}/`) ? f.path.slice(repoRel.length + 1) : f.path
              const colorClass =
                f.status === 'added'
                  ? 'text-accent-success'
                  : f.status === 'deleted'
                    ? 'text-accent-error'
                    : 'text-purple-400'
              const symbol = f.status === 'added' ? '+ ' : f.status === 'deleted' ? '- ' : '• '
              const fullFilePath = join(repo.absolutePath, fileName)
              const editorUrl = buildEditorUrl(fullFilePath)

              return {
                type: 'text',
                text: { en: `${symbol}${fileName}`, fr: `${symbol}${fileName}` },
                title: {
                  en: `Open ${fileName} in VSCode`,
                  fr: `Ouvrir ${fileName} dans VSCode`,
                },
                className: `font-mono text-xs ${colorClass} truncate hover:underline`,
                onActivate: {
                  kind: 'openUrl',
                  url: editorUrl,
                },
              }
            })
          : [
              {
                type: 'text',
                text: { en: 'Working tree clean', fr: 'Espace de travail propre' },
                muted: true,
                className: 'text-xs italic text-text-muted',
              },
            ]

      return {
        type: 'card',
        className: 'w-full p-3 bg-bg-secondary border border-border rounded-lg shadow-sm',
        children: [
          // 1. Repo Name on Left, Branch + Pencil Icon on Right
          {
            type: 'stack',
            direction: 'row',
            align: 'center',
            justify: 'between',
            gap: 'xs',
            className: 'w-full min-w-0',
            children: [
              // Left: 📁 name (can shrink, truncates with ellipsis)
              {
                type: 'stack',
                direction: 'row',
                align: 'center',
                gap: 'xs',
                className: 'min-w-0 flex-1 mr-2',
                children: [
                  { type: 'icon', icon: 'FolderIcon', className: 'w-4 h-4 text-text-muted shrink-0' },
                  {
                    type: 'text',
                    text: { en: repo.name, fr: repo.name },
                    title: { en: repo.name, fr: repo.name },
                    className: 'font-semibold text-text-primary text-sm truncate min-w-0',
                  },
                ],
              },
              // Right: 🌿 branch + ✏️ Edit button (capped max width, truncates, pencil button never cut off)
              {
                type: 'stack',
                direction: 'row',
                align: 'center',
                gap: 'xs',
                className: 'min-w-0 shrink-0 max-w-[50%] flex items-center',
                children: [
                  { type: 'icon', icon: 'BranchIcon', className: 'w-3.5 h-3.5 text-text-muted shrink-0' },
                  {
                    type: 'text',
                    text: { en: branch, fr: branch },
                    title: { en: branch, fr: branch },
                    className: 'font-mono text-xs text-text-secondary truncate min-w-0',
                  },
                  {
                    type: 'button',
                    label: { en: '', fr: '' },
                    title: { en: 'Switch branch', fr: 'Changer de branche' },
                    icon: 'PencilIcon',
                    variant: 'ghost',
                    className:
                      '!h-6 !w-6 !p-0 !min-w-6 text-text-muted hover:text-text-primary rounded transition-colors flex items-center justify-center shrink-0 ml-0.5',
                    onActivate: {
                      kind: 'rpc',
                      method: 'openBranchModal',
                      params: { repoName: repo.name },
                    },
                  },
                ],
              },
            ],
          },
          { type: 'divider' },
          // 2. Changed Files
          {
            type: 'stack',
            direction: 'column',
            align: 'stretch',
            gap: 'xs',
            className: 'w-full mt-1',
            children: diffNodeList,
          },
        ],
      }
    }),
  )

  return {
    content: {
      type: 'stack',
      direction: 'column',
      align: 'stretch',
      gap: 'sm',
      className: 'w-full space-y-2.5 mb-3',
      children: repoCards,
    },
  }
}

async function buildDevLogsModalContent(name: string, context: PluginToolContext): Promise<DeclarativeNode[]> {
  const services = await discoverDevServices(context.workdir)
  const svc = services.find((s) => s.id === name || s.name === name)
  const serviceKey = svc?.id ?? name
  const states = getServicesState()
  const state = states.find((s) => s.name === serviceKey || s.name === name)
  const isRunning = state?.status === 'running'
  const logs = getServiceLogs(serviceKey)
  const logsText = logs.length > 0 ? logs.join('\n') : '(No logs recorded yet)'

  const displayTitle = svc?.name
    ? svc.name === svc.projectName
      ? svc.name
      : `${svc.projectName} › ${svc.name}`
    : (svc?.command ?? name)

  const statusLabel = isRunning
    ? { en: 'Running', fr: 'En cours' }
    : state?.status === 'error'
      ? { en: 'Error', fr: 'Erreur' }
      : { en: 'Stopped', fr: 'Arrêté' }

  return [
    {
      type: 'stack',
      direction: 'column',
      align: 'stretch',
      gap: 'sm',
      className: 'w-full',
      children: [
        {
          type: 'stack',
          direction: 'row',
          justify: 'between',
          align: 'center',
          className: 'w-full pb-2 border-b border-border',
          children: [
            {
              type: 'stack',
              direction: 'column',
              gap: 'xs',
              children: [
                {
                  type: 'text',
                  text: { en: `Service: ${displayTitle}`, fr: `Service : ${displayTitle}` },
                  className: 'font-semibold text-text-primary text-sm',
                },
                ...(svc?.command
                  ? [
                      {
                        type: 'text' as const,
                        text: { en: `Command: ${svc.command}`, fr: `Commande : ${svc.command}` },
                        className: 'font-mono text-xs text-text-muted',
                      },
                    ]
                  : []),
              ],
            },
            {
              type: 'badge',
              label: statusLabel,
              tone: isRunning ? 'success' : state?.status === 'error' ? 'danger' : 'neutral',
            },
          ],
        },
        {
          type: 'text',
          text: { en: logsText, fr: logsText },
          className:
            'font-mono text-xs bg-bg-primary text-text-secondary p-3 rounded border border-border overflow-x-auto whitespace-pre font-normal max-h-[60vh] overflow-y-auto select-text',
        },
      ],
    },
  ]
}

async function buildDevHelpModalContent(context?: PluginToolContext): Promise<DeclarativeNode[]> {
  const workdir = context?.workdir ?? process.cwd()
  const draft = getHelpModalDraft(workdir)

  if (!draft.discovered) {
    const scan = await scanGitRepositories(workdir)
    draft.discovered = scan.repos
    draft.scanErrors = scan.errors
    // Pre-populate selectedPaths with already configured repositories so all checkboxes reflect active state
    const currentConfigured = await getConfiguredProjectPaths(workdir)
    for (const repo of scan.repos) {
      if (currentConfigured.has(normalizeRepoPath(repo.relativePath))) {
        draft.selectedPaths.add(repo.relativePath)
      }
    }
  }

  const configuredPaths = await getConfiguredProjectPaths(workdir)
  const discovered = draft.discovered ?? []
  const selectedCount = draft.selectedPaths.size

  const autoDetectChildren: DeclarativeNode[] = [
    {
      type: 'text',
      text: {
        en: 'Discover Git repositories in this directory and subdirectories, check or uncheck them, then save to .openfox/openfox-multi-repo.json (preserves existing dev servers and commands).',
        fr: 'Détectez les dépôts Git dans ce dossier et ses sous-dossiers, cochez ou décochez-les, puis enregistrez dans .openfox/openfox-multi-repo.json (préserve les serveurs dev et commandes existants).',
      },
      className: 'text-xs text-text-secondary leading-relaxed mb-2',
    },
  ]

  if (draft.scanErrors && draft.scanErrors.length > 0) {
    autoDetectChildren.push({
      type: 'callout',
      tone: 'danger',
      title: { en: 'Scan warnings / errors', fr: 'Avertissements / erreurs du scan' },
      text: {
        en: draft.scanErrors.join('\n'),
        fr: draft.scanErrors.join('\n'),
      },
    })
  }

  if (draft.statusMessage) {
    autoDetectChildren.push({
      type: 'callout',
      tone: draft.statusTone ?? 'info',
      text: draft.statusMessage,
    })
  }

  if (discovered.length === 0) {
    autoDetectChildren.push({
      type: 'text',
      text: {
        en: 'No Git repositories detected in subdirectories.',
        fr: 'Aucun sous-dépôt Git détecté dans les sous-dossiers.',
      },
      className: 'text-xs text-text-muted italic py-1',
    })
  } else {
    autoDetectChildren.push({
      type: 'stack',
      direction: 'row',
      align: 'center',
      justify: 'between',
      className: 'mb-1 mt-1',
      children: [
        {
          type: 'text',
          text: {
            en: `${discovered.length} Git repository(ies) detected (${selectedCount} selected)`,
            fr: `${discovered.length} dépôt(s) Git détecté(s) (${selectedCount} sélectionné(s))`,
          },
          className: 'text-xs text-text-muted',
        },
        {
          type: 'stack',
          direction: 'row',
          align: 'center',
          gap: 'xs',
          children: [
            {
              type: 'button',
              variant: 'default',
              label: { en: 'Select All', fr: 'Tout sélectionner' },
              disabled: selectedCount === discovered.length,
              className: '!text-xs !py-1 !px-2',
              onActivate: {
                kind: 'rpc',
                method: 'selectAllHelpReposRpc',
                params: {},
              },
            },
            {
              type: 'button',
              variant: 'default',
              label: { en: 'Unselect All', fr: 'Tout désélectionner' },
              disabled: selectedCount === 0,
              className: '!text-xs !py-1 !px-2',
              onActivate: {
                kind: 'rpc',
                method: 'unselectAllHelpReposRpc',
                params: {},
              },
            },
          ],
        },
      ],
    })

    const repoRows: DeclarativeNode[] = discovered.map((repo) => {
      const norm = normalizeRepoPath(repo.relativePath)
      const isConfigured = configuredPaths.has(norm)
      const isSelected = draft.selectedPaths.has(repo.relativePath)

      return {
        type: 'stack',
        direction: 'row',
        align: 'center',
        gap: 'sm',
        className: 'py-1 hover:bg-bg-tertiary/50 px-1 rounded transition-colors',
        children: [
          {
            type: 'input',
            id: `repo-select-${norm.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
            inputType: 'checkbox',
            defaultChecked: isSelected,
            disabled: false,
            onChange: {
              kind: 'rpc',
              method: 'toggleHelpRepoSelection',
              params: { repoPath: repo.relativePath },
            },
          },
          {
            type: 'text',
            text: {
              en: isConfigured
                ? `${repo.name} (${repo.relativePath}) — in config`
                : `${repo.name} (${repo.relativePath})`,
              fr: isConfigured
                ? `${repo.name} (${repo.relativePath}) — dans config`
                : `${repo.name} (${repo.relativePath})`,
            },
            className: isConfigured
              ? 'text-xs font-mono text-accent-primary truncate'
              : 'text-xs font-mono text-text-primary truncate',
          },
        ],
      }
    })

    autoDetectChildren.push({
      type: 'stack',
      direction: 'column',
      align: 'stretch',
      gap: 'none',
      className: 'w-full max-h-56 overflow-y-auto pr-1 border border-border rounded p-2 bg-bg-primary/50 my-2',
      children: repoRows,
    })
  }

  autoDetectChildren.push({
    type: 'stack',
    direction: 'row',
    align: 'center',
    gap: 'sm',
    className: 'mt-2 pt-2 border-t border-border',
    children: [
      {
        type: 'button',
        variant: 'primary',
        label: {
          en: `Save to config (${selectedCount})`,
          fr: `Enregistrer dans la config (${selectedCount})`,
        },
        icon: 'CheckIcon',
        onActivate: {
          kind: 'rpc',
          method: 'addSelectedReposToConfig',
          params: {},
        },
      },
      {
        type: 'button',
        variant: 'default',
        label: { en: 'Rescan', fr: 'Re-scanner' },
        icon: 'RefreshCwIcon',
        onActivate: {
          kind: 'rpc',
          method: 'rescanReposRpc',
          params: {},
        },
      },
    ],
  })

  const exampleJson = `{
  "projects": [
    {
      "name": "frontend",
      "path": "./frontend",
      "dev": [
        { "name": "web", "command": "npm run dev", "icon": "play" }
      ],
      "commands": [
        { "name": "build", "command": "npm run build", "icon": "gear" },
        { "icon": "check", "command": "npm run lint" },
        { "name": "test", "command": "npm run test", "separateLine": true }
      ]
    },
    {
      "name": "backend",
      "path": "./backend",
      "dev": "npm run start"
    },
    {
      "name": "shared-lib",
      "path": "./packages/shared-lib"
    }
  ]
}`

  return [
    {
      type: 'stack',
      direction: 'column',
      align: 'stretch',
      gap: 'md',
      className: 'w-full max-h-[75vh] overflow-y-auto pr-1',
      children: [
        {
          type: 'card',
          title: {
            en: 'Auto-Detect Git Projects',
            fr: 'Détection automatique des projets Git',
          },
          children: autoDetectChildren,
        },
        {
          type: 'callout',
          tone: 'info',
          title: { en: 'Configuration file', fr: 'Fichier de configuration' },
          text: {
            en: 'Place your configuration in .openfox/openfox-multi-repo.json at the root of your workspace. Each project specifies its directory via the "path" field (e.g. "path": "./my-project").',
            fr: 'Placez votre configuration dans .openfox/openfox-multi-repo.json à la racine de votre projet. Chaque projet indique son répertoire via le champ "path" (ex. "path": "./mon-projet").',
          },
        },
        {
          type: 'card',
          title: { en: '1. Projects & Dev Servers (dev)', fr: '1. Projets & Serveurs Dev (dev)' },
          children: [
            {
              type: 'text',
              text: {
                en: '• Persistent background services (with status dot ●, Logs button >_ and Start/Stop toggle ▶/■).\n• String shorthand: "dev": "npm run dev"\n• Or array of servers: "dev": [{ "name": "api", "command": "npm run start", "icon": "play" }]',
                fr: '• Services persistants en arrière-plan (avec point de statut ●, bouton Logs >_ et bouton Start/Stop ▶/■).\n• Raccourci chaîne : "dev": "npm run dev"\n• Ou liste de serveurs : "dev": [{ "name": "api", "command": "npm run start", "icon": "play" }]',
              },
              className: 'text-xs text-text-secondary whitespace-pre-line leading-relaxed',
            },
          ],
        },
        {
          type: 'card',
          title: { en: '2. One-Shot Commands (commands)', fr: '2. Commandes One-Shot (commands)' },
          children: [
            {
              type: 'text',
              text: {
                en: '• Direct execution tasks (build, lint, codegen, migrate, tests...).\n• Inline by default: displayed on the same line as the project dev server as compact action buttons.\n• Dedicated line: set "separateLine": true to display on its own row below.',
                fr: '• Tâches à exécution directe (build, lint, codegen, migrate, tests...).\n• En ligne par défaut : affichées sur la même ligne que le serveur dev sous forme de boutons d\'action compacts.\n• Ligne dédiée : ajoutez "separateLine": true pour afficher la commande sur sa propre ligne.',
              },
              className: 'text-xs text-text-secondary whitespace-pre-line leading-relaxed',
            },
          ],
        },
        {
          type: 'card',
          title: { en: '3. Icons (Lucide - 1800+ icons)', fr: '3. Icônes (Lucide - 1800+ icônes)' },
          children: [
            {
              type: 'text',
              text: {
                en: 'Specify any Lucide icon name in the "icon" field (no SVG needed!). Supports kebab-case (git-branch), camelCase (gitBranch), PascalCase (GitBranch) and optional Icon suffix (SparklesIcon). Raw SVGs are also accepted.',
                fr: 'Spécifiez n\'importe quel nom d\'icône Lucide dans le champ "icon" (pas besoin de SVG !). Supporte le kebab-case (git-branch), camelCase (gitBranch), PascalCase (GitBranch) et le suffixe optionnel Icon (SparklesIcon). Les SVG bruts sont également acceptés.',
              },
              className: 'text-xs text-text-secondary mb-2',
            },
            {
              type: 'button',
              label: { en: 'Browse Lucide Icons (lucide.dev/icons)', fr: 'Explorer les icônes Lucide (lucide.dev/icons)' },
              variant: 'default',
              icon: 'OpenExternalIcon',
              className: '!text-xs mb-3',
              onActivate: {
                kind: 'openUrl',
                url: 'https://lucide.dev/icons',
              },
            },
            {
              type: 'text',
              text: {
                en: 'Examples:\n• play, stop, square, terminal, console\n• settings, gear, cog, check, refresh-cw, rotate-cw\n• folder, git-branch, search, star, bell, trash, edit, eye\n• sparkles, bot, brain, cpu, plus, send, copy, info',
                fr: 'Exemples :\n• play, stop, square, terminal, console\n• settings, gear, cog, check, refresh-cw, rotate-cw\n• folder, git-branch, search, star, bell, trash, edit, eye\n• sparkles, bot, brain, cpu, plus, send, copy, info',
              },
              className:
                'font-mono text-xs text-text-muted whitespace-pre-line leading-relaxed bg-bg-primary p-2.5 rounded border border-border',
            },
          ],
        },
        {
          type: 'card',
          title: {
            en: 'Complete Example (.openfox/openfox-multi-repo.json)',
            fr: 'Exemple complet (.openfox/openfox-multi-repo.json)',
          },
          children: [
            {
              type: 'text',
              text: { en: exampleJson, fr: exampleJson },
              className:
                'font-mono text-xs bg-bg-primary text-text-secondary p-3 rounded border border-border whitespace-pre-wrap overflow-x-auto select-text',
            },
          ],
        },
      ],
    },
  ]
}

async function buildDevServerUi(context: PluginToolContext) {
  const services = await discoverDevServices(context.workdir)
  if (services.length === 0) {
    return {}
  }

  const states = getServicesState()

  // Group services and commands by project
  const projectsMap = new Map<
    string,
    {
      servers: DevServerService[]
      inlineCommands: DevServerService[]
      dedicatedCommands: DevServerService[]
    }
  >()

  for (const svc of services) {
    let entry = projectsMap.get(svc.projectName)
    if (!entry) {
      entry = { servers: [], inlineCommands: [], dedicatedCommands: [] }
      projectsMap.set(svc.projectName, entry)
    }
    if (svc.kind === 'server') {
      entry.servers.push(svc)
    } else if (svc.separateLine) {
      entry.dedicatedCommands.push(svc)
    } else {
      entry.inlineCommands.push(svc)
    }
  }

  const rows: DeclarativeNode[] = []

  for (const [projectName, entry] of projectsMap.entries()) {
    if (entry.servers.length > 0) {
      // First server row: includes inline commands + server controls
      const server0 = entry.servers[0]!
      const isRunning0 = states.find((s) => s.name === server0.id || s.name === server0.name)?.status === 'running'
      const serverButtonTitle0 = server0.name && server0.name !== projectName
        ? `${projectName} › ${server0.name}`
        : projectName

      const leftChildren0: DeclarativeNode[] = [
        {
          type: 'text',
          text: { en: '●', fr: '●' },
          className: isRunning0
            ? 'text-accent-success text-xs shrink-0 select-none mr-1'
            : 'text-text-muted text-xs shrink-0 select-none mr-1',
        },
        {
          type: 'text',
          text: { en: projectName, fr: projectName },
          className: 'font-medium text-sm text-text-primary truncate',
        },
      ]

      const rightButtons0: DeclarativeNode[] = []

      // Add inline command buttons
      for (const cmd of entry.inlineCommands) {
        const isCmdRunning = states.find((s) => s.name === cmd.id || s.name === cmd.name)?.status === 'running'
        const cmdTitle = cmd.name ? `${cmd.name} (${cmd.command})` : cmd.command
        const cmdIcon = resolveLucideIcon(cmd.icon ?? 'PlayIcon')
        rightButtons0.push({
          type: 'button',
          icon: isCmdRunning ? resolveLucideIcon('StopIcon') : cmdIcon,
          label: { en: '', fr: '' },
          title: {
            en: isCmdRunning ? `Stop ${cmdTitle}` : `Run ${cmdTitle}`,
            fr: isCmdRunning ? `Arrêter ${cmdTitle}` : `Lancer ${cmdTitle}`,
          },
          variant: isCmdRunning ? 'danger' : 'primary',
          className: '!h-7 !w-7 !p-0 !min-w-7 rounded flex items-center justify-center shrink-0',
          onActivate: {
            kind: 'rpc',
            method: isCmdRunning ? 'stopDevService' : 'startDevService',
            params: { name: cmd.id, cwd: cmd.absolutePath, command: cmd.command },
          },
        })
      }

      // Add server controls (Logs + Start/Stop)
      rightButtons0.push(
        {
          type: 'button',
          icon: resolveLucideIcon('TerminalIcon'),
          label: { en: '', fr: '' },
          title: { en: `Logs (${serverButtonTitle0})`, fr: `Logs (${serverButtonTitle0})` },
          variant: 'default',
          className: '!h-7 !w-7 !p-0 !min-w-7 rounded flex items-center justify-center shrink-0',
          onActivate: {
            kind: 'rpc',
            method: 'openDevLogsModal',
            params: { name: server0.id },
          },
        },
        {
          type: 'button',
          icon: isRunning0 ? resolveLucideIcon('StopIcon') : resolveLucideIcon(server0.icon ?? 'PlayIcon'),
          label: { en: '', fr: '' },
          title: isRunning0
            ? { en: `Stop ${serverButtonTitle0}`, fr: `Arrêter ${serverButtonTitle0}` }
            : { en: `Start ${serverButtonTitle0}`, fr: `Démarrer ${serverButtonTitle0}` },
          variant: isRunning0 ? 'danger' : 'success',
          className: '!h-7 !w-7 !p-0 !min-w-7 rounded flex items-center justify-center shrink-0',
          onActivate: {
            kind: 'rpc',
            method: isRunning0 ? 'stopDevService' : 'startDevService',
            params: { name: server0.id, cwd: server0.absolutePath, command: server0.command },
          },
        },
      )

      rows.push({
        type: 'stack',
        direction: 'row',
        justify: 'between',
        align: 'center',
        className: 'w-full py-1',
        children: [
          {
            type: 'stack',
            direction: 'row',
            align: 'center',
            gap: 'xs',
            className: 'w-auto flex-1 min-w-0 mr-1',
            children: leftChildren0,
          },
          {
            type: 'stack',
            direction: 'row',
            align: 'center',
            gap: 'xs',
            className: 'w-auto shrink-0',
            children: rightButtons0,
          },
        ],
      })

      // Subsequent server rows
      for (let i = 1; i < entry.servers.length; i++) {
        const srv = entry.servers[i]!
        const isSrvRunning = states.find((s) => s.name === srv.id || s.name === srv.name)?.status === 'running'
        const srvTitle = srv.name
          ? srv.name === projectName
            ? srv.name
            : `${projectName} › ${srv.name}`
          : srv.command

        const leftChildrenSrv: DeclarativeNode[] = [
          {
            type: 'text',
            text: { en: '●', fr: '●' },
            className: isSrvRunning
              ? 'text-accent-success text-xs shrink-0 select-none mr-1'
              : 'text-text-muted text-xs shrink-0 select-none mr-1',
          },
        ]
        if (srv.icon) {
          leftChildrenSrv.push({
            type: 'icon',
            icon: resolveLucideIcon(srv.icon),
            className: 'w-4 h-4 text-text-muted shrink-0 mr-1',
          })
        }
        leftChildrenSrv.push({
          type: 'text',
          text: { en: srvTitle, fr: srvTitle },
          className: 'font-medium text-sm text-text-primary truncate',
        })

        rows.push({
          type: 'stack',
          direction: 'row',
          justify: 'between',
          align: 'center',
          className: 'w-full py-1',
          children: [
            {
              type: 'stack',
              direction: 'row',
              align: 'center',
              gap: 'xs',
              className: 'w-auto flex-1 min-w-0 mr-1',
              children: leftChildrenSrv,
            },
            {
              type: 'stack',
              direction: 'row',
              align: 'center',
              gap: 'xs',
              className: 'w-auto shrink-0',
              children: [
                {
                  type: 'button',
                  icon: resolveLucideIcon('TerminalIcon'),
                  label: { en: '', fr: '' },
                  title: { en: `Logs (${srvTitle})`, fr: `Logs (${srvTitle})` },
                  variant: 'default',
                  className: '!h-7 !w-7 !p-0 !min-w-7 rounded flex items-center justify-center shrink-0',
                  onActivate: {
                    kind: 'rpc',
                    method: 'openDevLogsModal',
                    params: { name: srv.id },
                  },
                },
                {
                  type: 'button',
                  icon: isSrvRunning ? resolveLucideIcon('StopIcon') : resolveLucideIcon(srv.icon ?? 'PlayIcon'),
                  label: { en: '', fr: '' },
                  title: isSrvRunning
                    ? { en: `Stop ${srvTitle}`, fr: `Arrêter ${srvTitle}` }
                    : { en: `Start ${srvTitle}`, fr: `Démarrer ${srvTitle}` },
                  variant: isSrvRunning ? 'danger' : 'success',
                  className: '!h-7 !w-7 !p-0 !min-w-7 rounded flex items-center justify-center shrink-0',
                  onActivate: {
                    kind: 'rpc',
                    method: isSrvRunning ? 'stopDevService' : 'startDevService',
                    params: { name: srv.id, cwd: srv.absolutePath, command: srv.command },
                  },
                },
              ],
            },
          ],
        })
      }
    } else if (entry.inlineCommands.length > 0) {
      // Project with only inline commands
      const cmdButtons: DeclarativeNode[] = entry.inlineCommands.map((cmd) => {
        const isCmdRunning = states.find((s) => s.name === cmd.id || s.name === cmd.name)?.status === 'running'
        const cmdTitle = cmd.name ? `${cmd.name} (${cmd.command})` : cmd.command
        const cmdIcon = resolveLucideIcon(cmd.icon ?? 'PlayIcon')
        return {
          type: 'button',
          icon: isCmdRunning ? resolveLucideIcon('StopIcon') : cmdIcon,
          label: { en: '', fr: '' },
          title: {
            en: isCmdRunning ? `Stop ${cmdTitle}` : `Run ${cmdTitle}`,
            fr: isCmdRunning ? `Arrêter ${cmdTitle}` : `Lancer ${cmdTitle}`,
          },
          variant: isCmdRunning ? 'danger' : 'primary',
          className: '!h-7 !w-7 !p-0 !min-w-7 rounded flex items-center justify-center shrink-0',
          onActivate: {
            kind: 'rpc',
            method: isCmdRunning ? 'stopDevService' : 'startDevService',
            params: { name: cmd.id, cwd: cmd.absolutePath, command: cmd.command },
          },
        }
      })

      rows.push({
        type: 'stack',
        direction: 'row',
        justify: 'between',
        align: 'center',
        className: 'w-full py-1',
        children: [
          {
            type: 'stack',
            direction: 'row',
            align: 'center',
            gap: 'xs',
            className: 'w-auto flex-1 min-w-0 mr-1',
            children: [
              {
                type: 'text',
                text: { en: projectName, fr: projectName },
                className: 'font-medium text-sm text-text-primary truncate',
              },
            ],
          },
          {
            type: 'stack',
            direction: 'row',
            align: 'center',
            gap: 'xs',
            className: 'w-auto shrink-0',
            children: cmdButtons,
          },
        ],
      })
    }

    // Render any dedicated-line commands
    for (const dcmd of entry.dedicatedCommands) {
      const isRunning = states.find((s) => s.name === dcmd.id || s.name === dcmd.name)?.status === 'running'
      const dcmdTitle = dcmd.name ? `${projectName} › ${dcmd.name}` : dcmd.command
      const dcmdLabel = dcmd.name ? { en: dcmd.name, fr: dcmd.name } : { en: '', fr: '' }
      const dcmdIcon = resolveLucideIcon(dcmd.icon ?? 'PlayIcon')

      const leftChildren: DeclarativeNode[] = []
      if (dcmd.icon) {
        leftChildren.push({
          type: 'icon',
          icon: resolveLucideIcon(dcmd.icon),
          className: 'w-4 h-4 text-text-muted shrink-0 mr-1',
        })
      }
      if (dcmd.name || !dcmd.icon) {
        leftChildren.push({
          type: 'text',
          text: { en: dcmdTitle, fr: dcmdTitle },
          className: 'font-medium text-sm text-text-primary truncate',
        })
      }

      rows.push({
        type: 'stack',
        direction: 'row',
        justify: 'between',
        align: 'center',
        className: 'w-full py-1',
        children: [
          {
            type: 'stack',
            direction: 'row',
            align: 'center',
            gap: 'xs',
            className: 'w-auto flex-1 min-w-0 mr-1',
            children: leftChildren,
          },
          {
            type: 'stack',
            direction: 'row',
            align: 'center',
            gap: 'xs',
            className: 'w-auto shrink-0',
            children: [
              {
                type: 'button',
                icon: isRunning ? resolveLucideIcon('StopIcon') : dcmdIcon,
                label: dcmdLabel,
                title: {
                  en: isRunning ? `Stop ${dcmdTitle}` : `Run ${dcmdTitle}`,
                  fr: isRunning ? `Arrêter ${dcmdTitle}` : `Lancer ${dcmdTitle}`,
                },
                variant: isRunning ? 'danger' : 'primary',
                className: dcmd.name
                  ? '!h-7 !px-2 !py-0 !min-w-7 rounded font-mono text-xs flex items-center justify-center gap-1 shrink-0'
                  : '!h-7 !w-7 !p-0 !min-w-7 rounded flex items-center justify-center shrink-0',
                onActivate: {
                  kind: 'rpc',
                  method: isRunning ? 'stopDevService' : 'startDevService',
                  params: { name: dcmd.id, cwd: dcmd.absolutePath, command: dcmd.command },
                },
              },
            ],
          },
        ],
      })
    }
  }

  return {
    content: {
      type: 'card',
      className: 'w-full p-3 bg-bg-secondary border border-border rounded-lg shadow-sm space-y-2',
      children: [
        // Header with Title on Left, Info 'i' button on Right
        {
          type: 'stack',
          direction: 'row',
          align: 'center',
          justify: 'between',
          className: 'w-full pb-1 border-b border-border/50',
          children: [
            {
              type: 'text',
              text: { en: 'Dev Servers', fr: 'Serveurs Dev' },
              className: 'text-sm font-semibold text-text-primary',
            },
            {
              type: 'button',
              icon: 'InfoIcon',
              label: { en: '', fr: '' },
              title: { en: 'Configuration guide & JSON format', fr: 'Guide de configuration & format JSON' },
              variant: 'ghost',
              className: '!h-6 !w-6 !p-0 !min-w-6 text-text-muted hover:text-text-primary rounded transition-colors flex items-center justify-center',
              onActivate: {
                kind: 'rpc',
                method: 'openDevHelpModal',
              },
            },
          ],
        },
        {
          type: 'stack',
          direction: 'column',
          align: 'stretch',
          gap: 'xs',
          className: 'w-full',
          children: rows,
        },
      ],
    },
  }
}

export function register(registry: PluginRegistry): void {
  // 1. Enregistrement du VCS Provider
  registry.registerVcsProvider(multirepoVcsProvider)

  // 2. Enregistrement du MessageTransform pour guider les agents
  registry.registerMessageTransform(multirepoAgentTransform)

  // 3. Enregistrement des outils
  registry.registerTool(multirepoStatusTool)
  registry.registerTool(multirepoDevTool)

  // 4. Enregistrement des surcharges UI et panels
  registry.registerUiOverride(multirepoGitUiOverride)
  registry.registerUiOverride(multiDevServerUiOverride)
  registry.registerUiPanel(multirepoBranchModal)
  registry.registerUiPanel(multirepoDevLogsModal)
  registry.registerUiPanel(multirepoDevHelpModal)

  // 4b. Enregistrement des Paramètres & Guide Multi-Repo dans les réglages
  registry.registerSettings({
    fields: [
      {
        key: 'helpGuide',
        type: 'button',
        label: {
          en: 'Multi-Repo Guide & Documentation',
          fr: 'Guide & Documentation Multi-Repo',
        },
        description: {
          en: 'View configuration options, syntax for .openfox/openfox-multi-repo.json, dev servers, one-shot commands, and 1800+ Lucide icons.',
          fr: 'Consulter les options de configuration, la syntaxe de .openfox/openfox-multi-repo.json, les serveurs dev, commandes one-shot et 1800+ icônes Lucide.',
        },
        buttonLabel: {
          en: 'Open Multi-Repo Guide',
          fr: 'Ouvrir le guide multi-dépôts',
        },
        buttonVariant: 'primary',
        rpcMethod: 'openDevHelpModal',
      },
    ],
  })

  // 4c. Composant UI injecté dans les Project Settings (zone project.settings)
  registry.registerUiComponent({
    id: 'multirepo-project-settings-info',
    zone: 'project.settings',
    component: {
      type: 'card',
      title: { en: 'Multi-Repo Configuration', fr: 'Configuration Multi-Dépôts' },
      className: 'w-full',
      children: [
        {
          type: 'text',
          text: {
            en: 'This project is configured as a multi-repository workspace via .openfox/openfox-multi-repo.json. You can manage multiple sub-repos, branch switching, persistent dev servers, and one-shot commands directly from OpenFox.',
            fr: 'Ce projet est configuré en espace multi-dépôts via .openfox/openfox-multi-repo.json. Vous pouvez gérer plusieurs sous-dépôts, changer de branche, piloter vos serveurs dev et exécuter des commandes one-shot directement depuis OpenFox.',
          },
          className: 'text-xs text-text-secondary leading-relaxed mb-3',
        },
        {
          type: 'button',
          label: { en: 'Open Multi-Repo & Dev Command Guide', fr: 'Ouvrir le guide Multi-Repo & Commandes' },
          variant: 'primary',
          icon: 'InfoIcon',
          onActivate: {
            kind: 'rpc',
            method: 'openDevHelpModal',
          },
        },
      ],
    },
  })

  // 5. RPC Handlers
  registry.registerRpc('getGitSidebarUi', async (_params, context) => {
    return buildGitSidebarUi(context)
  })

  registry.registerRpc('getDevServerUi', async (_params, context) => {
    return buildDevServerUi(context)
  })

  registry.registerRpc('openDevHelpModal', async (_params, context) => {
    const workdir = context.workdir ?? process.cwd()
    const draft = getHelpModalDraft(workdir)
    const scan = await scanGitRepositories(workdir)
    draft.discovered = scan.repos
    draft.scanErrors = scan.errors
    draft.statusMessage = undefined

    // Pre-populate selection with currently configured projects
    const configuredPaths = await getConfiguredProjectPaths(workdir)
    draft.selectedPaths.clear()
    for (const repo of scan.repos) {
      if (configuredPaths.has(normalizeRepoPath(repo.relativePath))) {
        draft.selectedPaths.add(repo.relativePath)
      }
    }

    const content = await buildDevHelpModalContent(context)
    return {
      openPanel: 'multirepo-dev-help-modal',
      content,
    }
  })

  registry.registerRpc('rescanReposRpc', async (_params, context) => {
    const workdir = context.workdir ?? process.cwd()
    const draft = getHelpModalDraft(workdir)
    const scan = await scanGitRepositories(workdir)
    draft.discovered = scan.repos
    draft.scanErrors = scan.errors

    // Keep newly scanned repos in selection if they are configured
    const configuredPaths = await getConfiguredProjectPaths(workdir)
    for (const repo of scan.repos) {
      if (configuredPaths.has(normalizeRepoPath(repo.relativePath))) {
        draft.selectedPaths.add(repo.relativePath)
      }
    }

    draft.statusMessage = {
      en: `Scan completed. Found ${scan.repos.length} repository(ies).`,
      fr: `Scan terminé. ${scan.repos.length} dépôt(s) détecté(s).`,
    }
    draft.statusTone = 'info'
    const content = await buildDevHelpModalContent(context)
    return {
      content,
    }
  })

  registry.registerRpc('toggleHelpRepoSelection', async (params, context) => {
    const workdir = context.workdir ?? process.cwd()
    const repoPath = String(params['repoPath'] ?? params['fieldId'] ?? '')
    const rawVal = params['value']
    const isChecked = rawVal === true || rawVal === 'true'
    const draft = getHelpModalDraft(workdir)
    if (repoPath) {
      if (isChecked) {
        draft.selectedPaths.add(repoPath)
      } else {
        draft.selectedPaths.delete(repoPath)
      }
    }
    // Automatically persist changes to configuration in real-time
    const discovered = draft.discovered ?? []
    const res = await syncProjectsWithMultiRepoConfig(workdir, draft.selectedPaths, discovered)
    if (res.success) {
      draft.statusMessage = {
        en: `Configuration updated (${res.totalConfigured} project(s) configured).`,
        fr: `Configuration mise à jour (${res.totalConfigured} projet(s) configuré(s)).`,
      }
      draft.statusTone = 'success'
    } else {
      draft.statusMessage = {
        en: `Error saving configuration: ${res.error ?? 'Unknown error'}`,
        fr: `Erreur lors de l'enregistrement de la configuration : ${res.error ?? 'Erreur inconnue'}`,
      }
      draft.statusTone = 'danger'
    }

    const content = await buildDevHelpModalContent(context)
    return {
      content,
    }
  })

  registry.registerRpc('selectAllHelpReposRpc', async (_params, context) => {
    const workdir = context.workdir ?? process.cwd()
    const draft = getHelpModalDraft(workdir)
    const discovered = draft.discovered ?? []
    draft.selectedPaths.clear()
    for (const repo of discovered) {
      draft.selectedPaths.add(repo.relativePath)
    }
    // Automatically persist all projects to configuration in real-time
    const res = await syncProjectsWithMultiRepoConfig(workdir, draft.selectedPaths, discovered)
    if (res.success) {
      draft.statusMessage = {
        en: `All projects added (${res.totalConfigured} project(s) configured).`,
        fr: `Tous les projets ajoutés (${res.totalConfigured} projet(s) configuré(s)).`,
      }
      draft.statusTone = 'success'
    }
    const content = await buildDevHelpModalContent(context)
    return {
      content,
    }
  })

  registry.registerRpc('unselectAllHelpReposRpc', async (_params, context) => {
    const workdir = context.workdir ?? process.cwd()
    const draft = getHelpModalDraft(workdir)
    const discovered = draft.discovered ?? []
    draft.selectedPaths.clear()
    // Automatically remove all projects from configuration in real-time
    const res = await syncProjectsWithMultiRepoConfig(workdir, draft.selectedPaths, discovered)
    if (res.success) {
      draft.statusMessage = {
        en: `All detected projects removed (${res.totalConfigured} project(s) configured).`,
        fr: `Tous les projets détectés retirés (${res.totalConfigured} projet(s) configuré(s)).`,
      }
      draft.statusTone = 'success'
    }
    const content = await buildDevHelpModalContent(context)
    return {
      content,
    }
  })

  registry.registerRpc('addSelectedReposToConfig', async (_params, context) => {
    const workdir = context.workdir ?? process.cwd()
    const draft = getHelpModalDraft(workdir)
    const discovered = draft.discovered ?? []

    const res = await syncProjectsWithMultiRepoConfig(workdir, draft.selectedPaths, discovered)
    if (res.success) {
      draft.statusMessage = {
        en: `Configuration updated (${res.totalConfigured} project(s) configured, +${res.addedCount}/-${res.removedCount}).`,
        fr: `Configuration mise à jour (${res.totalConfigured} projet(s) configuré(s), +${res.addedCount}/-${res.removedCount}).`,
      }
      draft.statusTone = 'success'
    } else {
      draft.statusMessage = {
        en: `Error saving configuration: ${res.error ?? 'Unknown error'}`,
        fr: `Erreur lors de l'enregistrement de la configuration : ${res.error ?? 'Erreur inconnue'}`,
      }
      draft.statusTone = 'danger'
    }

    const content = await buildDevHelpModalContent(context)
    return { content }
  })

  registry.registerRpc('openDevLogsModal', async (params, context) => {
    const name = String(params['name'] ?? '')
    const content = await buildDevLogsModalContent(name, context)
    return {
      openPanel: 'multirepo-dev-logs-modal',
      content,
    }
  })

  registry.registerRpc('refreshDevLogsRpc', async (params, context) => {
    const name = String(params['name'] ?? '')
    const content = await buildDevLogsModalContent(name, context)
    return {
      openPanel: 'multirepo-dev-logs-modal',
      content,
    }
  })

  registry.registerRpc('startDevService', async (params, context) => {
    const name = String(params['name'] ?? '')
    const cwd = String(params['cwd'] ?? context.workdir ?? process.cwd())
    const command = String(params['command'] ?? 'npm run dev')
    if (name) {
      startService(name, cwd, command)
    }
    const ui = await buildDevServerUi(context)
    return { success: true, ...ui }
  })

  registry.registerRpc('stopDevService', async (params, context) => {
    const name = String(params['name'] ?? '')
    if (name) {
      stopService(name)
    }
    const ui = await buildDevServerUi(context)
    return { success: true, ...ui }
  })

  registry.registerRpc('openBranchModal', async (params, context) => {
    const repoName = String(params['repoName'] ?? '')
    const repos = await findSubGitRepos(context.workdir)
    const targetRepo = repos.find((r) => r.name === repoName)
    if (!targetRepo) return { success: false, error: `Repository ${repoName} not found` }

    branchDrafts.set(repoName, { query: '', newName: '', sourceBranch: '' })
    const content = await buildBranchModalContent(targetRepo.name, targetRepo.absolutePath)
    return {
      openPanel: 'multirepo-branch-modal',
      content,
    }
  })

  registry.registerRpc('filterBranchesRpc', async (params, context) => {
    const repoName = String(params['repoName'] ?? '')
    const query = String(params['value'] ?? '')
    const repos = await findSubGitRepos(context.workdir)
    const targetRepo = repos.find((r) => r.name === repoName)
    if (!targetRepo) return { success: false, error: `Repository ${repoName} not found` }

    setBranchDraft(repoName, { query, error: undefined })
    const content = await buildBranchModalContent(targetRepo.name, targetRepo.absolutePath)
    return {
      openPanel: 'multirepo-branch-modal',
      content,
    }
  })

  registry.registerRpc('setBranchNameRpc', async (params, context) => {
    const repoName = String(params['repoName'] ?? '')
    const value = String(params['value'] ?? '')
    const repos = await findSubGitRepos(context.workdir)
    const targetRepo = repos.find((r) => r.name === repoName)
    if (!targetRepo) return { success: false, error: `Repository ${repoName} not found` }

    setBranchDraft(repoName, { newName: value, error: undefined })
    const content = await buildBranchModalContent(targetRepo.name, targetRepo.absolutePath)
    return {
      openPanel: 'multirepo-branch-modal',
      content,
    }
  })

  registry.registerRpc('setSourceBranchRpc', async (params, context) => {
    const repoName = String(params['repoName'] ?? '')
    const value = String(params['value'] ?? '')
    const repos = await findSubGitRepos(context.workdir)
    const targetRepo = repos.find((r) => r.name === repoName)
    if (!targetRepo) return { success: false, error: `Repository ${repoName} not found` }

    setBranchDraft(repoName, { sourceBranch: value, error: undefined })
    const content = await buildBranchModalContent(targetRepo.name, targetRepo.absolutePath)
    return {
      openPanel: 'multirepo-branch-modal',
      content,
    }
  })

  registry.registerRpc('switchBranchRpc', async (params, context) => {
    const repoName = String(params['repoName'] ?? '')
    const branch = String(params['branch'] ?? '')
    const repos = await findSubGitRepos(context.workdir)
    const targetRepo = repos.find((r) => r.name === repoName)
    if (!targetRepo) return { success: false, error: `Repository ${repoName} not found` }

    const res = await switchRepoBranch(targetRepo.absolutePath, branch)
    setBranchDraft(repoName, { error: res.success ? undefined : res.error })
    const content = await buildBranchModalContent(targetRepo.name, targetRepo.absolutePath)
    return {
      ...res,
      openPanel: 'multirepo-branch-modal',
      content,
    }
  })

  registry.registerRpc('createBranchRpc', async (params, context) => {
    const repoName = String(params['repoName'] ?? '')
    const draft = getBranchDraft(repoName)
    const branch = String(params['value'] ?? params['branch'] ?? draft.newName ?? '')
    const sourceBranch = String(params['sourceBranch'] ?? draft.sourceBranch ?? '').trim()
    const repos = await findSubGitRepos(context.workdir)
    const targetRepo = repos.find((r) => r.name === repoName)
    if (!targetRepo) return { success: false, error: `Repository ${repoName} not found` }
    if (!branch.trim()) {
      setBranchDraft(repoName, { error: 'Branch name is required' })
      const content = await buildBranchModalContent(targetRepo.name, targetRepo.absolutePath)
      return { success: false, error: 'Branch name is required', openPanel: 'multirepo-branch-modal', content }
    }

    const res = await createRepoBranch(targetRepo.absolutePath, branch.trim(), sourceBranch || undefined)
    setBranchDraft(repoName, {
      newName: res.success ? '' : branch.trim(),
      error: res.success ? undefined : res.error,
    })
    const content = await buildBranchModalContent(targetRepo.name, targetRepo.absolutePath)
    return {
      ...res,
      openPanel: 'multirepo-branch-modal',
      content,
    }
  })

  // 6. Commande slash
  registry.registerCommand({
    id: 'git-status-all',
    name: 'Git Status All',
    prompt: 'Exécute l’outil multirepo_status et résume l’état de chaque sous-dépôt Git configuré.',
    agentMode: 'builder',
  })
}

export function deactivate(): void {
  stopAllServices()
  branchDrafts.clear()
  helpModalDrafts.clear()
}
