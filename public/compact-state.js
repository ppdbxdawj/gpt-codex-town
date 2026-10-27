import { normalizeVillageAutomations } from './schedule-village.js';

const value = input => typeof input === 'string' ? input.trim() : '';

function codexSource(state) {
  return (Array.isArray(state?.sources) ? state.sources : []).find((source) => {
    const id = value(source?.id).toLowerCase();
    return id === 'codex-state' || id === 'codex' || value(source?.label).toLowerCase() === 'codex';
  });
}

export function compactTaskState(state = {}, { refreshFailed = false } = {}) {
  const source = codexSource(state);
  const sourceUnavailable = !source || value(source?.mode) === 'unavailable';
  const tasks = (Array.isArray(state?.tasks) ? state.tasks : []).filter((task) => task?.source === 'codex');
  const confirmed = tasks.filter((task) => task?.status === 'running' || task?.status === 'waiting');
  const knownTerminal = new Set(['completed', 'failed', 'interrupted', 'idle']);
  const unknownCount = tasks.filter((task) => task?.status !== 'running' && task?.status !== 'waiting' && !knownTerminal.has(task?.status)).length;
  const unavailable = refreshFailed || sourceUnavailable;
  const status = unavailable ? 'unavailable' : unknownCount ? 'partial' : 'confirmed';
  return {
    status,
    running: unavailable ? null : confirmed.filter((task) => task.status === 'running').length,
    waiting: unavailable ? null : confirmed.filter((task) => task.status === 'waiting').length,
    unknownCount: unavailable ? null : unknownCount,
    tasks: unavailable ? [] : confirmed.slice(0, 3),
    message: unavailable
      ? '状态待更新，当前读取范围暂不可确认。'
      : unknownCount
        ? `另有 ${unknownCount} 项状态未确认。`
        : '当前返回列表中已确认的 Codex 进行项。',
  };
}

export function compactInboxState(state = {}) {
  const items = Array.isArray(state?.inbox?.items) ? state.inbox.items : [];
  const pending = Number.isFinite(state?.inbox?.pendingCount)
    ? Math.max(0, state.inbox.pendingCount)
    : items.filter((item) => item?.status !== 'accepted').length;
  return { pending, items: items.filter((item) => item?.status !== 'accepted').slice(0, 3) };
}

export function compactAutomationState(state = {}) {
  return normalizeVillageAutomations(state).map((item) => {
    const unavailable = item.cloud && state?.cloudSync?.available === false;
    const status = unavailable ? '云端快照 · 暂不可用' : item.cloud ? `云端快照 · ${item.statusText}` : item.statusText;
    return { id: item.id, title: item.title, status, threadUrl: value((state.automations || []).find((entry) => entry?.id === item.id)?.threadUrl) };
  });
}
