# Current dashboard verification

## 2026-10-16 worker-update masking repair

Ordinary worker content updates no longer invalidate healthy viewer offers or
briefly restore native widgets. Connection and DAG coverage changes still require
fresh paint. Bounded diagnostics record readiness reasons, sequence and publication
I/O stage without session content or paths. Compact ordinary worker cards omit
the redundant reported-cost badge while retaining amounts, estimated/unknown
information and verbose detail quality.

Focused checks passed: 73 core tests, 7 metric tests and 1 actual worker PTY test.
An owned native SDK component host with real Herdr viewers kept native widgets
hidden during task-file updates. Identity-guarded suspension caused genuine
heartbeat expiry and native restoration; resuming the same viewer hid them again.
One independent reviewer approved the frozen candidate by inspecting code and
evidence, without rerunning the tests.

Production installation retained the prior generation. All 30 installed `.mjs`
files matched the approved build, and a fresh Node process imported the installed
entry successfully. Already-running conversations were not restarted; module
import is not proof that their in-memory controllers have changed.

Limits: manual close followed by dashboard recreation failed in a separate
experiment, with attribution unproven. Default cold-start timing and the full
OmO application remain unverified. SDK graceful shutdown exceeded its cap; owned
servers were explicitly stopped instead. The large placement matrix did not
finish and is not counted as a pass. These results do not establish the sole
cause of the original production report or universal lifecycle recovery.

## Band layout source candidate

New managed dashboards use the band layout. Todo spans the top of the dashboard
area; ordinary workers (left) and DAG (right) share the row below it. A columns
dashboard stays columns through upgrades, restarts and `/reload`, and changes to
the band only when the owner runs `/dashboard`. Automatic paths leave the
conversation's geometry and input focus unchanged. Explicit migration keeps its
geometry, may briefly select a dashboard pane during swaps, and ends with focus
on the conversation. Unmanaged mode keeps its current layout.

Measured suite counts and native Herdr results for this candidate are recorded
by plan todo 13. Older counts below are historical and don't describe it.

Known limitation, NOT VERIFIED: after a dashboard claims the band, rolling back
to install generation 7 makes generation 7 treat the `band` claim as the legacy
stacked layout. After a rollback, start a new conversation.

## 2026-10-09 mouse-first source candidate

The source candidate has a quieter layout, no keyboard legend, and independent
mouse inspection in Todo, workers and DAG. Click, vertical drag and wheel pause
the inspected view. Losing pane/tab/workspace focus restores automatic tracking;
reopening starts in automatic mode while retaining fold and selection preferences.
Todo styling follows the supplied Senpi reference.

Actual Windows ConPTY viewers passed 18 click/drag/wheel/blur/resize captures
across the three roles. Normal and 34-column frames were inspected as xterm
screenshots. Actual Herdr pane moves restored tracking in both DAG and Todo.
Herdr 0.9.3 did not forward those moves as terminal focus reports, so the candidate
also subscribes to the public focus event stream. It does not poll or modify Herdr.
All owned viewers, streams and fixtures were closed after the checks.

Suite counts for that candidate are superseded; see plan todo 13 for the
measured counts. JavaScript syntax checks, unified build, offline installation and
imports of both packaged viewers passed. The archive contains 40 files and 26
runtime modules. The package check now imports each viewer because hash parity
alone missed a required input module omitted by the Todo build list.

LSP diagnostics were unavailable because `typescript-language-server` is not
installed. These results verify the source candidate, not an update of the
owner's existing installation or already-running panes.

## 2026-10-04 installed baseline

Verified on Windows on 2026-10-04 with Node 24.12.0, Herdr 0.9.3, OmO 5.1.16 and stock Senpi 2026.10.7. The unified runtime supersedes earlier split-extension acceptance; earlier file hashes are historical evidence only.

## Source provenance

- Todo history imported without squashing from `2aa1820cfcc1ffb4dd2161bccc4af4e663a21e66` into `packages/todo`.
- DAG history imported without squashing from `282ed765a5037bda318a3285b150f780a7417090` into `packages/dag`.
- Original MIT licenses and attribution are retained. The SDK is imported read-only and is not redistributed.

## Tests and package checks

The per-suite counts from this baseline are stale and were removed. Plan todo 13 records the measured counts for the current source.

Two regressions were reproduced before their fixes: a readable native Todo branch with no Todo entry could fail startup, and Herdr's same-tab `move` returned success without changing geometry. Tests preserve the expected behavior. The current layout uses actual supported splits and swaps and validates role geometry after placement.

## Observed installed surface

The actual installed generation contained only `omo-herdr-dashboard.js` as its Herdr extension entry. All 24 installed component runtime hashes matched the tested build. Managed legacy entries were backed up; unrelated extensions, original engine files and game files were not changed.

The geometry below is the earlier columns layout, kept as history. Actual Herdr pane geometry was verified at 172 columns by 46 rows: conversation 69 columns, Todo 52 by 23 at the upper left of the dashboard, ordinary workers 52 by 23 below it, and DAG 51 by 46 on the right. The 52-column Todo footer included the complete compact control hint without clipping `q`.

Native `/todo append`, `start` and `done` commands were exercised through the actual parent session. Todo follow was turned off while the DAG and worker views remained on. Closing Todo with `q` and running `/dashboard` rebuilt the verified owned roles, retained Todo follow-off and native target data, and preserved the conversation input target. Completed Todo phases folded by default. Fresh waiting state and active/completed states were observed.

Private evidence contains actual visible Herdr ANSI frames, role geometry, ownership records and hashes. Replayed PNGs were inspected directly; they are terminal snapshots, not desktop screenshots. No private session records or machine paths are included in this repository. A final attempted Todo clear was not confirmed before the owned panes disappeared; it is not counted as a passing clear scenario. No replacement session was launched over that later state.

## Reproduce the current manual checks

1. Build and install the root package in an explicit disposable agent directory. Start a fresh OmO session in a separately owned Herdr tab. Confirm a single dashboard entry is loaded.
2. Issue `/dashboard` from the conversation. Use `herdr pane layout --pane <parent>` to verify exactly four panes in the band order (Todo across the top, workers lower left, DAG lower right); inspect visible ANSI for each role.
3. Add and start a native Todo. Toggle `f` only in Todo and verify the other follow states are unchanged. Close Todo with `q`, issue `/dashboard` from the conversation, then verify data and view preferences persist even if pane IDs changed.
4. Complete the Todo and inspect default phase folding and the compact footer. Check ordinary-worker and DAG source updates using the existing producer records or an isolated fixture; distinguish waiting/error/disconnected labels from live data.
5. Clean only resources whose creation receipts, pane/process identity, cwd and launch arguments establish ownership. Preserve unrelated tabs and installation generations.

Herdr swaps can briefly change selection; the controller applies observed ownership and focus guards. This verifies final Herdr input selection, not OS foreground or physical keyboard routing. Historical `packages/todo/scripts/qa-live.mjs` covers the retired three-row candidate and must not be treated as the band layout's acceptance script.
