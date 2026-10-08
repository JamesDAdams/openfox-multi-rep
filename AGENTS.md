# AGENTS.md — openfox-multi-repo

Paths relative to `openfox-plugins/openfox-multi-repo/`.

## Purpose

OpenFox plugin for multi-repo Git management and orchestration of multiple dev servers. Automatic repository discovery, Git operations, dev server management, and integrated agent tools.

## Stack

- TypeScript, ESM, tsup, vitest 3.x
- peerDep: `openfox` (not specified)

## Commands

```bash
npm run build      # tsup
npm test           # vitest run
npm run typecheck  # tsc --noEmit
```

## Project Map

```
src/
├── index.ts              # Plugin entry point (register)
├── repository-scanner.ts # Git repository discovery
├── discovery.ts          # Discovery logic
├── git-ops.ts            # Git operations
├── dev-servers.ts        # Dev servers management
├── session-tracker.ts    # Session modified files tracking
├── vcs-provider.ts       # VCS provider (status, branch, ahead/behind, diff)
├── transforms.ts         # Data transforms
├── tools.ts              # Agent tools (multirepo_*)
├── ui.ts                 # UI slot (status bar, multi-repo view)
├── icons.ts              # UI icons
└── lucide-data.json      # Lucide icon data
```

## Where to Look What

- **Add an agent tool** → `src/tools.ts`
- **Modify repository discovery** → `src/repository-scanner.ts` + `src/discovery.ts`
- **Modify Git operations** → `src/git-ops.ts`
- **Modify dev servers management** → `src/dev-servers.ts`
- **Modify session modified files tracking** → `src/session-tracker.ts`
- **Add a setting** → `src/index.ts` (SETTINGS_SCHEMA)

## Conventions

- `apiVersion: 2`, capabilities: `vcs`, `transforms`, `tools`, `commands`, `ui`, `rpc`, `settings`
- ESM build only via tsup (dts: false)
- `openfox` and `openfox/plugin` are externalized
- Every source file has its corresponding test (co-located)

## Cross-Project Dependencies

**Consumes**: `openfox` (peerDep), `openfox/plugin` (PluginRegistry, PluginToolContext, DeclarativeNode).

**Consumed by**: OpenFox (loaded as plugin).

**Touchpoints**:

- `src/index.ts` (register)
- `src/vcs-provider.ts` (VCS provider)
- `src/tools.ts` (agent tools multirepo_*)
- `src/dev-servers.ts` (dev servers management)

## Known Gotchas

- `dist/index.js` is the entry point loaded by OpenFox, not `src/`.
- Configuration via `.openfox/openfox-multi-repo.json`.
- Module-level state for `git-status-all` (watch out for concurrency).
- `lucide-data.json` is icon data, do not edit by hand.

## Do Not Read / Do Not Touch

- `node_modules/`, `dist/`, `.git/`

## Further Reading

- [README.md](README.md) — overview

---

> After any change affecting structure, a command, a convention, an inter-project contract, or a primary flow, update this file in the same commit. If any information here is inaccurate, fix it.
