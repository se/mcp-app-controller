import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);

// Session-specific vars that should not leak from the capture shell into managed apps
const SKIP_VARS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'SHELL', 'TERM', 'TMPDIR']);

/**
 * The user's shell, for when apps.yaml does not configure envShell explicitly.
 * $SHELL is set when the daemon was started from a terminal; os.userInfo().shell
 * reads the passwd entry, which also works when launched by launchd/GUI.
 */
export function defaultShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  try {
    const shell = os.userInfo().shell;
    if (shell) return shell;
  } catch { /* fall through */ }
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

/**
 * Capture the environment of a given shell (fish, zsh, bash, ...) so managed apps
 * see the same variables the user has in their terminal.
 *
 * zsh/bash run as login+interactive (`-ilc`) so BOTH profile and rc files are
 * sourced (.zprofile AND .zshrc; .bash_profile, which typically chains .bashrc).
 * fish sources config.fish on every invocation, so login (`-lc`) is enough.
 */
export async function captureShellEnv(shell: string): Promise<Record<string, string>> {
  const name = path.basename(shell);
  const args = name === 'zsh' || name === 'bash'
    ? ['-ilc', '/usr/bin/env -0']
    : ['-l', '-c', '/usr/bin/env -0'];
  const { stdout } = await execFileP(shell, args, {
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const env: Record<string, string> = {};
  for (const entry of stdout.split('\0')) {
    const i = entry.indexOf('=');
    if (i <= 0) continue;
    const key = entry.slice(0, i);
    if (SKIP_VARS.has(key)) continue;
    env[key] = entry.slice(i + 1);
  }
  return env;
}
