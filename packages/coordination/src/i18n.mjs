// Fixed strings of the OmO collaboration pane. The footer follow label is the same
// single form every dashboard pane uses (todo and DAG catalogs carry the same words).
export const messages = {
  en: {
    title: 'OmO Collab', header: 'Collab · Advisor', healthy: '●OK', attention: '⚠Check',
    coordination: 'Coord', connected: '● connected', noCarrier: '○ no carrier',
    disabled: '○ disabled', checking: '○ checking', closed: '○ session ended', error: '⚠ error',
    baseline: ' baseline {hash}…', noBaseline: ' baseline unknown', recent: 'Recent flow',
    emptyFlow: ' (no collaboration yet)', advisor: 'Advisor', advisorOn: '● on', advisorOff: '○ off',
    advisorNone: '○ no record', consults: 'consults {count}', stops: ' STOP {count}', last: ' · {time}',
    followOn: 'Follow ON', followOff: 'Follow OFF', note: 'note',
  },
  ko: {
    title: 'OmO 협업', header: '협업 · 어드바이저', healthy: '●정상', attention: '⚠확인',
    coordination: '코디네이션', connected: '● 연결됨', noCarrier: '○ 캐리어 없음',
    disabled: '○ 꺼짐', checking: '○ 확인 중', closed: '○ 세션 종료', error: '⚠ 오류',
    baseline: ' baseline {hash}…', noBaseline: ' baseline 미확인', recent: '최근 흐름',
    emptyFlow: ' (아직 협업 없음)', advisor: '어드바이저', advisorOn: '● on', advisorOff: '○ off',
    advisorNone: '○ 기록 없음', consults: '자문 {count}', stops: ' 열린 STOP {count}', last: ' · {time}',
    followOn: '추적 ON', followOff: '추적 OFF', note: '노트',
  },
  'zh-cn': {
    title: 'OmO 协作', header: '协作 · 顾问', healthy: '●正常', attention: '⚠检查',
    coordination: '协调', connected: '● 已连接', noCarrier: '○ 无载体',
    disabled: '○ 已关闭', checking: '○ 检查中', closed: '○ 会话结束', error: '⚠ 错误',
    baseline: ' baseline {hash}…', noBaseline: ' baseline 未知', recent: '最近流程',
    emptyFlow: ' (暂无协作)', advisor: '顾问', advisorOn: '● on', advisorOff: '○ off',
    advisorNone: '○ 无记录', consults: '咨询 {count}', stops: ' STOP {count}', last: ' · {time}',
    followOn: '跟随 ON', followOff: '跟随 OFF', note: '备注',
  },
};

export const languageOf = value => ['en', 'ko', 'zh-cn'].includes(value) ? value : 'en';
export function t(language, key, values = {}) {
  const template = messages[languageOf(language)][key];
  if (template === undefined) throw new Error(`Unknown translation key: ${key}`);
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match);
}
