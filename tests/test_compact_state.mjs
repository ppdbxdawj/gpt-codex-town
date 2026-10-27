import assert from 'node:assert/strict';
import test from 'node:test';
import { compactAutomationState, compactInboxState, compactTaskState, resolveCompactPage } from '../public/compact-state.js';

const codexSource = mode => [{ id: 'codex-state', label: 'Codex', mode }];

test('只统计当前返回列表中已确认的 Codex running 与 waiting', () => {
  const compact = compactTaskState({ sources: codexSource('local-logs'), tasks: [
    { id: 'a', source: 'codex', status: 'running' }, { id: 'b', source: 'codex', status: 'waiting' },
    { id: 'c', source: 'codex', status: 'unknown' }, { id: 'missing', source: 'codex' }, { id: 'done', source: 'codex', status: 'completed' }, { id: 'e', source: 'codex', status: 'running', title: '足够长的任务标题不应在状态层被截断' }, { id: 'f', source: 'codex', status: 'waiting' }, { id: 'd', source: 'chatgpt', status: 'running' },
  ] });
  assert.equal(compact.running, 2); assert.equal(compact.waiting, 2); assert.equal(compact.unknownCount, 2);
  assert.equal(compact.tasks.length, 4); assert.equal(compact.tasks[2].title, '足够长的任务标题不应在状态层被截断'); assert.equal(compact.tasks[3].id, 'f'); assert.equal(compact.status, 'partial');
});

test('读取不可用或刷新失败时不把未知展示为零', () => {
  const state = { sources: codexSource('unavailable'), tasks: [] };
  assert.equal(compactTaskState(state).running, null);
  const failed = compactTaskState({ sources: codexSource('local-logs'), tasks: [{ source: 'codex', status: 'running' }] }, { refreshFailed: true });
  assert.equal(failed.waiting, null); assert.deepEqual(failed.tasks, []);
  assert.equal(compactTaskState({ tasks: [] }).status, 'unavailable');
});

test('礼盒保留待验收数，ACTIVE 自动化不被推断为运行', () => {
  const state = { inbox: { pendingCount: 4, items: [{ id: 'r1', status: 'unread' }, { id: 'r2', status: 'read' }, { id: 'r3', status: 'unread' }, { id: 'r4', status: 'read' }] }, automations: [{ id: 'a', name: '晨间记录', status: 'ACTIVE', executionStatus: 'unknown' }] };
  assert.equal(compactInboxState(state).pending, 4);
  assert.equal(compactInboxState(state).items.length, 4);
  assert.equal(compactAutomationState(state)[0].status, '已启用');
});

test('分页按项目 id 保留，重排不跳页且移除时收敛到相邻项', () => {
  const before = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const selected = { itemId: 'd', page: 3 };
  const reordered = [{ id: 'd' }, { id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(resolveCompactPage(reordered, selected).item.id, 'd');
  const removed = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(resolveCompactPage(removed, selected).item.id, 'c');
  assert.equal(resolveCompactPage(before, { page: 3 }).item.id, 'd');
});

test('云端状态始终标为快照，且不可用时不伪造运行', () => {
  const compact = compactAutomationState({ cloudSync: { available: false }, automations: [{ id: 'cloud', name: '云端计划', status: 'ACTIVE', cloud: true, executionStatus: 'running' }] });
  assert.equal(compact[0].status, '云端快照 · 暂不可用');
  const enabled = compactAutomationState({ cloudSync: { available: true }, automations: [{ id: 'cloud', name: '云端计划', status: 'ACTIVE', cloud: true, executionStatus: 'unknown' }] });
  assert.equal(enabled[0].status, '云端快照 · 已启用');
});
