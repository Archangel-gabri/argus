# Renderer async gate — 2026-09-07

Scope: make the existing full ESLint gate runnable and ensure rejected IPC does not leave the
renderer busy forever, invent success, or publish an obsolete operation in a new dialog.
No dependency versions, main-process APIs, native agent, database files or external services
were changed for this slice.

## Baseline and result

Baseline at `a92890eb8ee93b701eeffb36735dde57b0cd26a4`: clean worktree, 994 unit/DOM tests in
87 files passed, but `npm run lint:all -- --quiet` failed with 64 errors. The ordinary `lint`
script covered only main/preload/shared, so `check` and CI did not inspect renderer failures.

The ordinary `lint` script now covers the same maintained source as `lint:all`. Only
`tools/vendor/**` was added to ignores: this contains the upstream minified axe bundle, not
our maintained tooling. The ASCII name of one test component avoids the hooks plugin's
Cyrillic naming false positive; no hooks or promise rule was weakened.

Final local result for this slice:

- `npm test`: 1051/1051 tests, 96/96 files, no unhandled errors (57 additional tests).
- `npm run typecheck`: node and web PASS.
- `npm run lint -- --quiet`: PASS. Full ESLint inventory: 287 source/test/tool/config files,
  zero errors and 156 warnings under the existing policy (102 unsafe-call, 32 unsafe-argument,
  21 unsafe-return, one exhaustive-deps). This is **not** warning-free lint.
- `npm run build`: PASS. Existing mixed static/dynamic SFTP import warning remains.
- `git diff --check`: PASS.

## Behavior matrix

| Risk/workflow | Required outcome | Regression evidence |
|---|---|---|
| Vault IPC rejection | Release busy, do not claim successful unlock, avoid raw sensitive exception text | `store/vault.test.ts` |
| Lost initialize/unlock/lock acknowledgement | Keep renderer concealed; refresh cannot reopen it; retry requires acknowledged lock before password validation | `store/vault.test.ts` |
| Older unlock response after a newer lock | Cannot overwrite the newer locked state | `store/vault.test.ts` |
| Password checker unavailable | Setup remains blocked, visible generic error, no initialize call | `components/LockScreen.async.test.tsx` |
| Broadcast partial failure | Keep successful hosts' output and each failed host's error, release running | `components/BroadcastPanel.test.tsx` |
| Snippet and SSH-import operations | Error is visible; no false saved/added result; obsolete dialog/source response ignored | Broadcast and SshImportDialog tests |
| SFTP open/list/transfer failures | Loading/busy released, error and recovery path visible | `components/panes/FilesPane.test.tsx` |
| SFTP reconnect, unmount, StrictMode, device change | Current session closed; late open closes itself; obsolete transfer does not modify the new pane | FilesPane tests |
| Forward/OS/power/hardware IPC failure | Visible failure or unknown state, never false offline/success, cleanup and success controls preserved | `components/panes/PaneAsync.test.tsx` |
| Metrics history unavailable | Different from an acknowledged empty history | `components/panes/MetricsPane.test.tsx` |
| Credential save rejection | Form stays open, busy released, sensitive exception text not rendered | `components/finance/AccountList.async.test.tsx` |
| Device-load follow-up liveness rejection | Awaited and recorded rather than orphaned | `store/devices.test.ts` |

The focused rejection tests were run red before each behavioral slice, then green. Independent
review caught additional stale-dialog and lost-acknowledgement cases; both were reproduced as
failing regressions and corrected before the final full run. Existing regression tests were
preserved.

## Acceptance boundary

These are synthetic IPC/unit/DOM checks plus compile/build evidence. They do not demonstrate
actual SSH, power, boot, Wake-on-LAN, desktop screenshots, OS injection, native SQLCipher,
external finance APIs, production fleet health or packaged AppImage behavior. Renderer
concealment is not proof that main acknowledged a database lock; the UI explicitly distinguishes
that failure and requires reconciliation before authentication can resume.

The remaining 156 lint warnings are separate debt, not suppressed errors. `check:full`, native
vault/agent/net/live/E2E and remote CI are separate gates; publication remains controlled by the
workspace coordinator's fresh hashes, review and exact staging whitelist.
