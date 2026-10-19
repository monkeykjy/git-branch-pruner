# Change Log

## [0.2.0] - Unreleased

- Build the extension automatically before packaging and exclude development-only files from the VSIX.

- Localize the extension description and local-branch view title for Simplified Chinese, with English defaults. Reorganize both READMEs with language-switching instructions and six screenshots rendered from the current Webview using demo data.

- End fetch progress immediately and show the following local refresh separately, keeping actions disabled until it finishes. Prevent late local-read callbacks from recreating disposed log channels or writing into a reopened view.

- Remove the duplicate remote-fetch progress notification; keep progress, cancellation and outcomes in the sidebar.
- Put local-only deletion scope, mode and protection rules before complete numbered targets in the existing confirmation. Add sidebar fetch loading, elapsed time and cancellation, with a local delayed-fetch demo for macOS/Linux.
- Clarify locally missing upstream refs and cache provenance in both languages. Preserve remote-update outcomes across local refreshes and failed switches, qualify manual fetch timestamps, and explain possible partial ref updates after failure, timeout or cancellation.
- Replace branch cards with compact separated rows, keeping names/actions above upstream/status; use Chinese commit-count labels and quieter protection markers.
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
