import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Session-specific vars that should not leak from the capture shell into managed apps
const SKIP_VARS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'SHELL', 'TERM', 'TMPDIR']);

/**
 * Capture the LOGIN environment of a given shell (fish, zsh, bash, ...).
 * Runs `<shell> -l -c '/usr/bin/env -0'` so whatever that shell's config files
 * export is returned — independent of the user's registered default shell.
 */
export async function captureShellEnv(shell: string): Promise<Record<string, string>> {
  const { stdout } = await execFileP(shell, ['-l', '-c', '/usr/bin/env -0'], {
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
