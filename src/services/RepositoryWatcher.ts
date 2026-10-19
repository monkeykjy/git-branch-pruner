import { FSWatcher, watch } from 'fs';
import { readdir } from 'fs/promises';
import * as path from 'path';

/** Watch only Git metadata, never the object database or the whole working tree. */
export class RepositoryWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private scanning = false;
  private rescan = false;

  constructor(
    private readonly directories: string[],
    private readonly onChange: () => void,
    private readonly onError: () => void = () => {}
  ) {}

  public async start(signal?: AbortSignal): Promise<void> { await this.reconcile(signal); }

  public dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private changed(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      try { await this.reconcile(); } catch { this.onError(); }
      if (!this.disposed) this.onChange();
    }, 150);
  }

  private async reconcile(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Repository watcher start cancelled');
    if (this.scanning) { this.rescan = true; return; }
    this.scanning = true;
    try {
      const desired = new Set<string>();
      const add = async (directory: string, recursive: boolean) => {
        if (signal?.aborted) throw new Error('Repository watcher start cancelled');
        try {
          const entries = await readdir(directory, { withFileTypes: true });
          if (signal?.aborted) throw new Error('Repository watcher start cancelled');
          desired.add(directory);
          if (recursive) {
            for (const entry of entries) {
              if (signal?.aborted) throw new Error('Repository watcher start cancelled');
              if (entry.isDirectory()) await add(path.join(directory, entry.name), true);
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
      for (const directory of this.directories) {
        if (signal?.aborted) throw new Error('Repository watcher start cancelled');
        await add(directory, false);
        await add(path.join(directory, 'refs'), true);
        await add(path.join(directory, 'reftable'), true);
        const worktrees = path.join(directory, 'worktrees');
        await add(worktrees, false);
        try {
          for (const entry of await readdir(worktrees, { withFileTypes: true })) {
            if (signal?.aborted) throw new Error('Repository watcher start cancelled');
            if (entry.isDirectory()) await add(path.join(worktrees, entry.name), false);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (this.disposed) return;
      for (const [directory, watcher] of this.watchers) {
        if (!desired.has(directory)) { watcher.close(); this.watchers.delete(directory); }
      }
      for (const directory of desired) {
        if (this.watchers.has(directory)) continue;
        const watcher = watch(directory, (event, filename) => {
          const name = filename?.toString();
          if (name?.endsWith('.lock')) return;
          if (this.directories.includes(directory) && name &&
            !['HEAD', 'FETCH_HEAD', 'packed-refs', 'config', 'config.worktree', 'shallow', 'refs', 'worktrees', 'reftable'].includes(name)) return;
          if (event === 'rename' && name) {
            const changedPath = path.join(directory, name);
            for (const [watchedPath, old] of this.watchers) {
              if (watchedPath === changedPath || watchedPath.startsWith(changedPath + path.sep)) {
                old.close(); this.watchers.delete(watchedPath);
              }
            }
          }
          this.changed();
        });
        watcher.on('error', () => {
          watcher.close(); this.watchers.delete(directory);
          if (!this.disposed) this.onError();
        });
        this.watchers.set(directory, watcher);
      }
    } finally {
      this.scanning = false;
      if (this.rescan && !this.disposed) { this.rescan = false; this.changed(); }
    }
  }
}
