# Reviewed concurrent dashboard plan — sanitized public record

This is a sanitized derivative of the approved implementation plan, updated for local continuation on 2026-10-04. Source-plan SHA256 at this derivative's creation: `0a5edf2f01a9f8d6d06553a8cd8dc800800c78cb683edcd92c72bede6820c1bf`. It preserves the scope, contracts, task history and acceptance boundaries; machine paths, private sessions, task identities, raw logs and captured screenshots are excluded. It is not a claim of remote publication or final independent approval.

## Goal and authority

Show workflow DAG, ordinary workers and Todo simultaneously in fixed Herdr panes. Stock native Todo on the selected branch remains the sole checklist authority. Every role has independent automatic follow and manual exploration. Readiness can hide only the matching original inline surface, and failure restores that actual native surface.

Todo is a separate source repository. DAG changes use the concurrent companion branch; existing unrelated branches and checkouts stay outside this work. Source tests/build commands run in the source checkout. Runtime archives include the installer and compiled runtime, not development tests or the SDK.

## Contracts

- Initial right column: DAG above workers above Todo, 40/30/30 by height. Reopening a role preserves surviving owned identities, conversation geometry and global focus.
- `f` toggles only the operated role's follow. Manual browsing pauses only that role. `c` controls completed groups; fixed roles ignore `t`. `q` closes one role durably until an explicit command reopens it.
- Completed groups keep canonical membership. Active/error descendants, blocked/paused/lost work and manual expansion remain accessible.
- IPC binds owner, selected session, epoch, role, sequence and launch token. Actual painted ACK and verified process membership precede a mask. Stale scope, disconnect, lease expiry or unreadable source cannot authorize live coverage.
- Cache and manual preferences remain separate. Same-scope error recovery retains the existing target; terminal completion/removal hands off. Valid empty state and disconnected last-known data remain distinct.
- Cost is reported/estimated/unknown, never invented billing. Reported zero is meaningful. Generation-time speed differs from wall time.
- No primary harness activation, original SDK changes, games, push, PR, release or npm publication are part of local verification.

## Implementation and repair history

| Task | Intended work | Local boundary |
| --- | --- | --- |
| 1 | Prove native observation/display seams in an isolated host | Verified |
| 2 | Establish isolated source workspaces and commands | Verified |
| 3 | Authoritative Todo projection and branch/lifecycle rebasing | Verified |
| 4 | Reversible masks and truthful startup recovery | Verified |
| 5 | Role-owned IPC and snapshots | Verified |
| 6 | Fixed concurrent composition | Verified |
| 7 | Read-only Todo renderer and availability | Verified |
| 8 | Independent follow/manual exploration | Verified, including same-scope error recovery |
| 9 | Truthful reported metrics | Verified |
| 10 | Compact completed groups without hiding active/error work | Verified |
| 11 | Isolated packages/installers | Technical proof verified; overall boundary pending incident decision |
| 12 | Combined actual native/Herdr QA and docs | Locally accepted |
| 13 | Sanitized source/plan history | Local preflight; external upload remains pending approval |
| 14 | Child-session exclusion | Verified |
| 15 | Foundation documentation/public examples | Verified |
| 16 | Initial source foundation record | Verified |
| 17 | Evidenced installed-SDK compatibility rebind | Verified |
| 18 | Current SDK identity compatibility rebind | Verified |
| 19 | Completed-summary status color | Verified in actual captured ANSI/PNG |
| 20 | Installer rollback after wrapper replacement failure | Verified |
| 21 | Test isolation incident prevention/disclosure | Corrected test isolation; user decision still pending |
| 22 | Preserve readable composition after viewer reopen | Verified actual reopen geometry and regressions |
| 23 | Fit active worker card in initial product viewport | Verified wide viewport; narrow path preserved |

## Local verification and final gate

Use actual stock builtin-first ResourceLoader/ExtensionRunner, registered native tools/commands and original InteractiveMode factories. The host is a bounded component facade, not a full parent chat TUI. DAG/worker fixture data exercises consumers; only native callbacks produce Todo. No paid-model request is needed.

Combined QA tests both registration orders, real painted ACKs, independent controls, native mutations, manual closure/reopen, reload/epoch rebase, valid empty state and current active restoration. Real Herdr process/layout/visible-ANSI receipts bind source and installed package bytes. Private terminal replay PNGs preserve those actual ANSI pixels; they are not desktop screenshots. Existing receipts apply only where current source bytes or the identified unchanged behavior remain equivalent.

At the observed 60/80-column worker viewport the complete active card and controls are visible. At 40/24 columns with twelve worker rows, some card/metric lines require scrolling; target/live/f/c/d/q remain identifiable. Dedicated smaller-height/tiny fallback proof is qualified separately.

The current full DAG suite retains three pre-existing Windows POSIX-helper failures; affected current tests, builds and package checks pass. The SDK and declared static installation anchors are read-only comparisons, not proof that the entire prior continuation made no global writes.

One final independent read-only review covers plan compliance, code quality, actual UI and evidence integrity. It follows parent direct current UI inspection. Confirmed findings receive scoped repair and affected verification; a second independent review is excluded. Remote-head proof is excluded until upload approval. The earlier ambient installer incident must be resolved or explicitly accepted by the user before overall boundary acceptance.

## Proposed external record

Targets: [Todo repository](https://github.com/grim-susemi/omo-herdr-todo), branch `feat/concurrent-dashboard`; [DAG repository](https://github.com/grim-susemi/omo-herdr-dag), branch `feat/concurrent-views-and-metrics`. The local preflight prints exact heads, lineage, relative allowlisted files and hashes. No external writes have been authorized by this record. Existing unrelated DAG branches remain outside the proposal.

## Final review continuation

Task 24 resolves the one independent review's foreground focus acceptance gap.
Selected-tab preflight defers inactive placement; owned-neighbor restoration
restores the verified final observed input target unless a later observed manual
selection wins. Separate observation and RPC calls are not atomic, and transient
swap selection remains possible.
Only affected reopen/native restoration cases require new packed-runtime proof;
unchanged rendering and native mechanisms retain qualified historical evidence.
Parent directly accepted the new selected-tab process/geometry/input-target
proof and three readable captures. The public affected command retained exit 1
for its inspection timeout despite both functional cases passing; the separate
inspect-only run exited 0. Final metadata/preflight records bind this scope
without claiming a new full-matrix pass. The external upload and prior
primary-agent incident decision remain pending.
