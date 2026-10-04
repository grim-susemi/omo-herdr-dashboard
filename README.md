# omo-herdr-todo

Native Todo, workflow DAG and ordinary workers remain visible together in three fixed Herdr panes. Todo reads the selected stock Senpi branch; the dashboard never creates a second checklist store.

## Everyday controls

With both candidate extensions installed and loaded in an eligible parent session, the right column opens without taking conversation focus: DAG above workers above Todo, initially 40/30/30 of its height. Child sessions cannot own the layout.

Each role starts with automatic follow. Press `f` in one pane to toggle its follow. Scrolling/selecting manually pauses only that pane; `f` resumes it. `c` controls completed work for that role. Completed ordinary workers and closed Todo phases fold automatically; active/error descendants and manual expansions remain accessible. DAG topology stays canonical. Fixed DAG/workers panes ignore `t`.

Press `q` to close one role. Source updates respect that closure. `/todo-pane` explicitly reopens Todo; `/dag-pane` reopens DAG/workers. Surviving role identities and conversation focus remain intact. Losing current ready coverage restores the actual native inline widget factory.

Read errors, valid empty state and disconnected last-known state have distinct labels. A disconnected cache is not live progress. Cost is producer-reported or unknown; zero is shown only when reported. Speed uses generation time, not wall time. These figures are not an invoice.

## Local verification

Node24 or later and an already running Herdr session are required. SDK version and file hashes must match `config/native-source-manifest.json`; there is no ambient SDK fallback or provider/model request.

```bash
npm test
npm run build
npm run test:package
npm run test:host -- --senpi-root <installed-senpi-sdk>
npm run qa:live -- --senpi-root <installed-senpi-sdk> --dag-root <dag-source-checkout> --evidence <private-evidence-directory>
```

`test:pty` aliases that same actual native/Herdr scenario with the same arguments. QA creates isolated HOME/agent/cache and an unfocused owned tab, installs candidates there, checks real processes/painted ACKs, records visible ANSI frames, and removes its own resources.

Optional arguments: `--herdr-bin` selects the existing CLI; `--session` defaults to `piomo`; `--todo-package` and `--dag-package` select local archives instead of packing source; `--static-agent-dir` adds a read-only comparison of declared installation anchors.

The host uses real stock ResourceLoader, SessionManager, registered tool/command callbacks and InteractiveMode factories through a bounded component facade, without running the user's conversation or full parent chat TUI. QA DAG/worker records are synthetic protocol-consumer fixtures; Todo uses real native mutations. ANSI replay images are terminal snapshots, not desktop screenshots.

See [installation](docs/INSTALL.md), [protocol](docs/PROTOCOL.md), and [roadmap](docs/ROADMAP.md). This concurrent candidate is local source work; publishing or activating the primary harness is a separate decision.

## Privacy and provenance

Runtime packages include compiled runtime, CLI, README, MIT license and third-party notices. They exclude tests, private evidence, session/task logs, auth/config profiles and copied SDK files. Public-source preflight is separate from the runtime scan. Hostile examples in safety tests are synthetic rejection fixtures.

The SDK is imported read-only and is not redistributed. Reuse origins are recorded in `THIRD-PARTY-NOTICES.md`.

## 한국어 요약

- DAG·작업자·Todo를 동시에 봅니다. 각 화면의 `f` 추적과 수동 탐색은 독립적입니다.
- `c`로 완료 항목을 펼치고 `q`로 해당 화면만 닫습니다. `/todo-pane`, `/dag-pane`으로 다시 엽니다.
- 설치 파일 복사와 세션 활성화는 다릅니다. 보고된 비용과 연결이 끊긴 화면을 실제 청구·최신 진행으로 혼동하지 마세요.
