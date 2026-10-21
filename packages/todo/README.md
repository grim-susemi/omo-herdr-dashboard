# omo-herdr-todo

Native Todo, workflow DAG, ordinary workers and the collaboration pane remain visible together in four fixed Herdr views. Todo reads the selected stock Senpi branch; the dashboard never creates a second checklist store.

## Everyday controls

The unified `omo-herdr-dashboard` extension loads both runtime components and the collaboration entry in an eligible parent session. Todo sits above the lower row; the collaboration pane is on the left, ordinary workers in the middle and DAG on the right. The conversation keeps 40% of the terminal width. Child sessions cannot own the layout.

Todo phase divider titles keep their original uppercase Roman ordinal and the existing closed/total counter, for example `I. Plan 1/2`, even when an earlier phase is hidden, folded or scrolled past. The prefix is presentation only and never renumbers stored phases.

Each role starts with automatic follow. Press `f` in one pane to toggle its follow. Scrolling/selecting manually pauses only that pane; `f` resumes it. `c` controls completed work for that role. Completed ordinary workers and closed Todo phases fold automatically; active/error descendants and manual expansions remain accessible. DAG topology stays canonical. Fixed DAG/workers panes ignore `t`.

Press `q` to close one role. Source updates respect that closure; a verified fault may repair in place, but a recorded owner or unknown-absence close stays closed until a fresh explicit command. `/dashboard`, issued from the conversation pane, is the single command to open or explicitly reopen all four roles and returns a bounded composite result: core and Collab status are separate, and four-pane completion requires both in the same binding. A timeout is waiting, not success. Restoring the layout can recreate owned role panes; native data and independent view preferences remain intact. Losing current ready coverage restores the actual native inline widget factory. Use the [root README](../../README.md) for the unified installer and [current verification](../../VERIFICATION.md) for current QA.

Read errors, valid empty state and disconnected last-known state have distinct labels. A disconnected cache is not live progress. Cost is producer-reported or unknown; zero is shown only when reported. Speed uses generation time, not wall time. These figures are not an invoice.

## Local verification

Node24 or later and an already running Herdr session are required. SDK version and file hashes must match `config/native-source-manifest.json`; there is no ambient SDK fallback or provider/model request.

Run verification and build commands from the source checkout. The extracted runtime archive omits development scripts/tests and installs through `node bin/omo-herdr-todo.mjs install --agent-dir <disposable-agent-directory>`.

```bash
npm test
npm run build
npm run test:package
npm run test:host -- --senpi-root <installed-senpi-sdk>
```

`scripts/qa-live.mjs` is retained as a historical fixture for the earlier three-row, two-extension candidate. It uses retired slash commands and identity-preserving reopen assumptions and is not a current dashboard QA entry point. The `qa:legacy` script exposes it only for historical reproduction with its matching source revision. Current two-column QA is described in the root verification document.

Optional arguments: `--herdr-bin` selects the existing CLI; `--session` defaults to `piomo`; `--todo-package` and `--dag-package` select local archives instead of packing source; `--static-agent-dir` adds a read-only comparison of declared installation anchors.

The host uses real stock ResourceLoader, SessionManager, registered tool/command callbacks and InteractiveMode factories through a bounded component facade, without running the user's conversation or full parent chat TUI. QA DAG/worker records are synthetic protocol-consumer fixtures; Todo uses real native mutations. ANSI replay images are terminal snapshots, not desktop screenshots.

See [installation](docs/INSTALL.md), [protocol](docs/PROTOCOL.md), and [roadmap](docs/ROADMAP.md). This concurrent candidate is local source work; publishing or activating the primary harness is a separate decision.

## Privacy and provenance

Runtime packages include compiled runtime, CLI, README, MIT license and third-party notices. They exclude tests, private evidence, session/task logs, auth/config profiles and copied SDK files. Public-source preflight is separate from the runtime scan. Hostile examples in safety tests are synthetic rejection fixtures.

The SDK is imported read-only and is not redistributed. Reuse origins are recorded in `THIRD-PARTY-NOTICES.md`.

`scripts/record-preflight.mjs`, the [sanitized plan](docs/plans/omo-herdr-todo.md), and [verified history](docs/HISTORY.md) retain the original split-source provenance. Current development uses this repository's root source and installer; there is no separate Todo repository or upstream upload.

## 한국어 요약

- DAG·작업자·Todo·협업 네 화면을 함께 봅니다. 각 화면의 `f` 추적과 수동 탐색은 독립적입니다.
- `c`로 완료 항목을 펼치고 `q`로 해당 화면만 닫습니다. `/dashboard` 하나로 네 화면을 다시 열며, 결과는 제한 시간 안의 부분/대기 상태까지 정확히 보고합니다.
- Todo 단계 제목은 원래 순서의 로마숫자와 기존 완료 수량을 유지합니다.
- 설치 파일 복사와 세션 활성화는 다릅니다. 보고된 비용과 연결이 끊긴 화면을 실제 청구·최신 진행으로 혼동하지 마세요.
