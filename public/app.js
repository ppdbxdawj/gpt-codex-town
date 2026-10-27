const POLL_MS = 5000;
const STATUS_LABELS = {
  running: "运行中",
  waiting: "待处理",
  completed: "已结束",
  failed: "记录失败",
  interrupted: "已中断",
  idle: "空闲",
  unknown: "状态未知",
};
const EXECUTION_LABELS = {
  running: "本次运行中",
  waiting: "待命",
  completed: "最近运行完成",
  failed: "最近运行失败",
  unknown: "执行状态未知",
};
const SOURCE_MODE_LABELS = {
  local: "本机记录",
  "local-logs": "本机任务日志",
  snapshot: "本地快照",
  unavailable: "暂不可用",
};
const desktop = window.manorDesktop;
const hasDesktopBridge = Boolean(desktop && typeof desktop.request === "function");

function initialAnimationPaused() {
  const saved = localStorage.getItem("star-sugar-animation-paused");
  if (saved !== null) return saved === "true";
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

const state = {
  data: null,
  selectedTaskId: null,
  selectedInboxId: null,
  source: "all",
  search: "",
  automationSource: "all",
  selectedAutomationId: null,
  expandedAutomationResultIds: new Set(),
  scrollAutomationToSelection: false,
  tab: "tasks",
  timer: null,
  inFlight: false,
  failedRefreshes: 0,
  manor: null,
  animationPaused: initialAnimationPaused(),
  theme: localStorage.getItem("star-sugar-theme") || "day",
  visible: true,
  progressTarget: null,
  progressClosed: false,
  progressExpanded: false,
};

const ui = {
  body: document.body,
  running: document.querySelector("#running-count"),
  waiting: document.querySelector("#waiting-count"),
  completed: document.querySelector("#completed-count"),
  recordRange: document.querySelector("#record-range"),
  connection: document.querySelector("#connection-state"),
  refresh: document.querySelector("#refresh-button"),
  desktopMode: document.querySelector("#desktop-mode-button"),
  miniInbox: document.querySelector("#mini-inbox-button"),
  miniUnread: document.querySelector("#mini-unread-count"),
  miniPending: document.querySelector("#mini-pending-count"),
  theme: document.querySelector("#theme-button"),
  pause: document.querySelector("#pause-button"),
  sources: document.querySelector("#source-statuses"),
  scopeNote: document.querySelector("#scope-note"),
  sync: document.querySelector("#sync-status"),
  staleNotice: document.querySelector("#stale-notice"),
  staleMessage: document.querySelector("#stale-message"),
  sceneUnavailable: document.querySelector("#scene-unavailable"),
  resetView: document.querySelector("#reset-view-button"),
  focusOwner: document.querySelector("#focus-owner-button"),
  ownerAvatarStatus: document.querySelector("#owner-avatar-status"),
  scheduleInbox: document.querySelector("#schedule-inbox-button"),
  scheduleInboxCount: document.querySelector("#schedule-inbox-count"),
  total: document.querySelector("#task-total"),
  sourceFilter: document.querySelector("#source-filter"),
  search: document.querySelector("#task-search"),
  filterSummary: document.querySelector("#filter-summary"),
  taskList: document.querySelector("#delegation-list"),
  inboxList: document.querySelector("#inbox-list"),
  automationList: document.querySelector("#automation-list"),
  automationFilters: Array.from(document.querySelectorAll("[data-automation-source]")),
  cloudSyncNote: document.querySelector("#cloud-sync-note"),
  openCloudSchedules: document.querySelector("#open-cloud-schedules"),
  trailRunning: document.querySelector("#trail-running-count"),
  trailStandby: document.querySelector("#trail-standby-count"),
  trailCloud: document.querySelector("#trail-cloud-count"),
  trailNextLocal: document.querySelector("#trail-next-local"),
  artifactList: document.querySelector("#artifact-list"),
  activityList: document.querySelector("#activity-list"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  panels: Array.from(document.querySelectorAll(".tab-panel")),
  progressCard: document.querySelector("#progress-card"), progressTitle: document.querySelector("#progress-title"), progressMeta: document.querySelector("#progress-meta"), progressEvents: document.querySelector("#progress-events"), progressClose: document.querySelector("#progress-close"), progressExpand: document.querySelector("#progress-expand"), progressSelect: document.querySelector("#progress-select"),
};

function text(value, fallback = "—") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return fallback;
}

function tasksOf(data = state.data) {
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

function automationsOf(data = state.data) {
  return Array.isArray(data?.automations) ? data.automations : [];
}

function activeAutomationsOf(data = state.data) {
  return automationsOf(data).filter((item) => text(item?.status, "").toUpperCase() === "ACTIVE");
}

function projectsOf(data = state.data) {
  return Array.isArray(data?.projects) ? data.projects : [];
}

function inboxOf(data = state.data) {
  return Array.isArray(data?.inbox?.items) ? data.inbox.items : [];
}

function artifactsOf(data = state.data) {
  return tasksOf(data).flatMap((task) => (Array.isArray(task.artifacts) ? task.artifacts : [])
    .filter((artifact) => artifact && (artifact.url || artifact.path))
    .map((artifact) => ({ ...artifact, task })));
}

function safeUrl(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return "";
  try {
    const url = new URL(candidate, window.location.origin);
    if (["http:", "https:"].includes(url.protocol)) return url.href;
    if (url.protocol === "codex:") return url.href;
  } catch (_) {
    return "";
  }
  return "";
}

function parseDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function projectName(projectId) {
  const project = projectsOf().find((candidate) => candidate?.id === projectId);
  if (project) return text(project.name, "未命名项目");
  const raw = text(projectId, "");
  if (!raw || raw === "未归属项目" || /^g-p-[a-z0-9-]+$/i.test(raw)) return "未命名项目";
  return raw;
}

function formatDate(value, style = "short") {
  const date = parseDate(value);
  if (!date) return "未提供";
  const options = style === "long"
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat("zh-CN", options).format(date);
}

function relativeTime(value) {
  const date = parseDate(value);
  if (!date) return "时间未提供";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 50) return seconds >= 0 ? "即将" : "刚刚";
  const unit = abs < 3600 ? 60 : abs < 86400 ? 3600 : 86400;
  const valueInUnit = Math.round(abs / unit);
  const label = unit === 60 ? "分钟" : unit === 3600 ? "小时" : "天";
  return seconds >= 0 ? `${valueInUnit} ${label}后` : `${valueInUnit} ${label}前`;
}

function dateRange(tasks) {
  const dates = tasks.map((task) => parseDate(task.updatedAt)).filter(Boolean).sort((a, b) => a - b);
  if (!dates.length) return "最近记录范围：暂无时间信息";
  const formatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });
  const first = formatter.format(dates[0]);
  const last = formatter.format(dates[dates.length - 1]);
  return `最近记录范围：${first}${first === last ? "" : `–${last}`}`;
}

