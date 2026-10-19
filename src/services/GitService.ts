import * as path from 'path';
import { Branch, DeleteResult } from '../types';
import { GitCommandError, GitRunOptions, GitRunner, ProcessGitRunner } from './GitRunner';

/** Repository operations are independent of VS Code and always receive a fixed working directory. */
export class GitService {
  constructor(private readonly runner: GitRunner = new ProcessGitRunner()) {}

  public async checkGitInstallation(): Promise<boolean> {
    try {
      await this.runner.run(['--version']);
      return true;
    } catch { return false; }
  }

  public async isGitRepository(cwd: string, options: GitRunOptions = {}): Promise<boolean> {
    try {
      const { stdout } = await this.runner.run(['rev-parse', '--is-inside-work-tree'], cwd, options);
      return stdout.trim() === 'true';
    } catch (error) {
      // Outside a repository Git exits with 128; startup, timeout and cancellation
      // errors must propagate so the caller can distinguish them in diagnostics.
      if (error instanceof GitCommandError && error.code === 128) return false;
      throw error;
    }
  }

  public async fetchRemote(cwd: string, signal?: AbortSignal): Promise<void> {
    await this.runner.run(['fetch', '--all', '--prune'], cwd, { timeoutMs: 30_000, signal });
  }

  public async getGitDirectories(cwd: string, options: GitRunOptions = {}): Promise<string[]> {
    const gitDir = (await this.runner.run(['rev-parse', '--absolute-git-dir'], cwd, options)).stdout.trim();
    const common = (await this.runner.run(['rev-parse', '--git-common-dir'], cwd, options)).stdout.trim();
    return [...new Set([gitDir, path.resolve(cwd, common)])];
  }

  public async switchBranch(cwd: string, name: string): Promise<void> {
    const branch = (await this.getBranches(cwd)).find(item => item.name === name);
    if (!branch || branch.isWorktreeBranch || name.startsWith('-')) {
      throw new Error('Branch unavailable for checkout');
    }
    await this.runner.run(['switch', '--no-guess', '--', name], cwd);
  }

  public async getBranches(cwd: string, options: GitRunOptions = {}): Promise<Branch[]> {
    const { stdout } = await this.runner.run(
      ['for-each-ref', '--format=%(refname)%00%(symref)%00%(upstream)%00%(upstream:track,nobracket)', 'refs/heads/', 'refs/remotes/'],
      cwd, options
    );
    const refs = stdout.split('\n').filter(Boolean).map((line) => {
      const [ref, target, upstream, track] = line.split('\0');
      return { ref, target, upstream, track };
    });
    let current = '';
    try {
      current = (await this.runner.run(['symbolic-ref', '--quiet', 'HEAD'], cwd, options)).stdout.trim();
    } catch (error) {
      // Exit 1 is expected for detached HEAD; other errors must not masquerade as an empty repository.
      if (!(error instanceof GitCommandError) || error.code !== 1) {
        throw error;
      }
    }
    const worktrees = (await this.runner.run(['worktree', 'list', '--porcelain', '-z'], cwd, options)).stdout;
    const occupied = new Set(
      worktrees.split('\0').filter((field) => field.startsWith('branch ')).map((field) => field.slice(7))
    );
    const defaults = new Set(
      refs.filter(({ ref, target }) => ref.startsWith('refs/remotes/') && ref.endsWith('/HEAD') && target)
        .map(({ target }) => target)
    );
    const protectedNames = new Set(['main', 'master']);
    for (const { ref, target } of refs.filter(item => item.ref.endsWith('/HEAD') && item.target)) {
      const prefix = ref.slice(0, -4);
      if (target.startsWith(prefix)) protectedNames.add(target.slice(prefix.length));
    }
    const existing = new Set(refs.map(({ ref }) => ref));
    return refs.filter(({ ref }) => ref.startsWith('refs/heads/')).map(({ ref, upstream, track }) => {
      const name = ref.slice('refs/heads/'.length);
      const remoteExists = !!upstream && upstream.startsWith('refs/remotes/') && existing.has(upstream);
      return {
        name,
        isLocal: true,
        exists: { local: true, remote: remoteExists },
        upstream: upstream || undefined,
        ahead: remoteExists ? Number(track.match(/ahead (\d+)/)?.[1] ?? 0) : undefined,
        behind: remoteExists ? Number(track.match(/behind (\d+)/)?.[1] ?? 0) : undefined,
        isCurrentBranch: ref === current,
        isMainBranch: protectedNames.has(name) || defaults.has(upstream),
        isWorktreeBranch: occupied.has(ref),
      };
    }).sort((a, b) => Number(b.isCurrentBranch) - Number(a.isCurrentBranch) || a.name.localeCompare(b.name));
  }

  public async deleteBranches(cwd: string, branchNames: string[], force = false): Promise<DeleteResult[]> {
    const results: DeleteResult[] = [];
    for (const name of new Set(branchNames)) {
      try {
        if (typeof name !== 'string' || !name || name.startsWith('-') || name.includes('\0')) {
          results.push({ name, status: 'invalid' });
          continue;
        }
        try {
          await this.runner.run(['check-ref-format', `refs/heads/${name}`], cwd);
        } catch (error) {
          if (error instanceof GitCommandError && error.code === 1) {
            results.push({ name, status: 'invalid' });
            continue;
          }
          throw error;
        }
        // Re-read before each deletion, including after time spent in a confirmation dialog.
        const branch = (await this.getBranches(cwd)).find((item) => item.name === name);
        if (!branch) {
          results.push({ name, status: 'notFound' });
        } else if (branch.isMainBranch || branch.isCurrentBranch) {
          results.push({ name, status: 'protected' });
        } else if (branch.isWorktreeBranch) {
          results.push({ name, status: 'worktree' });
        } else {
          await this.runner.run(['branch', force ? '-D' : '-d', '--', name], cwd);
          results.push({ name, status: 'deleted' });
        }
      } catch (error) {
        const unmerged = !force && error instanceof GitCommandError && error.stderr.includes('is not fully merged');
        results.push({ name, status: unmerged ? 'unmerged' : 'failed' });
      }
    }
    return results;
  }
}
