export const messages = {
  en: {
    closedPhases: 'Closed phases ({count})', controlsNarrow: 'j/k a/z c q',
    todo: 'Todo', paneTitle: 'OmO Todo', current: 'LIVE', empty: 'EMPTY (native)', waiting: 'WAITING',
    error: 'ERROR', 'last-known': 'CACHED NOT LIVE', disconnected: 'OFFLINE NOT LIVE',
    closed: 'closed', completed: 'done', dropped: 'drop', ask: 'Ask', now: 'Now',
    idle: 'No current target', noAsk: 'No captured ask', emptyPhase: '(empty phase)',
    emptyBody: 'The native checklist is empty.', waitingBody: 'Waiting for native Todo.',
    errorBody: 'Native Todo is unavailable.', readError: 'Read error: {error}',
    controls: 'j/k work a/z ask c closed q exit', position: 'Work {start}-{end}/{total}',
    followOn: 'Follow ON', followOff: 'Follow OFF',
    followShortOn: 'Follow ON', followShortOff: 'Follow OFF',
    invalidBinding: 'CLI and Todo role state do not match.',
    cacheError: 'Invalid derived Todo cache.',
    prefsError: 'View preferences: {error}', registrationError: 'Viewer ownership was not verified.',
    stateMissing: 'Role state is missing.',
  },
  ko: {
    closedPhases: '닫힌 단계 ({count})', controlsNarrow: 'j/k a/z c q',
    todo: 'Todo', paneTitle: 'OmO 할 일', current: '연결됨', empty: '원본 비어 있음', waiting: '연결 대기',
    error: '읽기 오류', 'last-known': '기록 / 오프라인', disconnected: '연결 종료 / 기록',
    closed: '닫힘', completed: '완료', dropped: '제외', ask: '요청', now: '현재',
    idle: '현재 대상 없음', noAsk: '저장된 요청 없음', emptyPhase: '(빈 단계)',
    emptyBody: '원본 체크리스트가 비어 있습니다.', waitingBody: '원본 Todo 연결을 기다립니다.',
    errorBody: '원본 Todo를 읽을 수 없습니다.', readError: '읽기 오류: {error}',
    controls: 'j/k 작업 a/z 요청 c 닫힌단계 q닫기', position: '작업 {start}-{end}/{total}',
    followOn: '추적 ON', followOff: '추적 OFF',
    followShortOn: '추적 ON', followShortOff: '추적 OFF',
    invalidBinding: 'CLI와 Todo 역할 정보가 다릅니다.',
    cacheError: 'Todo 파생 캐시가 잘못되었습니다.',
    prefsError: '화면 설정: {error}', registrationError: '뷰어 소유권을 확인하지 못했습니다.',
    stateMissing: '역할 정보를 찾을 수 없습니다.',
  },
  'zh-cn': {
    closedPhases: '已关闭阶段 ({count})', controlsNarrow: 'j/k a/z c q',
    todo: 'Todo', paneTitle: 'OmO 待办', current: '在线', empty: '原生列表为空', waiting: '等待连接',
    error: '读取错误', 'last-known': '记录 / 离线', disconnected: '连接结束 / 记录',
    closed: '关闭', completed: '完成', dropped: '移除', ask: '请求', now: '当前',
    idle: '无当前目标', noAsk: '无已保存请求', emptyPhase: '(空阶段)',
    emptyBody: '原生清单为空。', waitingBody: '等待原生 Todo 连接。',
    errorBody: '无法读取原生 Todo。', readError: '读取错误: {error}',
    controls: 'j/k 工作 a/z 请求 c 已关闭 q 关闭', position: '工作 {start}-{end}/{total}',
    followOn: '跟随 ON', followOff: '跟随 OFF',
    followShortOn: '跟随 ON', followShortOff: '跟随 OFF',
    invalidBinding: 'CLI 与 Todo 角色信息不匹配。',
    cacheError: 'Todo 派生缓存无效。',
    prefsError: '视图设置: {error}', registrationError: '无法验证查看器所有权。',
    stateMissing: '找不到角色状态。',
  },
};

export const languageOf = value => ['en', 'ko', 'zh-cn'].includes(value) ? value : 'en';
export function t(language, key, values = {}) {
  const template = messages[languageOf(language)][key];
  if (template === undefined) throw new Error(`Unknown translation key: ${key}`);
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match);
}