function automationScheduleLabel(schedule) {
  if (typeof schedule !== "string" || !schedule.trim()) return "自定义周期";
  const fields = Object.fromEntries(schedule.replace(/^RRULE:/i, "").split(/[;\s]+/)
    .map((part) => part.split("=", 2))
    .filter(([key, value]) => key && value)
    .map(([key, value]) => [key.toUpperCase(), value.toUpperCase()]));
  const frequency = fields.FREQ;
  const interval = Math.max(1, Number.parseInt(fields.INTERVAL || "1", 10) || 1);
  const hour = fields.BYHOUR === undefined ? null : Number.parseInt(fields.BYHOUR, 10);
  const minute = fields.BYMINUTE === undefined ? 0 : Number.parseInt(fields.BYMINUTE, 10);
  const time = Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59
    ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : "";
  if (frequency === "MINUTELY") return interval === 1 ? "每分钟" : `每${interval}分钟`;
  if (frequency === "HOURLY") return interval === 1 ? "每小时" : `每${interval}小时`;
  if (frequency === "DAILY") return `${interval === 1 ? "每天" : `每${interval}天`}${time}`;
  if (frequency === "WEEKLY") {
    const days = { MO: "一", TU: "二", WE: "三", TH: "四", FR: "五", SA: "六", SU: "日" };
    const byDay = (fields.BYDAY || "").split(",").filter((day) => days[day]);
    const dayLabel = byDay.join(",") === "MO,TU,WE,TH,FR" ? "一至周五" : byDay.map((day) => days[day]).join("、");
    const base = interval === 1 ? "每周" : `每${interval}周`;
    return `${base}${dayLabel}${time}`;
  }
  return "自定义周期";
}

function statusKey(status) {
  return Object.hasOwn(STATUS_LABELS, status) ? status : "unknown";
}

