// Fixed strings of the OmO collaboration pane. The header, section and footer words follow the
// other dashboard panes (Name [done/total], `─ Section ───`, `Follow ON · LIVE`).
export const messages = {
  en: {
    title: 'OmO Collab', name: 'Collab', wait: 'wait {count}', failed: '×{count}', flow: 'Flow {count}',
    emptyFlow: ' (no collaboration yet)', advisor: 'Advisor', advisorOn: '● on', advisorOff: '○ off',
    advisorNone: '○ no record', stats: '{consults} consults · {stops} STOP',
    kindNotify: 'note', kindInspect: 'check', kindRepair: 'fix', kindAdvisor: 'advisor',
    live: 'LIVE', noCarrier: 'no carrier', disabled: 'off', closed: 'ended', checking: 'checking', error: 'error',
    followOn: 'Follow ON', followOff: 'Follow OFF', note: 'note',
  },
  ko: {
    title: 'OmO Collab', name: 'Collab', wait: 'wait {count}', failed: '×{count}', flow: 'Flow {count}',
    emptyFlow: ' (no collaboration yet)', advisor: 'Advisor', advisorOn: '● on', advisorOff: '○ off',
    advisorNone: '○ no record', stats: '{consults} consults · {stops} STOP',
    kindNotify: 'note', kindInspect: 'check', kindRepair: 'fix', kindAdvisor: 'advisor',
    live: 'LIVE', noCarrier: 'no carrier', disabled: 'off', closed: 'ended', checking: 'checking', error: 'error',
    followOn: 'Follow ON', followOff: 'Follow OFF', note: '노트',
  },
  'zh-cn': {
    title: 'OmO 协作', name: '协作', wait: '等待 {count}', failed: '×{count}', flow: '流程 {count}',
    emptyFlow: ' (暂无协作)', advisor: '顾问', advisorOn: '● on', advisorOff: '○ off',
    advisorNone: '○ 无记录', stats: '咨询 {consults} · STOP {stops}',
    kindNotify: '备注', kindInspect: '检查', kindRepair: '修复', kindAdvisor: '顾问',
    live: '在线', noCarrier: '无载体', disabled: '已关闭', closed: '会话结束', checking: '检查中', error: '错误',
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
