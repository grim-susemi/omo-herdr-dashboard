# Current dashboard verification

Verified on Windows on 2026-10-04 with Node 24.12.0, Herdr 0.9.3, OmO 5.1.16 and stock Senpi 2026.10.7. The unified runtime supersedes earlier split-extension acceptance; earlier file hashes are historical evidence only.

## Source provenance

- Todo history imported without squashing from `2aa1820cfcc1ffb4dd2161bccc4af4e663a21e66` into `packages/todo`.
- DAG history imported without squashing from `282ed765a5037bda318a3285b150f780a7417090` into `packages/dag`.
- Original MIT licenses and attribution are retained. The SDK is imported read-only and is not redistributed.

## Tests and package checks

| Check | Result |
| --- | --- |
| Todo unit/component suite | 135 passed |
| Stock SDK host tests | 30 passed; all 16 source hashes unchanged; private fixture removed |
| Affected DAG controller, extension, view, follow and real Windows PTY tests | 109 passed |
| Unified installer isolation test | 1 passed |
| Unified build | Passed |
| Offline archive install | Passed; 38 archive files, 24 component runtime hashes matched, one extension entry |

The first affected DAG run lacked its declared `node-pty` development dependency in the new checkout. After supplying the existing exact 1.1.0 dependency locally, all 109 affected tests passed. This is not a claim that the entire inherited standalone DAG suite was rerun or passed; earlier unrelated Windows helper failures remain outside that coverage.

Two regressions were reproduced before their fixes: a readable native Todo branch with no Todo entry could fail startup, and Herdr's same-tab `move` returned success without changing geometry. Tests preserve the expected behavior. The current layout uses actual supported splits and swaps and validates role geometry after placement.

## Observed installed surface

The actual installed generation contained only `omo-herdr-dashboard.js` as its Herdr extension entry. All 24 installed component runtime hashes matched the tested build. Managed legacy entries were backed up; unrelated extensions, original engine files and game files were not changed.

Actual Herdr pane geometry was verified at 172 columns by 46 rows: conversation 69 columns, Todo 52 by 23 at the upper left of the dashboard, ordinary workers 52 by 23 below it, and DAG 51 by 46 on the right. The 52-column Todo footer included the complete compact control hint without clipping `q`.

Native `/todo append`, `start` and `done` commands were exercised through the actual parent session. Todo follow was turned off while the DAG and worker views remained on. Closing Todo with `q` and running `/dashboard` rebuilt the verified owned roles, retained Todo follow-off and native target data, and preserved the conversation input target. Completed Todo phases folded by default. Fresh waiting state and active/completed states were observed.

Private evidence contains actual visible Herdr ANSI frames, role geometry, ownership records and hashes. Replayed PNGs were inspected directly; they are terminal snapshots, not desktop screenshots. No private session records or machine paths are included in this repository. A final attempted Todo clear was not confirmed before the owned panes disappeared; it is not counted as a passing clear scenario. No replacement session was launched over that later state.

## Reproduce the current manual checks

1. Build and install the root package in an explicit disposable agent directory. Start a fresh OmO session in a separately owned Herdr tab. Confirm a single dashboard entry is loaded.
2. Issue `/dashboard` from the conversation. Use `herdr pane layout --pane <parent>` to verify exactly four panes and the requested two-column role order; inspect visible ANSI for each role.
3. Add and start a native Todo. Toggle `f` only in Todo and verify the other follow states are unchanged. Close Todo with `q`, issue `/dashboard` from the conversation, then verify data and view preferences persist even if pane IDs changed.
4. Complete the Todo and inspect default phase folding and the compact footer. Check ordinary-worker and DAG source updates using the existing producer records or an isolated fixture; distinguish waiting/error/disconnected labels from live data.
5. Clean only resources whose creation receipts, pane/process identity, cwd and launch arguments establish ownership. Preserve unrelated tabs and installation generations.

Herdr swaps can briefly change selection; the controller applies observed ownership and focus guards. This verifies final Herdr input selection, not OS foreground or physical keyboard routing. Historical `packages/todo/scripts/qa-live.mjs` covers the retired three-row candidate and must not be treated as this layout's acceptance script.
