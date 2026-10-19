# Change Log

## [Unreleased]

- Keep the focus on local branch cleanup; restore compact list styling based on the previous interface while retaining search, switching, accurate status and deletion safeguards.

- Load local branch state without fetching; add separate local-refresh and remote-update actions.
- Show Ahead / Behind commit counts and the actual upstream target, with explicit untracked/missing-upstream states.
- Watch local Git metadata, including linked worktrees and external fetches, and update the list without losing valid selection, search or scroll state.
- Add local branch switching, search, cancellable remote updates and timeouts.
- Use shell-free Git execution, escaped Webview content, a nonce-based CSP and validated messages.
- Default to non-forced deletion, enforce branch/worktree protection in the service, and report per-branch results.
- Add local Git behavior tests, an extension-host test entry and a disposable manual-test fixture.

## [0.1.1]

- Initial branch list and batch deletion implementation.
