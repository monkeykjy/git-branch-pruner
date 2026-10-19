import { execFile, spawn } from 'child_process';

export interface GitOutput { stdout: string; stderr: string; }
export interface GitRunOptions { timeoutMs?: number; signal?: AbortSignal; }
export interface GitRunner {
  run(args: string[], cwd?: string, options?: GitRunOptions): Promise<GitOutput>;
}

export class GitCommandError extends Error {
  constructor(
    public readonly code: number | string | null | undefined,
    public readonly stderr: string,
    public readonly reason: 'failed' | 'timeout' | 'cancelled' = 'failed'
  ) {
    super(stderr || `Git command ${reason}`);
    this.name = 'GitCommandError';
  }
}

/** Uses argument arrays and inherits the user's proxy/authentication configuration. */
export class ProcessGitRunner implements GitRunner {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  run(args: string[], cwd?: string, options: GitRunOptions = {}): Promise<GitOutput> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new GitCommandError(undefined, '', 'cancelled'));
        return;
      }
      const child = spawn('git', args, {
        cwd, env: { ...this.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let finished = false;
      let failure: string | undefined;
      let stopped: 'timeout' | 'cancelled' | undefined;
      const kill = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (error) => {
            if (error) child.kill();
          });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      };
      const stop = (reason: 'timeout' | 'cancelled') => {
        if (finished || stopped) return;
        stopped = reason; kill();
      };
      const abort = () => stop('cancelled');
      const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 10_000);
      const collect = (text: string, errorStream: boolean) => {
        bytes += Buffer.byteLength(text);
        if (bytes > 16 * 1024 * 1024) {
          if (!failure) { failure = 'Git output exceeded the size limit'; kill(); }
          return;
        }
        if (errorStream) stderr += text;
        else stdout += text;
      };
      child.stdout.setEncoding('utf8').on('data', (text: string) => collect(text, false));
      child.stderr.setEncoding('utf8').on('data', (text: string) => collect(text, true));
      child.on('error', (error: NodeJS.ErrnoException) => { failure = error.code ?? 'Git could not start'; });
      child.on('close', (code) => {
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (code !== 0 || failure || stopped) reject(new GitCommandError(code, failure ?? stderr, stopped));
        else resolve({ stdout, stderr });
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }
}
