# openfox-multi-repo

Multi-repository Git management and multi-devserver orchestration plugin for [OpenFox](https://github.com/co-l/openfox).

## Features

- **Multi-Repo Git Discovery & Status**: Auto-discover Git repositories across workspace roots, subdirectories, and nested projects.
- **VCS Provider**: View status, branch information, ahead/behind counts, and staged/unstaged changes across multiple repositories simultaneously.
- **Session-scoped verification diffs**: Filter modified files sent to `verifier` and `code_reviewer` agents (`{{modifiedFiles}}`) to only files modified during the current conversation (`sessionModifiedFilesOnly`, enabled by default).
- **Git Operations**: Checkout, fetch, pull, commit, branch creation, and stash management per repository.
- **Multi-DevServer Management**: Discover, start, stop, restart, and monitor multiple dev server configurations (`.openfox/dev.json` or sub-project dev scripts).
- **Tools & RPC**: Built-in agent tools (`multirepo_list`, `multirepo_status`, `multirepo_git_action`, `multirepo_devserver_action`) for automated multi-repo workflows.
- **UI Slot**: Integrated status bar & multi-repo view for the OpenFox web interface.

## Configuration

Configure your multi-repo workspace in `.openfox/openfox-multi-repo.json` at the root of your workspace. Each project entry uses `"path"` to specify the repository folder.

```json
{
  "projects": [
    {
      "name": "frontend",
      "path": "./frontend",
      "dev": [
        { "name": "web", "command": "npm run dev", "icon": "PlayIcon" }
      ],
      "commands": [
        { "name": "build", "command": "npm run build", "icon": "GearIcon" },
        { "icon": "CheckIcon", "command": "npm run lint" }
      ]
    },
    {
      "name": "backend",
      "path": "./backend"
    }
  ]
}
```

## Installation

Install via OpenFox Plugin Manager or clone and build directly:

```bash
npm install
npm run build
```

## Development

```bash
npm run typecheck
npm run test
npm run build
```

## License

MIT
