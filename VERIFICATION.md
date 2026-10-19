# Current dashboard verification

## 2026-10-20 header and footer inset (generation 33)

The source change is commit a11a295 on `work/title-indent`. The Todo, worker, DAG and
collaboration panes drew their `name [done/total]` header and their `Follow ON · LIVE` footer flush
against the left edge; both rows now sit one column in (a one-column pane keeps no inset), so they
line up with the cards below. Dividers, section bars and body rows are unchanged. Origin: owner
request to indent the top and bottom title rows slightly, and decision #278=A (commit, install
generation 33, push).

Tests: DAG 223/44 (the same 44 as before), root 750/12 with one band footer pin left, which was
updated and its file re-run with no failure outside the baseline (so root is back to the same 11),
Todo 156/21 (the same 21), collaboration 14/0. Six assertions that pinned the rows at column 0 now
expect the inset. The fresh worktree needed `npm ci` in `packages/dag` for the `node-pty` PTY tests
and `npm run build` for the installer test. The build and `scripts/verify-package.mjs` exited 0. The
install exited 0 with generation-000032 as backup; generations 31 and 32 kept their bytes,
settings.json and models.json kept their hashes, the 41 runtime files equal the dist, generation
33's `extension.mjs` imported in a fresh Node process, and the installed renderers draw the same
frames as the dist and the source. An owned `--no-focus` Herdr tab ran the installed collaboration
viewer with `--once` at 26x16 and showed ` Collab [2/3]  wait 1` and ` Follow ON · LIVE`; the tab was
closed.

Rollback: copy `install-rollback-33/omo-herdr-dashboard.js` and `install-rollback-33/current.json`
from `기타 작업/.omo/evidence/dag-stage-list/` over the wrapper and
`herdr-dashboard/integration/current.json`; that points at generation 000032 again. Generation 33
applies from a new conversation or a deliberate `/reload`.

Korean summary: 네 판의 맨 위 제목 줄과 맨 아래 바닥줄을 한 칸 들여썼습니다. 세대 33을 설치했고 31·32는 그대로입니다.

## 2026-10-20 empty worker and DAG panes, English pane text (generation 32)

The source change is commit 1a570ad on `work/dag-stage-list`. An empty worker pane used to fall
through to the DAG empty state and showed `DAG 대기 중`; it now shows `○  No workers yet`, and an
empty DAG pane shows `○  Waiting for a DAG`. The empty DAG pane was drawn by a separate branch of
`renderFixedFrame` that left the footer uncoloured; `renderFixedFrame` now always calls
`renderFrame` (a fixed DAG role with no run keeps `DAG [0/0]  None`), so the footer is cyan when
live and yellow when offline, as in the other panes. Every remaining Korean value in the ko
catalogs of the DAG, Todo and collaboration panes now carries the English text (DAG 78 keys, Todo
23, collaboration 1). Origin: owner request on the empty panes and decision #271=B (translate the
remaining Korean too, then commit and install).

Tests: DAG 222 pass / 45 fail before the runtime test update, then the runtime file 5/0; the 44
baseline failures are unchanged and the two empty-DAG read-error pins moved from the old
standalone frame (`slice(-2)`) to the shared footer position (`slice(-4)`). A new test pins the
empty role wording, the absence of Korean chrome and the coloured header and footer. Root 751/11,
Todo 156/21 (unit 33/0 plus 123/21, the same 21 as before), collaboration 14/0. The build and
`scripts/verify-package.mjs` exited 0. The install exited 0 with generation-000031 as backup;
generations 30 and 31 kept their bytes, settings.json and models.json kept their hashes, the 41
runtime files equal the candidate dist, generation 32's `extension.mjs` imported in a fresh Node
process, and the installed renderer draws the same empty frames as the dist. An owned `--no-focus`
Herdr tab ran the installed viewer with `--once` for an empty worker state and an offline empty
DAG state and showed the English wording; the tab was closed.

