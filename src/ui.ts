import type { PluginUiOverride, PluginUiPanel } from 'openfox/plugin'

export const multirepoGitUiOverride: PluginUiOverride = {
  id: 'multirepo-git-section',
  zone: 'session.sidebar.git',
  mode: 'replace',
  contentSource: {
    kind: 'rpc',
    method: 'getGitSidebarUi',
    refreshMs: 3000,
  },
}

export const multiDevServerUiOverride: PluginUiOverride = {
  id: 'multirepo-devserver-section',
  zone: 'session.sidebar.devserver',
  mode: 'replace',
  contentSource: {
    kind: 'rpc',
    method: 'getDevServerUi',
    refreshMs: 2000,
  },
}

export const multirepoBranchModal: PluginUiPanel = {
  id: 'multirepo-branch-modal',
  title: { en: 'Switch Branch', fr: 'Changer de branche' },
  size: 'md',
  kind: 'declarative',
  content: [],
  footer: [
    {
      type: 'stack',
      direction: 'row',
      justify: 'end',
      gap: 'sm',
      className: 'w-full',
      children: [
        {
          type: 'button',
          label: { en: 'Cancel', fr: 'Annuler' },
          variant: 'default',
          onActivate: { kind: 'closePanel' },
        },
      ],
    },
  ],
}

export const multirepoDevLogsModal: PluginUiPanel = {
  id: 'multirepo-dev-logs-modal',
  title: { en: 'Dev Server Logs', fr: 'Journaux du serveur de dev' },
  size: 'lg',
  kind: 'declarative',
  content: [],
  footer: [
    {
      type: 'stack',
      direction: 'row',
      justify: 'end',
      gap: 'sm',
      className: 'w-full',
      children: [
        {
          type: 'button',
          label: { en: 'Close', fr: 'Fermer' },
          variant: 'default',
          onActivate: { kind: 'closePanel' },
        },
      ],
    },
  ],
}

export const multirepoDevHelpModal: PluginUiPanel = {
  id: 'multirepo-dev-help-modal',
  title: { en: 'Multi-Repo Dev & Commands Guide', fr: 'Guide Dev & Commandes Multi-Repo' },
  size: 'xl',
  kind: 'declarative',
  content: [],
  footer: [
    {
      type: 'stack',
      direction: 'row',
      justify: 'end',
      gap: 'sm',
      className: 'w-full',
      children: [
        {
          type: 'button',
          label: { en: 'Close', fr: 'Fermer' },
          variant: 'default',
          onActivate: { kind: 'closePanel' },
        },
      ],
    },
  ],
}
