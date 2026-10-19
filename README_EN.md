# Git Branch Pruner

A lightweight VS Code extension for visually cleaning up local Git branches.

English | [简体中文](README.md)

## Features

- Load local branches immediately without fetching on startup.
- Compact rows place branch names/actions above upstream/status, with Ahead / Behind commit counts against each branch's actual remote upstream (领先 / 落后 in Chinese).
- Follow local Git changes made in terminals or other tools, including checkout, commits, branch creation/deletion and fetch.
- Search, switch and batch-delete local branches; automatic updates preserve valid selections and scroll position.
- Normal deletion preserves Git's merge check; force deletion is a separate, confirmed action.
- Chinese and English interfaces.

## How to Use

1. Open a Git repository and the Git Branch Pruner sidebar. The first workspace folder is used.
2. Review local branches and cached upstream differences. The current branch appears first.
3. Click **Update remote status** to run `git fetch --all --prune` and recalculate counts. This does not pull, merge or push.
4. **Refresh local** only rereads local state. External Git operations normally update the view automatically.
5. Switch a local branch or select branches to delete. Failures never automatically discard worktree changes or escalate to force mode.

## Status Indicators

- **Ahead 3 / Behind 2**: three commits unique to the local branch and two unique to its upstream.
- **Up to date**: no commits unique to either side.
- **No upstream**: no configured comparison target; no misleading zero counts.
- **Upstream ref not found locally**: the local upstream ref is absent; this neither proves server-side deletion nor means the local branch is safe to delete.
- **Current / Protected / In use by worktree**: these branches cannot be deleted.

Each row names its comparison target, such as `origin/feature/login`; branches are not universally compared with main. Counts use locally available history and remote-tracking refs; shallow clones can only reflect the history already fetched. Server changes become visible after an explicit remote update or an external fetch. The extension does not poll remote servers or override proxy settings; it inherits Git's environment and configuration.

Remote updates keep the list visible, support cancellation and time out after 30 seconds. Failure, cancellation and timeout notices explain that some local refs may already have updated, without confirming all remote states. Local refreshes and failed switches preserve that notice; the next completed manual fetch replaces it. Multiple remotes follow Git's `--all` behavior, including `skipFetchAll` settings.

During fetch, the sidebar shows a loading indicator, elapsed seconds and a Cancel fetch button. The list remains visible and searchable; duplicate fetches, switching, selection and deletion are temporarily disabled. Cancellation shows that Git is stopping. When fetch ends, its timer and cancel button disappear immediately; the sidebar shows “Refreshing local state” until the local read completes or fails, then restores controls. Fetch progress and results stay in the sidebar without a duplicate notification popup. The indicator does not estimate completion percentage or replace timeouts and process cancellation.

The manual fetch timestamp includes the date and time of the extension's operation in the current session. It does not guarantee current server state or track each remote independently. External fetches trigger local rereads without changing this timestamp; recreating the view clears the session record.

## Deletion Protection

- Normal deletion uses `git branch -d`. Git checks against upstream or HEAD; this does not necessarily mean merged into the default branch.
- Force deletion uses `-D` and can remove references to unmerged commits. It requires a separate confirmation.
- The existing confirmation puts local-only scope, deletion mode and protection rules before the repository and the complete numbered target list. Confirm buttons explicitly name local branches; there is no extra confirmation step.
- The execution layer protects the current branch, main/master, default branches identified through local remote HEAD refs, and branches occupied by worktrees, including in force mode.
- Batch results explain each outcome. Only local branches are deleted.

## Requirements and Development

- VS Code 1.80.0 or later.
- Git 2.40.0 or later, available on PATH.
- Development and tests use Node.js 22 and pnpm. See [Development](docs/002.DEVELOPMENT.md).
- Run `pnpm run demo` to create an isolated local fixture under the project's `../tmp/demo/run-XXXXXX/`, then follow the [manual acceptance checklist](docs/005.MANUAL_TESTS.md).

## Feedback

If you encounter any issues or have suggestions, please raise them in [GitHub Issues](https://github.com/monkeykjy/git-branch-pruner/issues).

## Changelog

See [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE)
