import { execFileSync } from 'node:child_process'
// This projection concern belongs to the Runtime Source, not the Mnemon Core.

const GIT_BRANCH_TIMEOUT_MS = 2_000

/**
 * Resolve the current git branch of a workspace root. Returns undefined when
 * the directory is not a git working tree, HEAD is detached, or the probe
 * fails or times out, so callers fall back to the unfiltered view.
 */
/**
 * Git takes the repository location from the environment, so a launcher that
 * exports `GIT_DIR` for its own reasons would point this probe at a directory
 * that is not the workspace. The probe runs with those variables removed.
 */
export function gitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || name.toUpperCase().startsWith('GIT_')) continue
    sanitized[name] = value
  }
  return sanitized
}

export function resolveGitBranch(cwd?: string): string | undefined {
  const root = cwd?.trim()
  if (root === undefined || root === '') return undefined
  try {
    const output = execFileSync('git', ['-C', root, 'branch', '--show-current'], {
      encoding: 'utf8',
      timeout: GIT_BRANCH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: gitEnvironment(),
    })
    const branch = output.trim()
    return branch === '' ? undefined : branch
  } catch {
    return undefined
  }
}
