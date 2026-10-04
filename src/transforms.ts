import type { PluginMessageTransform } from 'openfox/plugin'
import { findSubGitRepos, isMultiRepoProject } from './discovery.js'

export const multirepoAgentTransform: PluginMessageTransform = {
  id: 'multirepo-agent-guidance',
  priority: 50,

  async transform(messages, context) {
    const isMulti = await isMultiRepoProject(context.workdir)
    if (!isMulti) {
      return {
        messages,
        systemPrompt: context.systemPrompt,
      }
    }

    const repos = await findSubGitRepos(context.workdir)
    const repoList = repos.map((r) => `- \`${r.relativePath}\``).join('\n')

    const instruction = `\n\n## Multi-Repository Workspace Notice
This workspace contains multiple Git repositories:
${repoList}

### Guidelines for Sub-Agents (code_reviewer, verifier) and Builder:
1. **File Paths**: All modified file paths in \`{{modifiedFiles}}\` are relative to the root workdir (e.g. \`backend/src/index.ts\`). Use \`read_file\` with these paths directly.
2. **Git Commands**: The root directory is NOT a single git repository. To run git commands (such as \`git diff\`, \`git log\`, or \`git status\`), always target the specific sub-repository using:
   \`git -C <subrepo_path> <git_command>\` (for example: \`git -C backend diff\`).`

    return {
      messages,
      systemPrompt: (context.systemPrompt || '') + instruction,
    }
  },
}
