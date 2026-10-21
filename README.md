# OmO Herdr Dashboard

One extension, one command, one repository for native Todo, ordinary workers, workflow DAGs and the collaboration pane.

Inside OmO running in Herdr, enter `/dashboard`. It opens all four views and explicitly reopens closed views. The dashboard uses a band layout: Todo is a wide band across the top of the dashboard area, and below it the collaboration pane sits on the left, ordinary workers in the middle and DAG on the right. A new managed dashboard gives the conversation the left half of the terminal and the dashboard the right half.

Verified faults repair automatically. A view closed explicitly by its owner, or closed without an authoritative absence proof, stays closed across automatic updates and reloads until a fresh `/dashboard` command. That suppression is policy A: lifecycle events do not clear a recorded close, while a newer explicit command can restore the view. A role that is already bound correctly is not split, resized or relaunched merely because its width changed.

Existing conversations keep their current columns layout after an upgrade, restart or `/reload`. Automatic paths leave the conversation's geometry and input focus unchanged. Running `/dashboard` changes a columns dashboard to the band in place without resizing the conversation. Swaps may briefly select a dashboard pane; the migration ends with focus on the conversation. Unmanaged mode keeps its current layout.

Each view follows current work automatically. Click to inspect a card, drag vertically or use the mouse wheel to browse without moving the other views. Leaving the view restores automatic tracking; reopening also starts in automatic mode. The footer shows tracking and connection status instead of a keyboard legend. Closed Todo groups can be expanded by clicking their summary. Terminals must support SGR mouse and focus reporting. Existing keyboard controls remain available without occupying the screen.

Workers shows every eligible root once. Active work stays above a chronological history section, oldest to newest; completed, cancelled, failed and paused roots remain present instead of disappearing from the list. Expanding a card or opening full details changes how much you read, never which roots exist. Scroll and keyboard navigation reach every historical root, and a manual scroll position or selected task survives status updates. Todo phase headings keep their original ordinal (for example `II. Build 3/5`) even when an earlier phase is hidden or folded.

`/dashboard` returns a bounded composite result after at most five seconds. It reports core readiness and Collab readiness separately, and claims four-pane completion only when the core is READY and the same scoped binding has a live Collab viewer with first-paint proof. A timeout returns pending/waiting, never success; a disabled environment, a too-narrow band, a late paint or a failed recovery stays partial. A later valid paint updates the current state without sending a second terminal command response.

Compact child cards keep their counted group heading and arrow, without repeating the child label or adding depth-based indentation. Role/model wrapping, metrics and folding remain available.

Build with Node 24 or newer: `npm run build`. Install the built package with `node bin/omo-herdr-dashboard.mjs install --agent-dir <your-agent-directory> --lang ko`. Use `--dry-run` first to inspect the exact paths. The installer registers only `omo-herdr-dashboard.js`, retains prior generations, backs up managed legacy Todo/DAG entries, and preserves their runtime state directories. Restart or `/reload` the parent OmO session after installation. Foreign extension entries are never replaced.

Source is maintained together under `packages/todo` and `packages/dag`. Their original Git history and MIT notices are retained. The unified entry and installer live at the repository root. No global OmO engine, game file or unrelated extension is modified. All current changes are maintained as commits in this repository's `main` branch. Component packages are private; upstream upload and npm publication are disabled.

If a role is closed or the geometry is invalid, issue `/dashboard` from the conversation pane. The command may rebuild the owned role panes to restore the band. A recorded close is respected until that explicit command; unverified absence is reported as a wait rather than treated as permission to take over. Role pane IDs can change; native Todo data and independent view preferences persist. Merely receiving an update does not reopen a manually closed view.

See [current verification](VERIFICATION.md) for the observed behavior, test scope and limitations. Component READMEs and historical QA scripts describe their original standalone installations; use this root entry and installer for the unified dashboard.
