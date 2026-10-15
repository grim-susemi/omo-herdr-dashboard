// Band dashboard pane sizes derived from BAND_LAYOUT, and the three role renderers
// called with the options their viewers pass (packages/todo/src/viewer.mjs draw and
// packages/dag/src/viewer.mjs draw). test/band-render.test.mjs and the owner's text
// samples both use this module, so the samples are the frames the tests check.
import { bandSizes, freshBandRegion } from '../../packages/dag/src/controller.mjs';
import { runningTarget, standaloneTasks } from '../../packages/dag/src/render.mjs';
import { renderFixedFrame } from '../../packages/dag/src/viewer.mjs';
import { projectNativeTodo } from '../../packages/todo/src/native-todo.mjs';
import { renderFrame, runningTarget as todoTarget } from '../../packages/todo/src/render.mjs';

// The terminal sizes measured in layout-c task 1.
export const TERMINALS = [{ width: 172, height: 46 }, { width: 120, height: 40 }, { width: 100, height: 30 }];
// The owner's live dashboard area after an in-place migration: his chat keeps 84 of 172 columns.
export const OWNER_REGION = { x: 84, y: 0, width: 88, height: 46 };
export const ROLES = ['todo', 'workers', 'dag'];

// Pane sizes (columns x rows) of the band inside a dashboard region.
export function bandPanes(region) {
  const sizes = bandSizes(region);
  return { todo: { columns: region.width, rows: sizes.todoRows },
    workers: { columns: sizes.workersColumns, rows: sizes.lowerRows },
    dag: { columns: sizes.dagColumns, rows: sizes.lowerRows }, fits: sizes.fits, readable: sizes.readable };
}
// A fresh managed band opens by splitting the chat once at BAND_LAYOUT.chatShare.
export const freshRegion = terminal => freshBandRegion({ x: 0, y: 0, ...terminal });
export const freshPanes = terminal => bandPanes(freshRegion(terminal));

export const NOW = Date.parse('2026-10-15T09:30:00.000Z');
const before = seconds => new Date(NOW - seconds * 1000).toISOString();

export function todoSnapshot() {
  return projectNativeTodo([{ type: 'custom', customType: 'senpi.todo-state', data: { schema: 'v2', phases: [
    { name: '측정', tasks: [{ content: '분할 트리 측정', status: 'completed' },
      { content: '밴드 판정 함수 추가', status: 'completed' }] },
    { name: '구현', tasks: [{ content: '새 대시보드 밴드 생성', status: 'completed' },
      { content: '세 화면 크기에서 Todo, 작업자, DAG 창을 밴드 크기로 그리고 소유자 시안을 저장합니다', status: 'in_progress' },
      { content: '열 배치 대시보드를 /dashboard로 제자리 이동', status: 'pending' },
      { content: '멈춘 배치 기록 정리', status: 'pending' }] },
    { name: '검증', tasks: [{ content: '격리 Herdr에서 밴드 실행', status: 'pending' },
      { content: '설치 전 dry-run', status: 'pending' }] },
  ], ask: { entryId: 'band-ask', capturedAt: 1,
    text: '대시보드 영역 위쪽에 Todo를 넓게 두고, 그 아래 왼쪽에 작업자, 오른쪽에 DAG를 나란히 보여 주세요.' } } }]);
}

const model = { model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' };
export function dashboardState(language = 'en') {
  return { language, connected: true, updatedAt: new Date(NOW).toISOString(), tasks: [
    { id: 'st_render', status: 'running', description: '밴드 크기별 렌더 시안 만들기', agent: 'visual-engineering', ...model,
      startedAt: before(205), progress: '172x46의 Todo 86x16 렌더 확인 중', turns: 12, toolCalls: 31,
      metrics: { cost_usd: 0.4493, tokens_per_second: 21, cost_status: 'reported', source: 'run_stats' } },
    { id: 'st_render_check', parentTaskId: 'st_render', status: 'running', description: '좁은 작업자 창 폴백 확인',
      agent: 'quick', model: 'gpt-6.1-sol', reasoningEffort: 'low', startedAt: before(40) },
    { id: 'st_docs', status: 'pending', description: '공개 문서에 밴드 배치 설명', agent: 'writing', ...model },
    { id: 'st_cards', status: 'completed', description: '카드 정리 반영', agent: 'visual-engineering', ...model,
      startedAt: before(3600), completedAt: before(2400) },
    { id: 'st_band', status: 'completed', description: '새 대시보드 밴드 생성', agent: 'deep-high', ...model,
      startedAt: before(7200), completedAt: before(5400) },
    { id: 'st_migrate', status: 'running', description: '열 배치를 밴드로 제자리 이동', agent: 'deep-high', ...model,
      startedAt: before(1500), progress: '임시 분할 뒤 교환 단계' },
    { id: 'st_samples', status: 'running', description: '세 크기 렌더 시안', agent: 'visual-engineering', ...model,
      startedAt: before(300) },
  ], runs: [{ id: 'layout-c', name: 'layout-c 웨이브', status: 'running', nodes: [
    { id: 'band', label: '밴드 생성', state: 'completed', taskId: 'st_band' },
    { id: 'migrate', label: '제자리 이동', state: 'running', taskId: 'st_migrate' },
    { id: 'samples', label: '렌더 시안', state: 'running', taskId: 'st_samples' },
    { id: 'docs', label: '문서 갱신', state: 'pending' },
  ], edges: [{ from: 'band', to: 'migrate' }, { from: 'band', to: 'samples' },
    { from: 'migrate', to: 'docs' }, { from: 'samples', to: 'docs' }] }] };
}

// The Todo viewer's live frame: a current native source, follow on, the running target revealed.
export function renderTodo(snapshot, { columns, rows, language = 'en', color = true }) {
  const target = todoTarget(snapshot);
  return { target, frame: renderFrame(snapshot, { columns, rows, language, availability: 'current', color,
    follow: true, target, revealTarget: true }) };
}

// A managed workers ('tasks') or DAG viewer's live frame, following its running work.
export function renderRole(state, role, { columns, rows, color = true, now = NOW, frame = 0 }) {
  const view = role === 'dag' ? 'dag' : 'tasks';
  const roots = standaloneTasks(state);
  const target = runningTarget(view === 'dag' ? { ...state, tasks: [] } : { ...state, runs: [], tasks: roots });
  return { target, frame: renderFixedFrame(state, { columns, rows, runIndex: 0, scroll: 0, color, follow: true, now, frame,
    selectedNodeId: state.runs[0]?.nodes[0]?.id, selectedTaskId: roots[0]?.id,
    runningNodeId: target?.nodeId, runningTaskId: target?.taskId }, view) };
}
