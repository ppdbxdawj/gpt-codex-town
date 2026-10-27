# 梦幻浮岛迷你模式 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为迷你窗口交付奶油马卡龙梦幻浮岛，并以两类核心提醒、可访问的完整小院名称和分页短卡呈现真实本机状态。

**Architecture:** `scene.js` 负责浮岛环境与建筑焦点，`app.js` 负责两类摘要、hover/focus 语义和短卡分页，`style.css` 负责紧凑可读的视觉层级。后端状态协议不扩展，沿用本机只读、5 秒刷新与云端快照限制。

**Tech Stack:** Three.js、原生 JavaScript/CSS、Swift Cocoa/WebKit、现有本地 JSONL 服务。

---

### Task 1: 建立浮岛视觉与低标签摘要

**Files:**
- Modify: `public/scene.js`
- Modify: `public/style.css`
- Modify: `public/app.js`

**Step 1:** 用奶油马卡龙配色、浮岛边缘、云雾与柔光改造迷你场景，保留工坊、小院、成果建筑、轨道和程序化角色。

**Step 2:** 将常驻文字缩减到当前进行/等待与待验收两类可信提醒；未知、断联与云端快照显示未确认或待更新，不显示为零或运行。

### Task 2: 完整名称与短卡分页

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `public/style.css`

**Step 1:** 为每个小院增加 hover 与键盘 focus 的完整名称和状态提示，避免长名称遮挡常驻城市。

**Step 2:** 点击工坊或成果建筑时打开短卡；为全部当前进行项和全部待验收结果提供分页浏览、状态和原任务入口。

**Step 3:** 保持阅读、验收和恢复待验收必须由用户明确操作；不让短卡自动更改结果状态。

### Task 3: 测试与验收

**Files:**
- Test: `tests/test_*.mjs`
- Test: Python 既有测试

**Step 1:** 覆盖两类摘要、未知/断联边界、长名称 focus 提示和分页的首尾页行为。

**Step 2:** 运行完整 Python/Node 测试、前端语法检查与原生构建。

**Step 3:** 在迷你窗口人工验证浮岛层次、两类提醒、小院 hover/focus、短卡分页、主题与减少动态；确认云端仍标为非实时快照。完成后更新 README 截图与验证记录。
