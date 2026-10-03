export const messages = {
  en: {
    todo: 'Todo', current: 'LIVE', empty: 'EMPTY (native)', waiting: 'WAITING',
    error: 'ERROR', 'last-known': 'CACHED NOT LIVE', disconnected: 'OFFLINE NOT LIVE',
    closed: 'closed', completed: 'done', dropped: 'drop', ask: 'Ask', now: 'Now',
    idle: 'No current target', noAsk: 'No captured ask', emptyPhase: '(empty phase)',
    emptyBody: 'The native checklist is empty.', waitingBody: 'Waiting for native Todo.',
    errorBody: 'Native Todo is unavailable.', readError: 'Read error: {error}',
    controls: 'j/k work a/z ask q exit', position: 'Work {start}-{end}/{total}',
    followOn: 'Follow ON', followOff: 'Follow OFF',
    invalidBinding: 'CLI and Todo role state do not match.',
    cacheError: 'Invalid derived Todo cache.',
    prefsError: 'View preferences: {error}', registrationError: 'Viewer ownership was not verified.',
  },
  ko: {
    todo: 'Todo', current: '연결됨', empty: '원본 비어 있음', waiting: '연결 대기',
    error: '읽기 오류', 'last-known': '기록 / 오프라인', disconnected: '연결 종료 / 기록',
    closed: '닫힘', completed: '완료', dropped: '제외', ask: '요청', now: '현재',
    idle: '현재 대상 없음', noAsk: '저장된 요청 없음', emptyPhase: '(빈 단계)',
    emptyBody: '원본 체크리스트가 비어 있습니다.', waitingBody: '원본 Todo 연결을 기다립니다.',
    errorBody: '원본 Todo를 읽을 수 없습니다.', readError: '읽기 오류: {error}',
    controls: 'j/k 작업 a/z 요청 q닫기', position: '작업 {start}-{end}/{total}',
    followOn: '자동 추적 ON', followOff: '자동 추적 OFF',
    invalidBinding: 'CLI와 Todo 역할 정보가 다릅니다.',
    cacheError: 'Todo 파생 캐시가 잘못되었습니다.',
    prefsError: '화면 설정: {error}', registrationError: '뷰어 소유권을 확인하지 못했습니다.',
  },
};

export const languageOf = value => value === 'ko' ? 'ko' : 'en';
export function t(language, key, values = {}) {
  const template = messages[languageOf(language)][key];
  if (template === undefined) throw new Error(`Unknown translation key: ${key}`);
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match);
}
