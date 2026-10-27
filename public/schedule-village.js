// Pure state helpers for the schedule village. Keeping these separate makes the
// status semantics testable without creating a WebGL context.
const text = value => typeof value === 'string' && value.trim() ? value.trim() : '';

export function normalizeVillageAutomations(state = {}) {
  const cloudSync = state.cloudSync || {};
  return (Array.isArray(state.automations) ? state.automations : [])
    .filter(item => text(item?.id) && item.status === 'ACTIVE')
    .map(item => {
      const cloud = item.cloud === true;
      const stale = item.freshness === 'stale' || (cloud && cloudSync.stale === true);
      const execution = text(item.executionStatus).toLowerCase();
      let phase = 'unknown';
      if (item.status === 'PAUSED') phase = 'paused';
      else if (stale) phase = 'stale';
      else if (item.status === 'COMPLETED') phase = 'history';
      else if (execution === 'running') phase = 'running';
      else if (execution === 'completed') phase = 'completed';
      else if (execution === 'failed') phase = 'failed';
      else if (execution === 'waiting') phase = 'waiting';
      else if (item.status === 'ACTIVE') phase = 'enabled';
      const statusText = { running: '正在运行', waiting: '等待计划', enabled: '已启用', paused: '已暂停', completed: '已完成', history: '历史完成', failed: '执行失败', stale: '记录已过期', unknown: '暂无执行记录' }[phase];
      const sourceText = cloud ? (stale ? '云端快照 · 已过期' : '云端快照') : item.source === 'chatgpt' ? 'ChatGPT 快照' : '本机计划';
      const resultCount = Number.isFinite(item.resultCount) ? Math.max(0, item.resultCount) : null;
      const unreadResultCount = Number.isFinite(item.unreadResultCount) ? Math.max(0, item.unreadResultCount) : null;
      return { id: text(item.id), title: text(item.name) || '未命名定时任务', source: item.source, cloud, stale, phase, statusText, sourceText, resultCount, unreadResultCount };
    });
}

export function planVillageLots(items = [], priorLots = new Map(), columns = 3) {
  const prior = new Map(priorLots);
  const sorted = [...items].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const activeIds = new Set(sorted.map(item => item.id));
  const removed= [...prior.keys()].some(id => !activeIds.has(id));
  // Removing a plan intentionally closes gaps; ordinary polling and additions keep prior locations.
  if(removed)prior.clear();
  let nextSlot = [...prior.values()].reduce((max, lot) => Math.max(max, Number(lot?.slot) || 0), -1) + 1;
  const lots = new Map();
  for (const item of sorted) {
    let lot = prior.get(item.id);
    if (!lot) lot = { slot: nextSlot++ };
    lots.set(item.id, { id: item.id, slot: lot.slot, col: lot.slot % columns, row: Math.floor(lot.slot / columns) });
  }
  return lots;
}