Rollback: copy `install-rollback-32/omo-herdr-dashboard.js` and `install-rollback-32/current.json`
from `기타 작업/.omo/evidence/dag-stage-list/` over the wrapper and
`herdr-dashboard/integration/current.json`; that points at generation 000031 again. Generation 32
applies from a new conversation or a deliberate `/reload`.

Korean summary: 빈 작업자판은 'No workers yet', 빈 DAG판은 'Waiting for a DAG'를 띄우고 바닥줄 색을 다른 판과 맞추었습니다. 세 판의 남은 한국어 문구를 영어로 바꿨고 세대 32를 설치했습니다.

## 2026-10-20 collaboration pane in the shared grammar (generation 31)

The source change is commit 6e74414 on `work/dag-stage-list` (`packages/coordination/src/render.mjs`,
`i18n.mjs` and the pane tests). The header is `Collab [done/total]` with a `×n · wait n` summary,
the flow is a `─ Flow n ───` section of cards (an ask carries its reply on a `↳` row; a waiting
ask has the running bar, spinner and elapsed time), the advisor is a `─ Advisor ● on HH:MM ───`
section with one counts row, and the footer is `Follow ON · LIVE` or the link state; while scrolled
it names the cards shown. The connection and baseline rows are gone, one-cell marks replace the
emoji, and the header warns only when a card failed. Origin: owner decision #267=A (mockup A) and
#269=A (commit, then install generation 31).

Tests: coordination 14/0 and root 751/11 (the same 11 as before, no new failure). The build and
`scripts/verify-package.mjs` exited 0, and the built renderer draws the mockup A frames byte for
byte. The dry run reported generation-000031 with generation-000030 as backup and no legacy
wrappers; the install exited 0 with `installed: true`. Generations 29 and 30 kept their bytes, the
settings.json and models.json hashes did not change, all 41 runtime files equal the candidate
dist, each locale.json is `{"language":"ko"}`, and a fresh Node process imported generation 31's
`extension.mjs`. An owned `--no-focus` Herdr tab ran the installed collaboration viewer with
`--once` at 26x28 on a fixture and showed the new header, flow cards, advisor section and footer;
the tab was closed.

Rollback: copy `install-rollback-31/omo-herdr-dashboard.js` and `install-rollback-31/current.json`
from the evidence folder `기타 작업/.omo/evidence/dag-stage-list/` back over the wrapper and
`herdr-dashboard/integration/current.json`; that points at generation 000030 again. Generation 31
applies from a new conversation or a deliberate `/reload`.

Limits: the live check used a fixture, not a real coordination session. The empty worker and DAG
screens still carry Korean DAG wording (`DAG 대기 중`), left for a later round.

Korean summary: 협업판을 다른 판과 같은 머리줄·구획·카드·바닥줄 규칙으로 바꿨습니다. 세대 31을 설치했고 29·30은 그대로 보존했습니다.

## 2026-10-20 stage list, shared three-row cards and English labels (generation 30)

The source change is commit d9b131d on `work/dag-stage-list`. The DAG pane now lists each stage
under its `Step N` header (`├`/`└` marks) instead of one lane per parallel node, which pushed a
23-node fan-in 45 cells to the right. Worker and DAG cards share `compactTaskLines`: the title
with its elapsed time, role and model (they split onto two whole rows when both do not fit on one
row), then tok/s with the turn and tool counts. The cost and the estimated badge stay in the d
detail view. When the title would keep fewer than 10 cells beside the time, the time moves to the
front of the speed row. Folded marks are ▸/▾. The Korean locale uses Workers, run/done,
done/drop/closed, Step N, h/m/s, turns/tools and Follow ON/OFF · LIVE, and the collaboration
pane footer matches.

Origin: owner decisions #254=A (always list stages), #259 (card rows, wrapping role and model,
English turns and tools) and #262=C (time and step labels in English too, then commit and install).

Tests against a clean 3172946 worktree baseline: dag 222 pass/44 fail (the same 44), root 751/11
(no new failure), todo 156/21 (only the dist-dependent command contract differs), coordination
14/0. New tests cover the stage list and the shared three-row cards with the role and model split.
The build and `scripts/verify-package.mjs` exited 0.

