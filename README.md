# OmO Herdr Dashboard

One extension, one command, one repository for native Todo, ordinary workers and workflow DAGs.

Inside OmO running in Herdr, enter `/dashboard`. It opens all three views and explicitly reopens closed views. Todo and ordinary workers occupy the upper and lower halves of the left dashboard column. DAG occupies the full right dashboard column. The conversation keeps the left 40% of the terminal; the dashboard uses the remaining 60%.

Each view follows current work automatically. Click to inspect a card, drag vertically or use the mouse wheel to browse without moving the other views. Leaving the view restores automatic tracking; reopening also starts in automatic mode. The footer shows tracking and connection status instead of a keyboard legend. Closed Todo groups can be expanded by clicking their summary. Terminals must support SGR mouse and focus reporting. Existing keyboard controls remain available without occupying the screen.

Build with Node 24 or newer: `npm run build`. Install the built package with `node bin/omo-herdr-dashboard.mjs install --agent-dir <your-agent-directory> --lang ko`. Use `--dry-run` first to inspect the exact paths. The installer registers only `omo-herdr-dashboard.js`, retains prior generations, backs up managed legacy Todo/DAG entries, and preserves their runtime state directories. Restart or `/reload` the parent OmO session after installation. Foreign extension entries are never replaced.

Source is maintained together under `packages/todo` and `packages/dag`. Their original Git history and MIT notices are retained. The unified entry and installer live at the repository root. No global OmO engine, game file or unrelated extension is modified. All current changes are maintained as commits in this repository's `main` branch. Component packages are private; upstream upload and npm publication are disabled.

If a role is closed or the geometry is invalid, issue `/dashboard` from the conversation pane. The command may rebuild the owned role panes to restore the two columns. Role pane IDs can change; native Todo data and independent view preferences persist. Merely receiving an update does not reopen a manually closed view.

See [current verification](VERIFICATION.md) for the observed behavior, test scope and limitations. Component READMEs and historical QA scripts describe their original standalone installations; use this root entry and installer for the unified dashboard.
