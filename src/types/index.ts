export interface Branch {
  name: string;
  isLocal: boolean;
  /** These are local refs, not a live query of the remote server. */
  exists: { local: boolean; remote: boolean };
  upstream?: string;
  ahead?: number;
  behind?: number;
  isCurrentBranch: boolean;
  isMainBranch: boolean;
  isWorktreeBranch: boolean;
}

export type DeleteStatus = 'deleted' | 'notFound' | 'protected' | 'worktree' | 'unmerged' | 'invalid' | 'failed';

export interface DeleteResult {
  name: string;
  status: DeleteStatus;
}

export interface RemoteProgress {
  startedAt: number;
  cancelling: boolean;
}

export type WebviewMessage =
  | { type: 'refresh' | 'fetch' | 'cancelFetch' | 'ready' }
  | { type: 'switch'; branch: string }
  | { type: 'confirmDelete'; branches: string[]; force: boolean };

export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const message = value as Record<string, unknown>;
  if (message.type === 'refresh' || message.type === 'fetch' || message.type === 'cancelFetch' || message.type === 'ready') {
    return { type: message.type };
  }
  if (message.type === 'switch' && typeof message.branch === 'string' && message.branch && !message.branch.includes('\0')) {
    return { type: 'switch', branch: message.branch };
  }
  if (
    message.type === 'confirmDelete' &&
    typeof message.force === 'boolean' &&
    Array.isArray(message.branches) &&
    message.branches.length > 0 &&
    message.branches.every((name) => typeof name === 'string' && name.length > 0 && !name.includes('\0'))
  ) {
    return { type: 'confirmDelete', branches: [...new Set(message.branches as string[])], force: message.force };
  }
  return undefined;
}