The dry run reported generation-000030 with generation-000029 as backup and no legacy wrappers.
The install exited 0 with `installed: true`. Generations 28 and 29 kept their bytes, and the
settings.json and models.json hashes did not change. All 41 installed runtime files equal the
candidate dist, each locale.json is `{"language":"ko"}`, and a fresh Node process imported
generation 30's `extension.mjs`. Frames rendered with the installed renderer (workers and DAG at
28 and 34 columns, Todo at 85) equal the candidate frames byte for byte.

Rollback: copy `install-rollback/omo-herdr-dashboard.js` and `install-rollback/current.json` from
the evidence folder `기타 작업/.omo/evidence/dag-stage-list/` back over the wrapper and
`herdr-dashboard/integration/current.json`; that points at generation 000029 again. Existing
conversations keep their loaded generation; generation 30 applies from a new conversation or a
deliberate `/reload`.

Limits: the baseline failures above remain. The installed generation was checked through its
render functions and the import, not yet in a live pane. `laneLines` and `nodeDetail` are no
longer on the render path and are left for a later cleanup.

Korean summary: DAG판을 단계 목록으로 바꾸고, 작업자판과 DAG판 카드를 같은 3줄로 맞추고, 고정 문구를 영어로 바꿨습니다. 세대 30을 설치했고 28·29는 그대로 보존했습니다.

## 2026-10-20 Todo continuation inset (generation 29)

One Todo renderer change shipped. When a task line wraps, the separator space at
the wrap boundary is consumed with the completed line instead of starting the
next line, so every continuation begins at the four-cell task text inset. Task
content, status marks, selection weight and all other wrapping rules are
unchanged. The source change is commit 6432bc0 (`packages/todo/src/render.mjs`
`wrap`, plus the regression test in `packages/todo/test/render.test.mjs`).

Origin: the final fidelity review (F4) found the T4 fixture continuation at width
28 starting at cell 5 (`F4-IS1-CONTINUATION`); plan row 15 authorized this single
wrap-edge correction. An independent gate reviewer passed row 15: the focused
test went from the recorded red (`5 !== 4`) to green, and all 14 continuations
across the six Todo frames at widths 28/40/80 start at cell 4.

The comparator against the d399730 baseline reports 0 new failures, 0 removed
tests, 0 new timeouts and no flaky keys. Buckets: root 749 pass/11 fail, dag
220/44, todo unit 33/0, todo 123/21, coordination 14/0; the 55-file inventory has
two not-covered host tests. The pre-existing 11 root, 44 dag and 21 todo failures
remain disclosed and are not new. The candidate manifest has 42 pairs equal
(dist and sources), and only `dist/todo/src/render.mjs` differs from the
generation-28 candidate. Of 22 captured frames, 20 are byte-identical; only
`todo-28-color` and `todo-28-plain` changed, each on one continuation line, by
exactly one leading space.

Owner decision #241=A (2026-10-19T17:21:54.648Z, "설치(새 대화창부터, 세대 28은
보존)") approved installation. The dry run reported generation-000029 with
generation-000028 as backup and no legacy wrappers; the install exited 0 with
`installed: true`. The post-install preservation compare found 0 drift: the 804
CUTOVER paths and every pre-existing generation kept their bytes (generations 25,
26, 27 and 28 each 46 files); only the wrapper, current.json and the new
generation-000029 folder changed. settings.json and models.json hashes were
unchanged during the install (settings.json's mtime was already 17:17:59Z when
the pre snapshot was taken). All 41 installed runtime files match
`E/task-15/candidate-manifest.json`, each locale.json is `{"language":"ko"}`,
and a fresh Node process imported generation 000029's `extension.mjs` with exit
0. The altered-hash QA on a copy of the pre snapshot reported exactly 1 drift and
exit 1 without touching the real files. The installed viewer rendered the T4 Todo
fixture at width 28 with all four continuation rows starting at cell 4, the
installed worker list still shows `▌[deep-low] …`, and generation 29's
coordination files are byte-equal to generation 28's. An owned `--no-focus` tab
ran the installed Todo viewer at 170 columns, showed the fixture and footer with
no `>` column, `--once` exited 0, and the tab was closed; the owner's two tabs
were unchanged before and after.

