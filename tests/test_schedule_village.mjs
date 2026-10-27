import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeVillageAutomations,
  planVillageLots,
} from "../public/schedule-village.js";

function automation(id, overrides = {}) {
  return {
    id,
    name: "同名的定时任务",
    source: "chatgpt",
    cloud: true,
    status: "ACTIVE",
    executionStatus: "unknown",
    freshness: "snapshot",
    ...overrides,
  };
}

function items(automations, cloudSync = {}) {
  return normalizeVillageAutomations({ automations, cloudSync });
}

function lotsById(lots) {
  return lots instanceof Map ? lots : new Map(lots.map((lot) => [lot.id, lot]));
}

function lotSnapshot(lots) {
  return [...lots].map(([id, lot]) => [id, { ...lot }]);
}

test("街区只收录五项当前 ACTIVE 计划，不显示暂停或历史计划", () => {
  const normalized = items([
    automation("active-1"), automation("active-2"), automation("active-3"),
    automation("active-4"), automation("active-5"),
    automation("paused", { status: "PAUSED" }),
    automation("completed", { status: "COMPLETED" }),
  ]);
  assert.equal(normalized.length, 5);
  assert.deepEqual(normalized.map((item) => item.id).sort(), ["active-1", "active-2", "active-3", "active-4", "active-5"]);
});

test("同名当前计划按 id 获得不同小院", () => {
  const normalized = items([automation("cloud-a"), automation("cloud-b")]);
  const lots = lotsById(planVillageLots(normalized));
  assert.equal(lots.size, 2);
  assert.notEqual(lots.get("cloud-a").slot, lots.get("cloud-b").slot);
});

test("普通轮询、重排序和新增计划不移动已有小院，且不修改 prior Map", () => {
  const first = lotsById(planVillageLots(items([automation("a"), automation("b"), automation("c")])));
  const before = lotSnapshot(first);
  const refreshed = lotsById(planVillageLots(items([automation("a"), automation("b"), automation("c")]), first));
  const reordered = lotsById(planVillageLots(items([automation("c"), automation("a"), automation("b")]), first));
  const added = lotsById(planVillageLots(items([automation("c"), automation("a"), automation("b"), automation("d")]), first));

  assert.deepEqual(lotSnapshot(first), before, "helper 不得修改传入的 prior Map");
  for (const next of [refreshed, reordered, added]) {
    for (const id of ["a", "b", "c"]) {
      assert.equal(next.get(id).slot, first.get(id).slot, `${id} 在普通刷新时应保留位置`);
    }
  }
  assert.ok(Number.isInteger(added.get("d").slot));
});

test("移除计划可紧凑重排，但剩余和新增 id 都不会丢失且 prior Map 保持不变", () => {
  const prior = lotsById(planVillageLots(items([automation("a"), automation("b"), automation("c")])));
  const before = lotSnapshot(prior);
  const changed = lotsById(planVillageLots(items([automation("a"), automation("c"), automation("d")]), prior));

  assert.deepEqual([...changed.keys()].sort(), ["a", "c", "d"]);
  assert.deepEqual([...changed.values()].map((lot) => lot.slot).sort((a, b) => a - b), [0, 1, 2]);
  assert.deepEqual(lotSnapshot(prior), before, "移除触发重排也不得改写 prior Map");
});

test("结果总数和未读结果数按各自字段传递，缺失时不编造", () => {
  const normalized = new Map(items([
    automation("with-results", { resultCount: 3, unreadResultCount: 2 }),
    automation("read-results", { resultCount: 1, unreadResultCount: 0 }),
    automation("without-counts"),
    automation("paused-with-counts", { status: "PAUSED", resultCount: 9, unreadResultCount: 9 }),
  ]).map((item) => [item.id, item]));
  assert.equal(normalized.get("with-results").resultCount, 3);
  assert.equal(normalized.get("with-results").unreadResultCount, 2);
  assert.equal(normalized.get("read-results").resultCount, 1);
  assert.equal(normalized.get("read-results").unreadResultCount, 0);
  assert.equal(normalized.get("without-counts").resultCount, null);
  assert.equal(normalized.get("without-counts").unreadResultCount, null);
  assert.equal(normalized.has("paused-with-counts"), false);
});

test("过期的 running 快照不会被呈现为正在运行", () => {
  const normalized = new Map(items([
    automation("stale-running", { executionStatus: "running", freshness: "stale" }),
    automation("cloud-sync-stale", { executionStatus: "running" }),
    automation("local-running", { cloud: false, executionStatus: "running", freshness: "snapshot" }),
  ], { stale: true }).map((item) => [item.id, item]));
  assert.notEqual(normalized.get("stale-running").phase, "running");
  assert.notEqual(normalized.get("cloud-sync-stale").phase, "running");
  assert.equal(normalized.get("local-running").phase, "running");
});
