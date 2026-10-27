import { isAbsolute } from 'path';
import { GitCommandError } from './services/GitRunner';

/** Public subset of vscode.git API v1, available since our minimum VS Code 1.80. */
export interface GitExtensionApi {
  readonly enabled: boolean;
  getAPI(version: 1): { readonly git: { readonly path: string } };
}

export const GIT_PATH_TIMEOUT_MS = 2000;

/** Resolve only the executable; do not wait for repository discovery or subscribe to Git state. */
export function createGitPathResolver(
  activate: () => Promise<GitExtensionApi | undefined>,
  log: (message: string) => void
): (signal?: AbortSignal) => Promise<string> {
  let lastSource = '';
  return (signal) => new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GitCommandError(undefined, '', 'cancelled'));
      return;
    }
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (path: string, source: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (source !== lastSource) { lastSource = source; log(`git-path:source=${source}`); }
      resolve(path);
    };
    const abort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new GitCommandError(undefined, '', 'cancelled'));
    };
    const timer = setTimeout(() => finish('git', 'PATH reason=api-timeout'), GIT_PATH_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    // Do not cache failures: a later command can use the API once activation succeeds.
    void Promise.resolve().then(() => finished ? undefined : activate()).then(extension => {
      if (finished) return;
      const path = extension?.enabled ? extension.getAPI(1).git.path : undefined;
      if (typeof path === 'string' && isAbsolute(path) && !path.includes('\0')) {
        finish(path, 'vscode.git');
      } else {
        finish('git', 'PATH reason=api-unavailable');
      }
    }).catch(() => finish('git', 'PATH reason=api-unavailable'));
  });
}