Rollback: copy `E/task-15-install/rollback/omo-herdr-dashboard.js` back to
`C:/Users/USER/.omo-stable-500/home/.omo/agent/extensions/omo-herdr-dashboard.js`
and `E/task-15-install/rollback/current.json` back to
`C:/Users/USER/.omo-stable-500/home/.omo/agent/herdr-dashboard/integration/current.json`
byte-for-byte; that points at generation 000028 again. Do not rerun the installer
to roll back, because it would create generation 000030. Existing conversations
keep their loaded generation; this generation applies from a new conversation or
a deliberate `/reload`.

Limits: the 11 root, 44 dag and 21 todo baseline failures remain and are not
fixed here. The width-28 continuation proof used the installed viewer in a
non-TTY stream (plain, no colour); the real pane was 170 columns, where the T4
line does not wrap, so continuation placement was not observable there. The
installed generation was exercised only in the Todo view; worker and DAG views
rest on the candidate captures and the worker-shape stdout check. Coordination
behaviour is unchanged from generation 28.

Korean summary: Todo 작업 줄이 줄바꿈될 때 이어지는 줄이 모두 4칸 들여쓰기에서 시작합니다. 세대 29를 설치했고 25·26·27·28은 그대로 보존했습니다. 기존 테스트 실패는 위에 적은 그대로입니다.

## 2026-10-19 marker-free rows and four-row worker cards (generation 28)