function makeElement(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function emptyState(title, copy) {
  const empty = makeElement("div", "empty-state");
  const strong = makeElement("strong", "", title);
  const paragraph = makeElement("span", "", copy);
  empty.append(strong, paragraph);
  return empty;
}

function setConnection(kind, label, title = label) {
  ui.connection.className = `connection state-${kind}`;
  ui.connection.title = title;
  const labelNode = ui.connection.querySelector("span");
  if (labelNode) labelNode.textContent = label;
}

function currentFilteredTasks() {
  const query = state.search.trim().toLocaleLowerCase("zh-CN");
  return tasksOf().filter((task) => {
    const matchesSource = state.source === "all" || task.source === state.source;
    const searchable = [task.title, projectName(task.project), task.summary, task.model, task.statusDetail]
      .map((part) => text(part, "").toLocaleLowerCase("zh-CN")).join(" ");
    return matchesSource && (!query || searchable.includes(query));
  });
}

function renderSourceStatuses() {
  ui.sources.replaceChildren();
  const sources = Array.isArray(state.data?.sources) ? state.data.sources : [];
  if (!sources.length) {
    ui.sources.append(makeElement("span", "source-chip muted", "未提供来源状态"));
    return;
  }
  sources.forEach((source) => {
    const warning = text(source.message, "");
    const mode = text(source.mode, "local");
    const modeLabel = SOURCE_MODE_LABELS[mode] || "本机记录";
    const unavailable = mode === "unavailable";
    const label = `${text(source.label, source.id || "来源")} · ${modeLabel}${unavailable && warning ? ` · ${warning}` : ""}`;
    ui.sources.append(makeElement("span", `source-chip${unavailable ? " warn" : ""}`, label));
  });
}

function renderOverview() {
  const all = tasksOf();
  const inbox = state.data?.inbox || {};
  const count = (status) => all.filter((task) => statusKey(task.status) === status).length;
  ui.running.textContent = count("running");
  ui.waiting.textContent = count("waiting");
  ui.completed.textContent = count("completed");
  updateLedgerTotal();
  ui.miniUnread.textContent = text(inbox.unreadCount, "0");
  ui.miniPending.textContent = text(inbox.pendingCount, "0");
  ui.recordRange.textContent = dateRange(all);
  ui.sync.textContent = state.data?.generatedAt ? `最后同步 ${formatDate(state.data.generatedAt)}` : "同步时间未提供";
  const scope = scopeMessage(state.data?.scope);
  ui.scopeNote.hidden = !scope;
  ui.scopeNote.textContent = scope;
  renderSourceStatuses();
  renderRuntimeRibbon();
}

function executionKey(automation) {
  return Object.hasOwn(EXECUTION_LABELS, automation?.executionStatus) ? automation.executionStatus : "unknown";
}

function localNextTime(automation) {
  if (automation?.cloud || text(automation?.status, "").toUpperCase() !== "ACTIVE") return null;
  const next = parseDate(automation?.nextRunAt);
  return next && next.getTime() > Date.now() ? next : null;
}

function renderRuntimeRibbon() {
  const automations = activeAutomationsOf();
  const running = tasksOf().filter((task) => statusKey(task.status) === "running").length;
  const standby = automations.filter((item) => text(item.status, "").toUpperCase() === "ACTIVE" && executionKey(item) !== "running").length;
  const cloud = automations.filter((item) => item.cloud === true).length;
  const next = automations
    .map((item) => ({ item, at: localNextTime(item) }))
    .filter(({ at }) => at)
    .sort((a, b) => a.at - b.at)[0];
  ui.trailRunning.textContent = String(running);
  ui.trailStandby.textContent = String(standby);
  ui.trailCloud.textContent = String(cloud);
  ui.scheduleInboxCount.textContent = String(automations.length);
  ui.trailNextLocal.textContent = next
    ? `下一次本机计划：${formatDate(next.at.toISOString())} · ${relativeTime(next.at.toISOString())}`
    : "下一次本机计划：未提供";
}

function automationThreadUrl(automation) {
  if (automation?.threadUrl) return safeUrl(automation.threadUrl);
  if (!automation?.cloud && typeof automation?.threadId === "string" && automation.threadId) {
    return `codex://threads/${encodeURIComponent(automation.threadId)}`;
  }
  return "";
}

function selectAutomation(automationId, { focusScene = false } = {}) {
  const automation = activeAutomationsOf().find((item) => item?.id === automationId);
  if (!automation) return;
  const wantedSource = automation.cloud === true ? "cloud" : "local";
  if (state.automationSource !== "all" && state.automationSource !== wantedSource) state.automationSource = wantedSource;
  state.selectedAutomationId = automation.id;
  state.scrollAutomationToSelection = true;
  openProgress("automation", automation.id);
  setTab("automations");
  renderAutomations();
  if (focusScene) {
    state.manor?.focusAutomation?.(automation.id);
  }
}

function updateLedgerTotal() {
  const inbox = state.data?.inbox || {};
  const accepted = Number.isFinite(inbox.acceptedCount) ? inbox.acceptedCount : inboxOf().filter((item) => item.status === "accepted").length;
  const pending = Number.isFinite(inbox.pendingCount) ? inbox.pendingCount : inboxOf().filter((item) => item.status !== "accepted").length;
  const labels = {
    tasks: `${tasksOf().length} 个委托`,
    inbox: `${pending} 个待验收`,
    automations: `${activeAutomationsOf().length} 个当前计划`,
    artifacts: `${accepted} 个已验收`,
  };
  ui.total.textContent = labels[state.tab] || "0 项";
}

function renderTaskCard(task) {
  const status = statusKey(task.status);
  const selected = state.selectedTaskId === task.id;
  const card = makeElement("article", `record-card task-card${selected ? " is-selected" : ""}`);
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-expanded", String(selected));
  card.setAttribute("aria-label", `${text(task.title, "未命名任务")}，${STATUS_LABELS[status]}，${selected ? "收起详情" : "展开详情"}`);
  card.dataset.taskId = text(task.id, "");

  const meta = makeElement("div", "card-meta");
  const left = makeElement("span", "source-tag", task.source === "chatgpt" ? "ChatGPT 快照" : "Codex");
  const right = makeElement("span", `status-pill status-${status}`, STATUS_LABELS[status]);
  meta.append(left, right);
  const heading = makeElement("h3", "", text(task.title, "未命名任务"));
  const subline = makeElement("p", "", `${projectName(task.project)} · ${formatDate(task.updatedAt)}`);
  card.append(meta, heading, subline);
  if (selected) card.append(renderTaskDetail(task));
  return card;
}

function renderTaskDetail(task) {
  const detail = makeElement("div", "task-detail");
  const description = text(task.summary, text(task.statusDetail, "没有附加摘要。"));
  detail.append(makeElement("p", "", description));
  const details = document.createElement("dl");
  const rows = [["状态说明", text(task.statusDetail, STATUS_LABELS[statusKey(task.status)])], ["项目", projectName(task.project)], ["模型", text(task.model, "未提供")], ["更新", formatDate(task.updatedAt, "long")]];
  rows.forEach(([key, value]) => {
    details.append(makeElement("dt", "", key), makeElement("dd", "", value));
  });
  detail.append(details);

  const actions = makeElement("div", "detail-actions");
  const copy = makeElement("button", "mini-button", "复制摘要");
  copy.type = "button";
  copy.dataset.copySummary = `${text(task.title, "未命名任务")}\n状态：${STATUS_LABELS[statusKey(task.status)]}\n项目：${projectName(task.project)}\n${description}`;
  actions.append(copy);
  if (task.threadUrl) {
    const open = makeElement("button", "mini-button", "打开原任务 ↗");
    open.type = "button";
    open.dataset.openUrl = task.threadUrl;
    actions.append(open);
  }
  detail.append(actions);
  return detail;
}

function renderTasks() {
  const filtered = currentFilteredTasks();
  ui.taskList.replaceChildren();
  ui.filterSummary.textContent = `显示 ${filtered.length} / ${tasksOf().length} 项任务`;
  if (!filtered.length) {
    const searchCopy = state.search ? "换个关键词，或清除搜索条件再试。" : "当前来源还没有可显示的任务记录。";
    ui.taskList.append(emptyState("没有找到委托", searchCopy));
    return;
  }
  filtered.forEach((task) => ui.taskList.append(renderTaskCard(task)));
}

function renderAutomations() {
  const preservedScroll = ui.automationList.scrollTop;
  ui.automationList.replaceChildren();
  let automations = activeAutomationsOf().filter((item) => state.automationSource === "all"
    || (state.automationSource === "cloud" ? item.cloud === true : item.cloud !== true));
  const selectedIndex = automations.findIndex((item) => item?.id === state.selectedAutomationId);
  if (selectedIndex > 0) automations = [automations[selectedIndex], ...automations.slice(0, selectedIndex), ...automations.slice(selectedIndex + 1)];
  ui.automationFilters.forEach((button) => button.classList.toggle("is-active", button.dataset.automationSource === state.automationSource));
  renderCloudSyncNote();
  if (!automations.length) {
    ui.automationList.append(emptyState("暂无当前计划", state.automationSource === "cloud" ? "云端快照暂未提供已启用的当前计划。" : "当本机记录提供已启用计划时，会显示在这里。"));
    return;
  }
  automations.forEach((automation) => ui.automationList.append(renderAutomationCard(automation)));
  if (!state.scrollAutomationToSelection) {
    ui.automationList.scrollTop = preservedScroll;
    return;
  }
  state.scrollAutomationToSelection = false;
  ui.automationList.scrollTop = 0;
}

function latestAutomationResult(automation) {
  return Array.isArray(automation?.results) && automation.results[0] && typeof automation.results[0] === "object"
    ? automation.results[0] : null;
}

function resultStatusLabel(result) {
  if (result?.status === "accepted") return "已验收";
  if (result?.status === "unread") return "未读";
  return "待验收";
}

function resultStatusClass(result) {
  if (result?.status === "accepted") return "status-completed";
  if (result?.status === "unread") return "status-waiting";
  return "status-idle";
}

function compactResultBody(body, limit = 190) {
  const normalized = String(body || "").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit).trimEnd()}…` : normalized;
}

function renderAutomationResult(automation, result) {
  if (!result) {
    const suffix = automation?.resultAvailability === "unavailable" ? "（结果来源暂不可用）" : "";
    return makeElement("p", "automation-no-result", `暂未读取到产出${suffix}`);
  }
  const resultId = text(result.id, "");
  const expanded = Boolean(resultId && state.expandedAutomationResultIds.has(resultId));
  const block = makeElement("section", "automation-result");
  const heading = makeElement("div", "automation-result-heading");
  heading.append(makeElement("span", "automation-result-label", "最新产出"), makeElement("span", `status-pill ${resultStatusClass(result)}`, resultStatusLabel(result)));
  block.append(heading, makeElement("strong", "", text(result.title, "最新结果")));
  const body = typeof result.body === "string" ? result.body.trim() : "";
  if (body) block.append(makeElement("p", "automation-result-summary", compactResultBody(body)));
  block.append(makeElement("p", "automation-result-meta", `${result.createdAt ? formatDate(result.createdAt) : "时间未提供"}${result.provenance ? ` · ${text(result.provenance)}` : ""}`));
  const actions = makeElement("div", "detail-actions");
  if (body && resultId) {
    const toggle = makeElement("button", "mini-button", expanded ? "收起正文" : "展开正文");
    toggle.type = "button";
    toggle.dataset.automationResultToggle = resultId;
    actions.append(toggle);
  }
  const resultUrl = safeUrl(result.threadUrl);
  if (resultUrl) {
    const open = makeElement("button", "mini-button", "打开原结果 ↗");
    open.type = "button";
    open.dataset.openUrl = resultUrl;
    actions.append(open);
  }
  if (resultId) {
    const acceptance = makeElement("button", result.status === "accepted" ? "mini-button" : "mini-button accept", result.status === "accepted" ? "恢复待验收" : "验收完成");
    acceptance.type = "button";
    acceptance.dataset[result.status === "accepted" ? "reopen" : "accept"] = resultId;
    actions.append(acceptance);
  }
  if (actions.childElementCount) block.append(actions);
  if (expanded && body) block.append(makeElement("div", "result-body", body));
  return block;
}

function renderAutomationCard(automation) {
  const execution = executionKey(automation);
  const selected = state.selectedAutomationId === automation.id;
  const result = latestAutomationResult(automation);
  const card = makeElement("article", `record-card automation-card${selected ? " is-selected" : ""}`);
  card.dataset.automationId = text(automation.id, "");
  const meta = makeElement("div", "card-meta");
  const source = automation.cloud ? "云端快照" : (automation.source === "chatgpt" ? "ChatGPT 本机" : "Codex 本机");
  meta.append(makeElement("span", "source-tag", source), makeElement("span", `status-pill status-${execution}`, EXECUTION_LABELS[execution]));
  card.append(meta, makeElement("h3", "", text(automation.name, "未命名自动化")), renderAutomationResult(automation, result));
  const detail = makeElement("div", "task-detail");
  const next = text(automation.nextDisplay, "") || (automation.nextRunAt ? `${formatDate(automation.nextRunAt)}（${relativeTime(automation.nextRunAt)}）` : "未提供");
  detail.append(makeElement("p", "", `已启用 · ${EXECUTION_LABELS[execution]} · 下次：${next}`));
  detail.append(makeElement("p", "automation-schedule", `安排：${text(automation.scheduleLabel, automationScheduleLabel(automation.schedule))}`));
  if (automation.cloud) {
    const freshness = automation.freshness === "stale" ? "已过期" : "快照";
    const observation = automation.resultsObservedAt
      ? `结果采集于 ${formatDate(automation.resultsObservedAt)}`
      : `计划采集于 ${automation.observedAt ? formatDate(automation.observedAt) : "时间未提供"} · 暂未读取到产出`;
    detail.append(makeElement("p", `automation-freshness ${automation.freshness === "stale" ? "is-stale" : ""}`, `云端${freshness} · ${observation} · 非实时`));
  }
  const actions = makeElement("div", "detail-actions");
  const village = makeElement("button", "mini-button", "找到小院");
  village.type = "button";
  village.dataset.focusAutomation = text(automation.id, "");
  actions.append(village);
  const threadUrl = automationThreadUrl(automation);
  if (threadUrl) {
    const open = makeElement("button", "mini-button", "打开原计划 ↗");
    open.type = "button";
    open.dataset.openUrl = threadUrl;
    actions.append(open);
  }
  detail.append(actions);
  card.append(detail);
  return card;
}

function automationResultById(resultId) {
  for (const automation of activeAutomationsOf()) {
    const result = latestAutomationResult(automation);
    if (result?.id === resultId) return result;
  }
  return null;
}

function renderCloudSyncNote() {
  const sync = state.data?.cloudSync;
  if (!sync || state.automationSource === "local") {
    ui.cloudSyncNote.hidden = true;
    return;
  }
  const stale = sync.stale === true || sync.freshness === "stale";
  const availability = sync.available === false ? "暂不可用" : stale ? "已过期" : "可读取";
  const observed = sync.observedAt ? `采集于 ${formatDate(sync.observedAt)}` : "采集时间未提供";
  ui.cloudSyncNote.textContent = `云端${availability} · ${observed} · 非实时快照${text(sync.message, "") ? ` · ${text(sync.message)}` : ""}`;
  ui.cloudSyncNote.classList.toggle("is-stale", stale || sync.available === false);
  ui.cloudSyncNote.hidden = false;
}

function renderInboxCard(item, { accepted = false } = {}) {
  const selected = state.selectedInboxId === item.id;
  const card = makeElement("article", `record-card inbox-card${selected ? " is-selected" : ""}`);
  card.dataset.inboxId = text(item.id, "");
  const summary = makeElement("button", "inbox-summary");
  summary.type = "button";
  summary.dataset.inboxToggle = text(item.id, "");
  summary.setAttribute("aria-expanded", String(selected));
  summary.setAttribute("aria-label", `${text(item.title, "未命名礼盒")}，${selected ? "收起正文" : "展开正文"}`);
  const meta = makeElement("div", "card-meta");
  const source = item.source === "chatgpt" ? "ChatGPT" : "Codex";
  const status = accepted ? "已验收" : item.status === "unread" ? "未拆" : "待验收";
  meta.append(makeElement("span", "source-tag", source), makeElement("span", `status-pill ${accepted ? "status-completed" : item.status === "unread" ? "status-waiting" : "status-idle"}`, status));
  summary.append(meta, makeElement("h3", "", text(item.title, "未命名礼盒")), makeElement("p", "", `${text(item.summary, "没有附加摘要。 ")} · ${formatDate(item.createdAt)}`));
  card.append(summary);
  if (!selected) return card;

  const hasBody = typeof item.body === "string" && Boolean(item.body.trim());
  const body = hasBody ? item.body.trim() : "这份聊天记录没有可读取正文，暂不能制作礼盒。";
  card.append(makeElement("div", `result-body${hasBody ? "" : " is-unavailable"}`, body));
  const actions = makeElement("div", "result-actions");
  if (item.threadUrl) {
    const openTask = makeElement("button", "", "打开原任务 ↗");
    openTask.type = "button";
    openTask.dataset.openUrl = item.threadUrl;
    actions.append(openTask);
  }
  (Array.isArray(item.artifacts) ? item.artifacts : []).forEach((artifact) => {
    if (!artifact?.id) return;
    const openArtifact = makeElement("button", "", `在访达中查看 ${text(artifact.name, "文件")} ↗`);
    openArtifact.type = "button";
    openArtifact.dataset.openArtifact = artifact.id;
    openArtifact.dataset.resultId = item.id;
    actions.append(openArtifact);
  });
  const acceptance = makeElement("button", accepted ? "" : "accept", accepted ? "恢复待验收" : "验收完成");
  acceptance.type = "button";
  acceptance.dataset[accepted ? "reopen" : "accept"] = item.id;
  actions.append(acceptance);
  card.append(actions);
  return card;
}

function renderInbox() {
  ui.inboxList.replaceChildren();
  const items = inboxOf().filter((item) => item.status !== "accepted");
  if (!items.length) {
    ui.inboxList.append(emptyState("没有待拆礼盒", "新礼盒会在这里等待你打开与验收。"));
    return;
  }
  items.forEach((item) => ui.inboxList.append(renderInboxCard(item)));
}

function renderArtifacts() {
  ui.artifactList.replaceChildren();
  const accepted = inboxOf().filter((item) => item.status === "accepted");
  if (!accepted.length) {
    ui.artifactList.append(emptyState("尚无已验收结果", "任务完成不等于验收完成；确认后的文字或文件结果会留在这里。"));
    return;
  }
  accepted.forEach((item) => ui.artifactList.append(renderInboxCard(item, { accepted: true })));
}

function renderEvents() {
  ui.activityList.replaceChildren();
  const events = Array.isArray(state.data?.events) ? [...state.data.events] : [];
  events.sort((a, b) => (parseDate(b.at)?.getTime() || 0) - (parseDate(a.at)?.getTime() || 0));
  if (!events.length) {
    const item = makeElement("li", "empty-row", "尚无实际事件记录");
    ui.activityList.append(item);
    return;
  }
  events.slice(0, 4).forEach((event) => {
    const item = document.createElement("li");
    item.append(makeElement("i"), makeElement("span", "", text(event.label, text(event.type, "未命名事件"))));
    const time = makeElement("time", "", relativeTime(event.at));
    time.dateTime = text(event.at, "");
    item.append(time);
    ui.activityList.append(item);
  });
}

function progressTargetRecord() {
  if (!state.progressTarget) return null;
  if (state.progressTarget.kind === "source") {
    return tasksOf().filter((item) => item?.source === state.progressTarget.source)
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || (parseDate(b.updatedAt)?.getTime() || 0) - (parseDate(a.updatedAt)?.getTime() || 0))[0] || null;
  }
  return state.progressTarget.kind === "automation"
    ? activeAutomationsOf().find((item) => item?.id === state.progressTarget.id)
    : tasksOf().find((item) => item?.id === state.progressTarget.id);
}
function openProgress(kind, id) {
  if (document.documentElement.dataset.desktopMode === "mini") requestWindowMode("full");
  state.progressTarget = { kind, id }; state.progressClosed = false; state.progressExpanded = false; renderProgress();
}
function openSourceProgress(source) {
  if (document.documentElement.dataset.desktopMode === "mini") requestWindowMode("full");
  const record = tasksOf().filter((item) => item?.source === source)
    .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || (parseDate(b.updatedAt)?.getTime() || 0) - (parseDate(a.updatedAt)?.getTime() || 0))[0];
  state.progressTarget = record ? { kind: "task", id: record.id } : { kind: "source", source };
  state.progressClosed = false; state.progressExpanded = false; renderProgress();
}
function renderProgress() {
  const record = progressTargetRecord();
  if (state.progressClosed || (!record && state.progressTarget?.kind !== "source")) { ui.progressCard.hidden = true; return; }
  if (!record) {
    const source = state.progressTarget.source;
    ui.progressCard.hidden = false;ui.progressCard.classList.remove("is-expanded");ui.progressCard.style.maxHeight = "300px";ui.progressTitle.textContent = source === "chatgpt" ? "ChatGPT 书屋" : "Codex 工坊";
    ui.progressMeta.textContent = source === "chatgpt" ? "云端执行过程暂不可读取。" : "暂无当前本机任务过程。";ui.progressEvents.replaceChildren();ui.progressExpand.hidden = true;ui.progressSelect.hidden = true;return;
  }
  const hasProgress = record.progress && typeof record.progress === "object";
  const progress = hasProgress ? record.progress : {};
  ui.progressCard.hidden = false;
  ui.progressTitle.textContent = text(record.title || record.name, "未命名任务");
  ui.progressEvents.replaceChildren();
  const available = progress.availability === "available";
  const phaseLabels = { running: "本次运行中", waiting: "等待处理或审批", completed: "本轮已结束", failed: "本轮失败", interrupted: "本轮已中断", unknown: "状态未确认" };
  const cloud = record.cloud === true || record.source === "chatgpt";
  if (available) {
    const message = text(progress.message, "");
    const suffix = message.includes("关联任务") ? "关联任务进展" : progress.truncated ? "最近可读记录" : "";
    ui.progressMeta.textContent = [phaseLabels[progress.phase] || "状态未确认", formatDate(progress.updatedAt), suffix].filter(Boolean).join(" · ");
    ui.progressMeta.title = message;
  } else { ui.progressMeta.textContent = text(progress.message, cloud ? "云端执行过程暂不可读取。" : hasProgress ? "本机过程暂不可读取。" : "暂未读取到本轮过程。");ui.progressMeta.title = text(progress.message, ""); }
  const events = available && Array.isArray(progress.events) ? progress.events : [];
  const shown = state.progressExpanded ? events.slice(-12) : events.slice(-4);
  if (available && !shown.length) ui.progressEvents.append(makeElement("li", "", "本轮尚无可展示的公开过程。"));
  shown.forEach((event) => { const item = makeElement("li", "", text(event.label, "过程更新")); const detail = event.detail ? makeElement("small", "progress-detail", text(event.detail, "")) : null; if(detail && !state.progressExpanded){detail.style.display="-webkit-box";detail.style.webkitBoxOrient="vertical";detail.style.webkitLineClamp="3";detail.style.overflow="hidden";} item.append(makeElement("time", "", formatDate(event.at)), detail || document.createTextNode("")); ui.progressEvents.append(item); });
  ui.progressExpand.hidden = !available || (events.length <= 4 && !events.some((event) => text(event?.detail, "")));
  ui.progressExpand.style.position = "sticky";ui.progressExpand.style.bottom = "0";ui.progressExpand.style.background = state.theme === "night" ? "#2a263a" : "rgba(255,253,249,.96)";
  ui.progressCard.classList.toggle("is-expanded", state.progressExpanded);ui.progressCard.style.maxHeight = state.progressExpanded ? "380px" : "300px";
  ui.progressExpand.textContent = state.progressExpanded ? "收起过程" : "展开完整记录";
  const running = tasksOf().filter((task) => task?.source === "codex" && task?.status === "running");
  const canSelect = (state.progressTarget.kind === "source" && state.progressTarget.source === "codex") || (state.progressTarget.kind === "task" && record.source === "codex");
  const choices = running.some((task) => task.id === record.id) ? running : [...running, record];
  ui.progressSelect.hidden = !canSelect || running.length < 2;
  if (!ui.progressSelect.hidden) { ui.progressSelect.replaceChildren(...choices.map((task) => { const option = document.createElement("option"); option.value = task.id; option.textContent = text(task.title, "未命名任务"); option.selected = task.id === record.id; return option; })); }
}

function render() {
  renderOverview();
  renderTasks();
  renderInbox();
  renderAutomations();
  renderArtifacts();
  renderEvents();
  renderProgress();
  updateTabs();
}

function updateTabs() {
  ui.tabs.forEach((tab) => {
    const active = tab.dataset.tab === state.tab;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  ui.panels.forEach((panel) => { panel.hidden = panel.id !== `panel-${state.tab}`; });
  updateLedgerTotal();
}

function setTab(tab) {
  if (!['tasks', 'inbox', 'automations', 'artifacts'].includes(tab)) return;
  state.tab = tab;
  updateTabs();
}

async function copySummary(button) {
  const value = button.dataset.copySummary || "";
  const original = button.textContent;
  try {
    await requestDesktop("clipboard", { text: value });
    button.textContent = "已复制";
  } catch (_) {
    button.textContent = "复制失败，请手动选取摘要";
  }
  window.setTimeout(() => { button.textContent = original; }, 1600);
}

async function handleInboxInteraction(event) {
  const action = event.target.closest("[data-open-url], [data-open-artifact], [data-accept], [data-reopen]");
  if (action) {
    try {
      if (action.dataset.openUrl) await requestDesktop("open_url", { url: action.dataset.openUrl });
      else if (action.dataset.openArtifact) await requestDesktop("open_artifact", { resultId: action.dataset.resultId, artifactId: action.dataset.openArtifact });
      else if (action.dataset.accept) await requestDesktop("accept", { id: action.dataset.accept });
      else if (action.dataset.reopen) await requestDesktop("reopen", { id: action.dataset.reopen });
    } catch (_) { /* Native actions leave the existing card intact on failure. */ }
    return;
  }
  const summary = event.target.closest("[data-inbox-toggle]");
  if (!summary) return;
  const item = inboxOf().find((candidate) => candidate.id === summary.dataset.inboxToggle);
  state.selectedInboxId = state.selectedInboxId === summary.dataset.inboxToggle ? null : summary.dataset.inboxToggle;
  renderInbox();
  renderArtifacts();
  if (item?.status === "unread" && state.selectedInboxId) {
    try { await requestDesktop("mark_read", { id: item.id }); } catch (_) { /* It remains readable even if the mark is delayed. */ }
  }
}

async function handleListInteraction(event) {
  const copy = event.target.closest("[data-copy-summary]");
  if (copy) { copySummary(copy); return; }
  const openTask = event.target.closest("[data-open-url]");
  if (openTask) {
    try { await requestDesktop("open_url", { url: openTask.dataset.openUrl }); } catch (_) { /* Keep the detail card open. */ }
    return;
  }
  const taskCard = event.target.closest(".task-card");
  if (!taskCard || event.target.closest("a, button")) return;
  const id = taskCard.dataset.taskId;
  state.selectedTaskId = state.selectedTaskId === id ? null : id;
  renderTasks();
  if (state.selectedTaskId) openProgress("task", id);
}

function handleTaskKeydown(event) {
  if (!["Enter", " "].includes(event.key)) return;
  const taskCard = event.target.closest(".task-card");
  if (!taskCard || event.target.closest("a, button")) return;
  event.preventDefault();
  handleListInteraction(event);
}

function setTheme(theme) {
  state.theme = theme === "night" ? "night" : "day";
  localStorage.setItem("star-sugar-theme", state.theme);
  ui.body.dataset.theme = state.theme;
  ui.theme.setAttribute("aria-pressed", String(state.theme === "night"));
  ui.theme.replaceChildren();
  ui.theme.append(document.createTextNode(state.theme === "night" ? "☀ " : "☾ "));
  ui.theme.append(makeElement("span", "", state.theme === "night" ? "日间" : "星光"));
  state.manor?.setTheme?.(state.theme);
}

function setPaused(paused) {
  state.animationPaused = Boolean(paused);
  localStorage.setItem("star-sugar-animation-paused", String(state.animationPaused));
  ui.pause.setAttribute("aria-pressed", String(state.animationPaused));
  ui.pause.replaceChildren();
  ui.pause.append(document.createTextNode(state.animationPaused ? "▶ " : "Ⅱ "));
  ui.pause.append(makeElement("span", "", state.animationPaused ? "恢复动画" : "暂停动画"));
  state.manor?.setPaused?.(state.animationPaused);
}

function setOwnerAvatarState(status) {
  if (status === "ready") {
    ui.focusOwner.disabled = false;
    ui.focusOwner.title = "在庄园中找到我";
    ui.ownerAvatarStatus.hidden = true;
    return;
  }
  ui.focusOwner.disabled = true;
  ui.ownerAvatarStatus.hidden = false;
  if (status === "error") {
    ui.focusOwner.title = "角色暂时未能抵达庄园";
    ui.ownerAvatarStatus.textContent = "角色暂时未能抵达庄园。";
    return;
  }
  ui.focusOwner.title = "正在准备庄园主人";
  ui.ownerAvatarStatus.textContent = "正在准备庄园主人…";
}

function normalizeIncoming(input) {
  const result = input && typeof input === "object" ? input : {};
  return {
    generatedAt: result.generatedAt || null,
    sources: Array.isArray(result.sources) ? result.sources : [],
    tasks: Array.isArray(result.tasks) ? result.tasks : [],
    automations: Array.isArray(result.automations) ? result.automations : [],
    cloudSync: result.cloudSync && typeof result.cloudSync === "object" ? result.cloudSync : null,
    projects: Array.isArray(result.projects) ? result.projects : [],
    events: Array.isArray(result.events) ? result.events : [],
    scope: result.scope && typeof result.scope === "object" ? result.scope : {},
    inbox: result.inbox && typeof result.inbox === "object" ? {
      items: Array.isArray(result.inbox.items) ? result.inbox.items : [],
      pendingCount: Number.isFinite(result.inbox.pendingCount) ? result.inbox.pendingCount : 0,
      unreadCount: Number.isFinite(result.inbox.unreadCount) ? result.inbox.unreadCount : 0,
      acceptedCount: Number.isFinite(result.inbox.acceptedCount) ? result.inbox.acceptedCount : 0,
    } : { items: [], pendingCount: 0, unreadCount: 0, acceptedCount: 0 },
  };
}

function scopeMessage(scope) {
  const values = Object.values(scope || {}).filter((value) => typeof value === "string" && value.trim());
  return values.join(" · ");
}

function applyDesktopState(incoming) {
  state.data = normalizeIncoming(incoming);
  if (state.selectedAutomationId && !activeAutomationsOf().some((item) => item?.id === state.selectedAutomationId)) {
    state.selectedAutomationId = null;
  }
  state.failedRefreshes = 0;
  setConnection("ok", "庄园已连接", "正在更新庄园记录");
  ui.staleNotice.hidden = true;
  render();
  state.manor?.setData?.(state.data);
  desktop.request("badge", { count: state.data.inbox.pendingCount }).catch(() => {});
}

async function requestDesktop(method, params = {}) {
  if (!hasDesktopBridge) throw new Error("desktop bridge unavailable");
  const response = await desktop.request(method, params);
  if (response && typeof response === "object" && (Array.isArray(response.tasks) || response.inbox)) applyDesktopState(response);
  return response;
}

async function fetchState({ manual = false } = {}) {
  if (state.inFlight) return;
  state.inFlight = true;
  ui.refresh.disabled = true;
  ui.refresh.setAttribute("aria-busy", "true");
  try {
    await requestDesktop("state");
  } catch (_) {
    state.failedRefreshes += 1;
    if (state.data) {
      setConnection("stale", "保留记录", "暂时无法更新庄园记录");
      ui.staleNotice.hidden = false;
      ui.staleMessage.textContent = "暂时无法更新，正在继续等待。";
    } else {
      setConnection("error", "庄园暂不可用", "暂时无法取得庄园记录");
      ui.staleNotice.hidden = false;
      ui.staleMessage.textContent = "庄园记录暂时未能送达，稍后会再试。";
      state.data = normalizeIncoming({});
      render();
    }
  } finally {
    state.inFlight = false;
    ui.refresh.disabled = false;
    ui.refresh.removeAttribute("aria-busy");
    if (manual) ui.refresh.focus({ preventScroll: true });
  }
}

function restartPolling({ immediate = false } = {}) {
  if (state.timer) window.clearInterval(state.timer);
  state.timer = null;
  if (document.hidden || !state.visible) return;
  if (immediate) fetchState();
  state.timer = window.setInterval(() => fetchState(), POLL_MS);
}

function setDesktopMode(mode) {
  const next = mode === "mini" ? "mini" : "full";
  document.documentElement.dataset.desktopMode = next;
  ui.desktopMode.title = next === "mini" ? "展开完整委托簿" : "收起为迷你庄园";
  ui.desktopMode.setAttribute("aria-label", ui.desktopMode.title);
  ui.desktopMode.replaceChildren(document.createTextNode(next === "mini" ? "↗ " : "↙ "), makeElement("span", "", next === "mini" ? "展开" : "收起"));
}

async function requestWindowMode(mode) {
  setDesktopMode(mode);
  try { await requestDesktop("window", { mode }); } catch (_) { /* Keep the current view readable. */ }
}

function openInbox() {
  setTab("inbox");
  if (document.documentElement.dataset.desktopMode === "mini") requestWindowMode("full");
}

function openScheduleInbox() {
  state.automationSource = "all";
  setTab("automations");
  renderAutomations();
  if (document.documentElement.dataset.desktopMode === "mini") requestWindowMode("full");
}

async function initScene() {
  try {
    const module = await import("/scene.js");
    if (typeof module.createManorScene !== "function") throw new Error("场景接口未准备好");
    state.manor = module.createManorScene({
      container: document.querySelector("#manor-scene"),
      onSelect: (selection) => {
        if (!selection) return;
        if (selection.kind === "schedule") {
          selectAutomation(selection.id);
          return;
        }
        if (selection.kind === "inbox" || selection.id === "inbox") {
          openInbox();
          return;
        }
        if (selection.kind === "automation" || selection.id === "automation") {
          state.automationSource = selection.filter === "local" || selection.id === "greenhouse" ? "local" : "all";
          setTab("automations");
          renderAutomations();
          return;
        }
        if (selection.kind === "cloud" || selection.id === "cloudstation") {
          state.automationSource = "cloud";
          setTab("automations");
          renderAutomations();
          return;
        }
        if (selection.kind === "warehouse" || selection.id === "warehouse") {
          setTab("artifacts");
          return;
        }
        setTab("tasks");
        if (["codex", "chatgpt"].includes(selection.filter || selection.id)) {
          state.source = selection.filter || selection.id;
          ui.sourceFilter.value = state.source;
          renderTasks();
          openSourceProgress(selection.filter || selection.id);
        }
        if (selection.id && tasksOf().some((task) => task.id === selection.id)) {
          state.selectedTaskId = selection.id;
          renderTasks();
        }
      },
    });
    state.manor.setTheme?.(state.theme);
    state.manor.setPaused?.(state.animationPaused);
    state.manor.setVisible?.(state.visible && !document.hidden);
    if (state.data) state.manor.setData?.(state.data);
    document.querySelector("#manor-scene").setAttribute("aria-busy", "false");
  } catch (error) {
    ui.sceneUnavailable.hidden = false;
    setOwnerAvatarState("error");
    document.querySelector("#manor-scene").setAttribute("aria-busy", "false");
    console.warn("Star Sugar Manor scene unavailable:", error);
  }
}

function bindEvents() {
  ui.refresh.addEventListener("click", () => fetchState({ manual: true }));
  ui.theme.addEventListener("click", () => setTheme(state.theme === "day" ? "night" : "day"));
  ui.pause.addEventListener("click", () => setPaused(!state.animationPaused));
  ui.resetView.addEventListener("click", () => state.manor?.resetView?.());
  ui.focusOwner.addEventListener("click", () => state.manor?.focusOwner?.());
  ui.scheduleInbox.addEventListener("click", openScheduleInbox);
  ui.desktopMode.addEventListener("click", () => requestWindowMode(document.documentElement.dataset.desktopMode === "mini" ? "full" : "mini"));
  ui.miniInbox.addEventListener("click", openInbox);
  ui.progressClose.addEventListener("click", () => { state.progressClosed = true; ui.progressCard.hidden = true; });
  ui.progressExpand.addEventListener("click", () => { state.progressExpanded = !state.progressExpanded; renderProgress(); });
  ui.progressSelect.addEventListener("change", () => openProgress("task", ui.progressSelect.value));
  document.querySelector("#manor-scene").addEventListener("owner-avatar-state", (event) => {
    setOwnerAvatarState(event.detail?.status);
  });
  ui.sourceFilter.addEventListener("change", (event) => { state.source = event.target.value; renderTasks(); });
  ui.search.addEventListener("input", (event) => { state.search = event.target.value; renderTasks(); });
  ui.taskList.addEventListener("click", handleListInteraction);
  ui.taskList.addEventListener("keydown", handleTaskKeydown);
  ui.inboxList.addEventListener("click", handleInboxInteraction);
  ui.artifactList.addEventListener("click", handleInboxInteraction);
  ui.automationFilters.forEach((button) => button.addEventListener("click", () => {
    state.automationSource = button.dataset.automationSource || "all";
    renderAutomations();
  }));
  ui.automationList.addEventListener("click", async (event) => {
    const open = event.target.closest("[data-open-url]");
    if (open) {
      requestDesktop("open_url", { url: open.dataset.openUrl }).catch(() => {});
      return;
    }
    const toggleResult = event.target.closest("[data-automation-result-toggle]");
    if (toggleResult) {
      const resultId = toggleResult.dataset.automationResultToggle;
      const result = automationResultById(resultId);
      if (state.expandedAutomationResultIds.has(resultId)) state.expandedAutomationResultIds.delete(resultId);
      else state.expandedAutomationResultIds.add(resultId);
      renderAutomations();
      if (result?.status === "unread" && state.expandedAutomationResultIds.has(resultId)) {
        try { await requestDesktop("mark_read", { id: resultId }); } catch (_) { /* The body remains open if marking read is delayed. */ }
      }
      return;
    }
    const accept = event.target.closest("[data-accept], [data-reopen]");
    if (accept) {
      try {
        if (accept.dataset.accept) await requestDesktop("accept", { id: accept.dataset.accept });
        else await requestDesktop("reopen", { id: accept.dataset.reopen });
      } catch (_) { /* Review state remains unchanged until the bridge confirms it. */ }
      return;
    }
    const focus = event.target.closest("[data-focus-automation]");
    if (focus) selectAutomation(focus.dataset.focusAutomation, { focusScene: true });
  });
  ui.openCloudSchedules.addEventListener("click", () => requestDesktop("open_url", { url: "https://chatgpt.com/scheduled" }).catch(() => {}));
  ui.tabs.forEach((tab) => tab.addEventListener("click", () => setTab(tab.dataset.tab)));
  document.addEventListener("visibilitychange", () => {
    state.manor?.setVisible?.(state.visible && !document.hidden);
    if (document.hidden) restartPolling(); else restartPolling({ immediate: true });
  });
  window.addEventListener("manor-desktop-mode", (event) => setDesktopMode(event.detail?.mode));
  window.addEventListener("manor-open-inbox", openInbox);
  window.addEventListener("manor-visibility", (event) => {
    state.visible = Boolean(event.detail?.visible);
    state.manor?.setVisible?.(state.visible && !document.hidden);
    restartPolling({ immediate: state.visible && !document.hidden });
  });
  window.addEventListener("beforeunload", () => state.manor?.dispose?.());
}

if (!hasDesktopBridge) {
  document.body.classList.add("is-non-desktop");
  document.querySelector("#desktop-required").hidden = false;
} else {
  setDesktopMode(document.documentElement.dataset.desktopMode);
  setTheme(state.theme);
  setPaused(state.animationPaused);
  bindEvents();
  render();
  initScene();
  fetchState();
  restartPolling();
}
