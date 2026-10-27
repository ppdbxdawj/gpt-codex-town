import assert from 'node:assert/strict';
import test from 'node:test';
import { compactAutomationState, compactInboxState, compactTaskState } from '../public/compact-state.js';

const codexSource = mode => [{ id: 'codex-state', label: 'Codex', mode }];

test('只统计当前返回列表中已确认的 Codex running 与 waiting', () => {
  const compact = compactTaskState({ sources: codexSource('local-logs'), tasks: [
    { id: 'a', source: 'codex', status: 'running' }, { id: 'b', source: 'codex', status: 'waiting' },
    { id: 'c', source: 'codex', status: 'unknown' }, { id: 'missing', source: 'codex' }, { id: 'done', source: 'codex', status: 'completed' }, { id: 'd', source: 'chatgpt', status: 'running' },
  ] });
  assert.equal(compact.running, 1); assert.equal(compact.waiting, 1); assert.equal(compact.unknownCount, 2);
  assert.equal(compact.tasks.length, 2); assert.equal(compact.status, 'partial');
});

test('读取不可用或刷新失败时不把未知展示为零', () => {
  const state = { sources: codexSource('unavailable'), tasks: [] };
  assert.equal(compactTaskState(state).running, null);
  const failed = compactTaskState({ sources: codexSource('local-logs'), tasks: [{ source: 'codex', status: 'running' }] }, { refreshFailed: true });
  assert.equal(failed.waiting, null); assert.deepEqual(failed.tasks, []);
  assert.equal(compactTaskState({ tasks: [] }).status, 'unavailable');
});

test('礼盒保留待验收数，ACTIVE 自动化不被推断为运行', () => {
  const state = { inbox: { pendingCount: 2, items: [{ id: 'r1', status: 'unread' }] }, automations: [{ id: 'a', name: '晨间记录', status: 'ACTIVE', executionStatus: 'unknown' }] };
  assert.equal(compactInboxState(state).pending, 2);
  assert.equal(compactAutomationState(state)[0].status, '已启用');
});

test('云端状态始终标为快照，且不可用时不伪造运行', () => {
  const compact = compactAutomationState({ cloudSync: { available: false }, automations: [{ id: 'cloud', name: '云端计划', status: 'ACTIVE', cloud: true, executionStatus: 'running' }] });
  assert.equal(compact[0].status, '云端快照 · 暂不可用');
  const enabled = compactAutomationState({ cloudSync: { available: true }, automations: [{ id: 'cloud', name: '云端计划', status: 'ACTIVE', cloud: true, executionStatus: 'unknown' }] });
  assert.equal(enabled[0].status, '云端快照 · 已启用');
});