Four changes shipped together. The reserved `>` marker column is gone from worker
cards, DAG node titles and Todo task rows, and selection is shown only by a bold
title (status colours are unchanged); every worker and DAG bar-card body row also
starts directly after the `▌` bar (owner reply #230). Healthy worker cards are four
rows and keep a message/activity row only while stalled, retrying or paused. Both
`width()` copies count text-presentation pictographs (▶ ⚙ ⚠) as one cell. Both
process-query copies reject a non-positive/non-integer PID without launching
PowerShell, re-query one empty stdout once, and fail closed if it stays empty.

Provenance: conversation 01a154b7 installed generation 000027 at 2026-10-20
00:31:53 KST under owner decision #231 A ("세션별로 고침 (대시보드 새 세대)").
Generation 27 is generation 26 plus the coordination per-session flow fix (commit
b5a2d7e on work/coord-session-flow). Owner decision #235 A ("합친 뒤 설치") ordered
that fix merged before this install; plan row 14 cherry-picked it as 46f2d1a, and its
coordination runtime files equal generation 27's when line endings are ignored.
Generation 28 therefore contains plan rows 1-14 (including row 13, 64c6c22, from
owner reply #230). It was installed under owner decision #239 A, with generation
000027 as the backup and rollback target.

The comparator against the d399730 baseline reports 0 new failures, 0 removed
tests, 0 new timeouts and no flaky keys (the two baseline runs were identical).
After this generation the buckets are root 749 pass/11 fail, dag 220/44, todo unit
33/0, todo 122/21 and coordination 14/0; the 55-file inventory has two not-covered
host tests (`host/display-bridge-host.test.mjs`, `host/native-host.test.mjs`). The
pre-existing 11 root, 44 dag and 21 todo failures remain disclosed; they include
stale frame expectations and are not new. The change added 18 passing test statuses.

Real-pane scope: the candidate was captured before/after in an owned Herdr pane for
workers, DAG and Todo at 171x46 (the owner's tabs were never touched). The installed
generation 28 worker list was then run in a separate owned `--no-focus` tab and read
in a 170-column frame: no `>` column, exactly four rows for the healthy card
(`▌⠋ …`, `▌[deep-low] …`, `▌$…`, `▌⧖ …`), and the stall/retry warning rows were
still present; `q` exited 0 and the tab was closed. The installed generation was not
re-checked in a Todo or DAG pane; those live views rest on the candidate captures.

Owner decision #239=A (2026-10-19T16:23:01.540Z) approved installation. The installer
created generation 000028 with generation 000027 as its backup and no legacy
wrappers. The post-install preservation compare found 0 drift: the 804 CUTOVER paths
and every pre-existing generation (including 25, 26 and 27, 46 files each) kept
their bytes; only the wrapper, current.json and the new generation-000028 folder
changed. settings.json and models.json were unchanged. All 41 installed runtime
files match E/task-14/candidate-manifest.json, each locale.json is
`{"language":"ko"}`, and a fresh Node process imported generation 000028's
`extension.mjs` with exit 0. The altered-hash QA on a copy of the pre snapshot
reported exactly 1 drift and exit 1 without touching the real files.

Rollback: copy `E/task-10/rollback/omo-herdr-dashboard.js` back to
`C:/Users/USER/.omo-stable-500/home/.omo/agent/extensions/omo-herdr-dashboard.js`
and `E/task-10/rollback/current.json` back to
`C:/Users/USER/.omo-stable-500/home/.omo/agent/herdr-dashboard/integration/current.json`
byte-for-byte; that points at generation 000027 again. Do not rerun the installer to
roll back, because it would create generation 000029. Existing conversations keep
their loaded generation; this generation applies from a new conversation or a
deliberate `/reload`.

Limits: a colourless terminal has no selection distinction. The cause of an empty
process query is still unknown; two consecutive empty outputs or a missing PID can
still print a short warning. The same warning text can also come from the briefing
extension (`herdr-tab.mjs:17`), which this change does not touch. The width fix was
the measured `apply` result. Todo live capture exists only for the candidate, not
for the installed generation 28. The event-loop freeze investigation remains out of
scope.

Korean summary: 표시 칸이 사라지고 선택은 굵기로만 보이며, 정상 작업자 카드는 4줄입니다. 새 세대 28을 설치했고 25·26·27은 그대로 보존했습니다. 기존 테스트 실패는 위에 적은 그대로입니다.

## 2026-10-17 compact child-card alignment

Compact worker and DAG child cards retain the localized counted group heading and
arrow, remove the repeated child label and align child metadata with root cards.
The previous role/model wrapping budget is preserved, including narrow panes.

The focused renderer sweep covers three languages, seven widths from 24 to 120
columns, both views and two child depths. The updated and new regression checks
passed. The renderer/model/fixed-view run changed from 51 passing and 32 failing
tests before the edit to 52 passing and the same 32 failures afterward. Those
existing failures include stale frame expectations and two fixed-view PTY tests;
this is not a clean full-suite result.

The unified build and offline package check passed (41 archive files, 27 runtime
modules). An actual owned Herdr pane ran the candidate with a pinned Node process:
initial layout, tracking off/on, collapse/expand, disconnect/reconnect and normal
quit passed. Raw visible ANSI and process identity were retained privately. This
exercise used isolated worker data, not the owner's live task state.

One independent read-only gate reviewer approved installation after checking the
source delta, candidate hashes and eight visible frames. Test commands were run
by the implementer, not repeated by that reviewer.

Managed installation created generation 17 and retained generation 16 unchanged.
All 39 prior files were checked: only the approved renderer differed in the new
generation. A fresh actual Herdr viewer launched from installed generation 17
passed the same eight transitions and exited normally; its exact Node process
identity and source hash were recorded. The owned test tab was separate from
the owner's conversation. Existing conversations were not force-reloaded.

Installation and activation are separate: a newly installed generation is used
by a fresh conversation or deliberate `/reload`. Existing in-memory controllers
and their viewer processes do not switch merely because the installer succeeds.

Korean summary: child arrows and group counts remain; repeated labels and extra
indentation are removed. Existing test failures remain disclosed above.

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
