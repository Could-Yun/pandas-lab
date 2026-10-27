/* =============================================================
 * PandasLab · 主程序（M1 骨架）
 * -------------------------------------------------------------
 * 启动顺序（"秒开"的关键）：
 *   1. 立刻 fetch 默认数据集 → 用轻量 JS 解析器渲染表格
 *   2. 同时后台启动 Pyodide Worker，进度条可见
 *   3. 引擎就绪后把同一份数据交给 pandas，用真实 dtype / 统计量
 *      覆盖预览期的推断值，并把表格数据源切到 pandas 后端
 * ============================================================= */

import { Engine } from "./assets/js/engine.js?v=3";
import { parseCSV, guessKinds, previewStats } from "./assets/js/csv.js?v=3";
import { DataTable } from "./assets/js/table.js?v=3";
import { I18n, DATASET_LABELS } from "./assets/js/i18n.js?v=3";
import { Pipeline } from "./assets/js/pipeline.js?v=3";
import { OPS } from "./assets/js/ops.js?v=3";
import { openOpPicker, openOpForm } from "./assets/js/opform.js?v=3";
import { suggest, buildRequest, buildOption, corrOption, missingOption } from "./assets/js/charts.js?v=3";

const $ = (id) => document.getElementById(id);

/* 性能埋点：首屏表格可见时刻 / 引擎就绪时刻（毫秒，相对导航开始）
 * 这两个数字是本项目架构选择的核心指标——Pyodide 慢，但用户不应感知到慢 */
const perf = (window.__perf = { tableAt: null, engineAt: null, handoffAt: null });
const mark = (k) => { if (perf[k] == null) perf[k] = Math.round(performance.now()); };

const BUILTIN = [
  { id: "titanic", file: "./assets/datasets/titanic.csv" },
  { id: "iris", file: "./assets/datasets/iris.csv" },
  { id: "gapminder", file: "./assets/datasets/gapminder.csv" },
  { id: "china_cities", file: "./assets/datasets/china_cities.csv" },
];
const DEFAULT_DATASET = "titanic";

const i18n = new I18n();
const engine = new Engine("./worker.js?v=3");

/** 全局状态 */
const state = {
  name: null,          // 当前数据集名
  csvText: null,       // 原始文本（交给 pandas 用）
  preview: null,       // {columns, rows} JS 解析结果
  mode: "preview",     // preview | live
  summary: null,       // pandas 返回的结构化摘要
};

let table;
const pipe = new Pipeline();
let runSeq = 0;              // 防止慢请求覆盖新结果
let baseColumns = [];        // 原始数据集的列（供操作表单选列用）

/* ===================== 启动 ===================== */
async function main() {
  i18n.apply();
  buildDatasetSelect();
  bindUI();

  table = new DataTable({
    head: $("tableHead"),
    body: $("tableBody"),
    rows: $("tableRows"),
    spacer: $("tableSpacer"),
    empty: $("tableEmpty"),
    wrap: $("tableWrap"),
  });
  table.onColumnClick = onColumnsPicked;

  pipe.onChange = () => { renderPipeline(); renderCode(); runPipeline(); };
  renderPipeline();

  wireEngineStatus();

  // 不 await：让引擎在后台加载，前台先把数据显示出来
  loadDataset(DEFAULT_DATASET);
}

/* ===================== 引擎状态 ===================== */
function wireEngineStatus() {
  const badge = $("engineBadge"), dot = $("engineDot"), text = $("engineText"), bar = $("engineBar");

  engine.onStatus = ({ phase, detail, progress }) => {
    if (typeof progress === "number") bar.style.width = `${Math.round(progress * 100)}%`;

    if (phase === "ready") {
      badge.classList.add("ready");
      badge.classList.remove("error");
      text.textContent = i18n.t("engineReady", detail.replace(/^pandas\s*/, ""));
      badge.title = detail;
      mark("engineAt");
      onEngineReady();
    } else if (phase === "error") {
      badge.classList.add("error");
      text.textContent = i18n.t("engineError");
      badge.title = detail;
      toast(`${i18n.t("engineError")}: ${detail}`, true);
      console.error("[engine]", detail);
    } else {
      const map = {
        "pyodide-core": "engineDownloading",
        "runtime-ready": "enginePandas",
        "pandas": "enginePandas",
        "warmup": "engineWarmup",
      };
      text.textContent = i18n.t(map[detail] || "engineBooting");
    }
  };

  engine.onOutput = (kind, txt) => {
    if (kind === "stderr") console.warn("[py]", txt);
    else console.log("[py]", txt);
  };
}

/** 引擎就绪后：把当前数据集交给 pandas，切换到真实后端 */
async function onEngineReady() {
  if (!state.csvText) return;      // 数据还没下完，等 loadDataset 里再推
  await handOffToPandas();
}

async function handOffToPandas() {
  try {
    const t0 = performance.now();
    const summary = await engine.loadCSV(state.name, state.csvText);
    state.summary = summary;
    state.mode = "live";
    baseColumns = summary.columns;

    // 表格数据源切到 pandas：按需请求行切片
    table.setData({
      columns: summary.columns,
      total: summary.rows,
      source: async (start, count) => engine.rows(state.name, start, count),
    });

    updateShape(summary.rows, summary.cols, i18n.t("liveMode"));
    renderCode();
    mark("handoffAt");
    console.log(`[pandas] 接管完成 ${(performance.now() - t0).toFixed(0)}ms` +
      ` | 表格可见 ${perf.tableAt}ms | 引擎就绪 ${perf.engineAt}ms`);
    if (pipe.steps.length) runPipeline();
  } catch (err) {
    console.error(err);
    toast(String(err.message || err), true);
  }
}

/* ===================== 数据集载入 ===================== */
function buildDatasetSelect() {
  // 供操作表单的 dataset 字段使用（merge / concat 要选第二份数据）
  window.__datasets = BUILTIN.map((d) => ({
    id: d.id,
    label: DATASET_LABELS[d.id] ? DATASET_LABELS[d.id][i18n.lang] : d.id,
  }));
  const sel = $("datasetSelect");
  sel.innerHTML = BUILTIN.map((d) => {
    const label = DATASET_LABELS[d.id] ? DATASET_LABELS[d.id][i18n.lang] : d.id;
    return `<option value="${d.id}">${label}</option>`;
  }).join("");
  sel.value = DEFAULT_DATASET;
  sel.addEventListener("change", () => loadDataset(sel.value));
}

async function loadDataset(id) {
  const meta = BUILTIN.find((d) => d.id === id);
  if (!meta) return;
  $("tableEmpty").classList.remove("hidden");
  $("tableEmpty").textContent = i18n.t("loadingData");

  try {
    const res = await fetch(meta.file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    setCSV(id, text);
  } catch (err) {
    console.error(err);
    $("tableEmpty").textContent = i18n.t("loadFailed", id);
    toast(i18n.t("loadFailed", id), true);
  }
}

/** 收到 CSV 文本：先预览渲染，再（若引擎就绪）交给 pandas */
function setCSV(name, text) {
  state.name = name;
  state.csvText = text;
  state.mode = "preview";
  state.summary = null;

  // 换数据集 = 换上下文，旧管道的列可能已不存在，直接清空。
  // 这里直接改字段而不调 pipe.reset()，避免在 pandas 尚未注册该数据集时
  // 就触发一次必然失败的管道执行。
  pipe.datasetName = name;
  pipe.steps = [];
  renderPipeline();

  // —— 秒开路径：JS 解析 + 立即渲染 ——
  const { columns, rows } = parseCSV(text);
  const kinds = guessKinds(columns, rows);
  const stats = previewStats(columns, rows, kinds);
  state.preview = { columns, rows };

  table.setData({
    columns: stats,
    total: rows.length,
    source: async (start, count) => ({
      start,
      index: Array.from({ length: Math.min(count, rows.length - start) }, (_, k) => start + k),
      data: rows.slice(start, start + count).map((r) =>
        r.map((v, ci) => (v === "" ? null : kinds[ci] === "number" && v !== "" && !isNaN(Number(v)) ? Number(v) : v))
      ),
    }),
  });
  baseColumns = stats;
  updateShape(rows.length, columns.length, engine.ready ? i18n.t("liveMode") : i18n.t("previewMode"));
  renderCode();
  mark("tableAt");

  // —— 引擎已就绪就立刻接管；否则等 ready 回调 ——
  if (engine.ready) handOffToPandas();
}

function updateShape(rows, cols, note) {
  $("shapeMain").textContent = i18n.t("rowsCols", rows, cols);
  $("shapeSub").textContent = note ? `· ${note}` : "";
}

/* =============================================================
 * 检视面板：列统计 + 图表
 * ============================================================= */
let statChart = null;
let mainChart = null;
let selectedCols = [];
let chartType = null;

/** 表格列头点击的统一入口（cols 为已选列，0–2 个） */
function onColumnsPicked(cols) {
  selectedCols = cols || [];
  renderColumnPanel();
  renderChartPanel();
}

/* ---------- 列统计 ---------- */
function renderColumnPanel() {
  const p = $("panel-column");
  if (!selectedCols.length) {
    p.innerHTML = `<p class="hint">${escapeHtml(i18n.t("colHint"))}</p>`;
    if (statChart) { statChart.dispose(); statChart = null; }
    return;
  }
  const col = selectedCols[0];
  const num = col.kind === "number";
  const total = state.summary ? state.summary.rows : (state.preview?.rows.length || 0);

  const cells = [
    cell(fmtNum(total), i18n.t("statRows")),
    cell(fmtNum(col.nulls || 0), i18n.t("statNulls")),
    cell(fmtNum(col.unique || 0), i18n.t("statUnique")),
  ];
  if (num) {
    cells.push(cell(fmtNum(col.mean), i18n.t("statMean")));
    cells.push(cell(fmtNum(col.min), i18n.t("statMin")));
    cells.push(cell(fmtNum(col.max), i18n.t("statMax")));
    if (col.std != null) cells.push(cell(fmtNum(col.std), i18n.t("statStd")));
  }

  p.innerHTML = `
    <p class="stat-title">${escapeHtml(col.name)}</p>
    <p class="stat-sub">${escapeHtml(col.dtype || col.kind)} · ${col.kind}</p>
    <div class="stat-grid">${cells.join("")}</div>
    ${col.hist ? `<div class="stat-chart" id="statChart"></div>` : ""}
    ${col.top ? `<div class="stat-sub">${i18n.t("topValues")}</div><div class="top-list">${topList(col.top)}</div>` : ""}`;

  if (col.hist) drawHist(col);
}

function cell(v, label) {
  return `<div class="stat-cell"><b>${v}</b><span>${label}</span></div>`;
}

function topList(top) {
  const max = Math.max(...top.map((t) => t[1])) || 1;
  return top.map(([k, v]) => `
    <div class="top-row">
      <span class="top-key" title="${escapeHtml(k)}">${escapeHtml(k)}</span>
      <span class="top-bar"><i style="width:${(v / max) * 100}%"></i></span>
      <span class="top-val">${fmtNum(v)}</span>
    </div>`).join("");
}

function drawHist(col) {
  const el = $("statChart");
  if (!el) return;
  if (statChart) statChart.dispose();
  statChart = echarts.init(el);
  const labels = col.bins ? col.hist.map((_, i) => sig(col.bins[i])) : col.hist.map((_, i) => i);
  statChart.setOption({
    grid: { left: 42, right: 10, top: 18, bottom: 24 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, confine: true },
    xAxis: { type: "category", data: labels, axisLabel: { fontSize: 9, interval: 4 }, axisTick: { show: false } },
    yAxis: { type: "value", axisLabel: { fontSize: 9 }, splitLine: { lineStyle: { color: "#eef2f7" } } },
    series: [{ type: "bar", data: col.hist, itemStyle: { color: "#156082" }, barCategoryGap: "10%" }],
  });
}

/* ---------- 图表面板 ---------- */
async function renderChartPanel() {
  const p = $("panel-chart");

  if (!selectedCols.length) {
    p.innerHTML = `<p class="hint">${escapeHtml(i18n.t("chartHint"))}</p>
      <div class="chart-quick">
        <button class="btn sm" id="qCorr">${escapeHtml(i18n.t("corrHeatmap"))}</button>
        <button class="btn sm" id="qMissing">${escapeHtml(i18n.t("missingMatrix"))}</button>
      </div>
      <div class="chart-box-lg" id="mainChart"></div>`;
    $("qCorr").addEventListener("click", () => drawSpecial("corr"));
    $("qMissing").addEventListener("click", () => drawSpecial("missing"));
    if (mainChart) { mainChart.dispose(); mainChart = null; }
    return;
  }

  const types = suggest(selectedCols);
  if (!types.length) {
    p.innerHTML = `<p class="hint">${escapeHtml(i18n.t("noChartFor"))}</p>`;
    return;
  }
  if (!types.includes(chartType)) chartType = types[0];

  p.innerHTML = `
    <div class="chart-cols">${selectedCols.map((c, i) =>
      `<span class="chart-col"><i>${i + 1}</i>${escapeHtml(c.name)}<em>${c.kind}</em></span>`).join("")}</div>
    <div class="chart-types">${types.map((ty) =>
      `<button class="chip-btn${ty === chartType ? " on" : ""}" data-ct="${ty}">${escapeHtml(i18n.t("ct." + ty))}</button>`).join("")}</div>
    <div class="chart-box-lg" id="mainChart"></div>
    <p class="chart-note" id="chartNote"></p>`;

  p.querySelectorAll("[data-ct]").forEach((b) =>
    b.addEventListener("click", () => { chartType = b.dataset.ct; renderChartPanel(); }));

  await drawMainChart();
}

async function drawMainChart() {
  if (!engine.ready || !selectedCols.length) return;
  const req = buildRequest(chartType, selectedCols);
  if (!req) return;
  const el = $("mainChart");
  if (!el) return;
  try {
    const data = await engine.chart(req.kind, req.args);
    if (mainChart) mainChart.dispose();
    mainChart = echarts.init(el);
    mainChart.setOption(buildOption(chartType, data, selectedCols, (k) => i18n.t(k)), true);
    const note = $("chartNote");
    if (note) {
      note.textContent = data.total && data.shown && data.total > data.shown
        ? i18n.t("sampled", data.shown, data.total) : "";
    }
  } catch (err) {
    el.innerHTML = `<p class="hint">${escapeHtml(String(err.message || err))}</p>`;
  }
}

/** 相关热力图 / 缺失值矩阵 */
async function drawSpecial(which) {
  if (!engine.ready) { toast(i18n.t("enginePending"), true); return; }
  const el = $("mainChart");
  if (!el) return;
  try {
    const data = await engine.chart(which, {});
    if (mainChart) mainChart.dispose();
    mainChart = echarts.init(el);
    mainChart.setOption(which === "corr" ? corrOption(data) : missingOption(data), true);
  } catch (err) {
    el.innerHTML = `<p class="hint">${escapeHtml(String(err.message || err))}</p>`;
  }
}

/* =============================================================
 * 管道
 * ============================================================= */

function renderPipeline() {
  const el = $("pipeline");
  $("pipelineCount").textContent = pipe.steps.length;
  const ub = $("undoBtn"), rb = $("redoBtn");
  if (ub) ub.disabled = !pipe.canUndo;
  if (rb) rb.disabled = !pipe.canRedo;

  if (!pipe.steps.length) {
    el.innerHTML = `<p class="pipe-empty">${escapeHtml(i18n.t("pipeEmpty"))}</p>`;
    return;
  }

  el.innerHTML = pipe.steps.map((s, i) => {
    const def = OPS[s.op] || {};
    let summary = "";
    try { summary = def.summary ? def.summary(s.params) : ""; } catch { summary = ""; }
    const shape = s.shape
      ? `<div class="step-shape">${fmtNum(s.shape.inRows)} → <b>${fmtNum(s.shape.rows)}</b> × ${s.shape.cols}</div>`
      : "";
    const err = s.error ? `<div class="step-err" title="${escapeHtml(s.error)}">⚠ ${escapeHtml(s.error.slice(0, 56))}</div>` : "";
    return `
      <div class="step-card${s.enabled ? "" : " disabled"}${s.error ? " has-err" : ""}"
           draggable="true" data-id="${s.id}" data-idx="${i}">
        <div class="step-top">
          <span class="step-idx">${i + 1}</span>
          <span class="step-name">${escapeHtml(def.icon || "")} ${escapeHtml(i18n.t("op." + s.op))}</span>
          <span class="step-menu" data-menu="${s.id}">⋮</span>
        </div>
        ${summary ? `<div class="step-detail" title="${escapeHtml(summary)}">${escapeHtml(summary)}</div>` : ""}
        ${shape}${err}
      </div>`;
  }).join("");

  el.querySelectorAll(".step-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.dataset.menu) return;
      editStep(card.dataset.id);
    });
    card.querySelector("[data-menu]").addEventListener("click", (e) => {
      e.stopPropagation();
      stepMenu(card.dataset.id, e.target);
    });
  });

  bindDragReorder(el);
}

/** 管道卡片拖拽重排 */
function bindDragReorder(el) {
  let fromIdx = null;
  el.querySelectorAll(".step-card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      fromIdx = +card.dataset.idx;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.dataset.id);
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      el.querySelectorAll(".step-card").forEach((c) => c.classList.remove("drop-above", "drop-below"));
    });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      const to = +card.dataset.idx;
      card.classList.toggle("drop-above", to < fromIdx);
      card.classList.toggle("drop-below", to > fromIdx);
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-above", "drop-below"));
    card.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation();
      const to = +card.dataset.idx;
      if (fromIdx != null && fromIdx !== to) pipe.move(fromIdx, to);
      fromIdx = null;
    });
  });
}

function stepMenu(id, anchor) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  const s = pipe.steps.find((x) => x.id === id);
  if (!s) return;
  const m = document.createElement("div");
  m.className = "ctx-menu";
  m.innerHTML = `
    <button data-act="edit">${escapeHtml(i18n.t("editStep"))}</button>
    <button data-act="toggle">${escapeHtml(s.enabled ? i18n.t("disableStep") : i18n.t("enableStep"))}</button>
    <button data-act="del" class="danger">${escapeHtml(i18n.t("deleteStep"))}</button>`;
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.min(r.left, innerWidth - 150)}px`;
  m.style.top = `${r.bottom + 4}px`;
  document.body.appendChild(m);
  m.addEventListener("click", (e) => {
    const a = e.target.dataset.act;
    if (a === "edit") editStep(id);
    else if (a === "toggle") pipe.toggle(id);
    else if (a === "del") pipe.remove(id);
    m.remove();
  });
  setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }), 0);
}

/** 操作表单里可选的列：优先用管道当前结果，否则用原始列 */
function currentColumns() {
  return (state.summary && state.summary.columns) || baseColumns;
}

function addStep() {
  openOpPicker({
    t: (k) => i18n.t(k),
    onPick: (op) => {
      openOpForm({
        t: (k) => i18n.t(k),
        op, params: {}, columns: currentColumns(), isNew: true,
        onSubmit: (params) => pipe.add(op, params),
      });
    },
  });
}

function editStep(id) {
  const s = pipe.steps.find((x) => x.id === id);
  if (!s) return;
  openOpForm({
    t: (k) => i18n.t(k),
    op: s.op, params: s.params, columns: currentColumns(), isNew: false,
    onSubmit: (params) => pipe.update(id, params),
  });
}


/** 把管道里 merge/concat 引用到的数据集按需取回并注册到 Python */
const registered = new Set();
async function ensureDatasets() {
  const needed = new Set();
  for (const st of pipe.enabledSteps) {
    const def = OPS[st.op];
    if (!def) continue;
    for (const f of def.fields || []) {
      if (f.type === "dataset" && st.params[f.k]) needed.add(st.params[f.k]);
    }
  }
  let touched = false;
  for (const id of needed) {
    if (registered.has(id) || id === state.name) continue;
    const meta = BUILTIN.find((d) => d.id === id);
    if (!meta) continue;
    const res = await fetch(meta.file);
    if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
    await engine.loadCSV(id, await res.text());
    registered.add(id);
    touched = true;
  }
  // loadCSV 会把 _RESULT 指向刚注册的那份数据，这里恢复为当前主数据集，
  // 否则管道为空时图表/体检会读到错误的表
  if (touched && state.name) await engine.loadCSV(state.name, state.csvText);
}

/** 执行管道并刷新表格 */
async function runPipeline() {
  if (!engine.ready || !state.name) return;
  const seq = ++runSeq;

  // merge / concat 引用的数据集必须先注册进 Python，否则 pd.read_csv 代理取不到
  try {
    await ensureDatasets();
  } catch (err) {
    toast(String(err.message || err), true);
    return;
  }
  if (seq !== runSeq) return;

  const payload = pipe.buildPayload();

  $("shapeSub").textContent = `· ${i18n.t("running")}`;
  try {
    const res = await engine.pipeline(state.name, payload);
    if (seq !== runSeq) return;        // 有更新的请求在跑，丢弃本次结果

    pipe.steps.forEach((s) => (s.error = null));

    if (!res.ok) {
      const en = pipe.enabledSteps;
      if (en.length) en[en.length - 1].error = res.error;
      renderPipeline();
      $("shapeSub").textContent = `· ${i18n.t("stepError")}`;
      toast(res.error, true);
      return;
    }

    state.summary = res;
    table.setData({
      columns: res.columns,
      total: res.rows,
      source: async (start, count) => engine.resultRows(start, count),
    });
    updateShape(res.rows, res.cols, i18n.t("liveMode"));
    renderPipeline();
  } catch (err) {
    if (seq !== runSeq) return;
    console.error(err);
    toast(String(err.message || err), true);
    $("shapeSub").textContent = `· ${i18n.t("stepError")}`;
  }
}


/* =============================================================
 * 数据体检报告：整体概况 + 每列画像 + 缺失矩阵 + 相关热力图
 * ============================================================= */
async function openProfile() {
  if (!engine.ready) { toast(i18n.t("enginePending"), true); return; }

  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal-card profile-modal">
      <div class="modal-head">
        <h3>📋 ${escapeHtml(i18n.t("profileTitle"))}</h3>
        <button class="modal-x" data-close>✕</button>
      </div>
      <div class="pf-top" id="pfTop"></div>
      <div class="pf-body" id="pfBody">
        <p class="hint">${escapeHtml(i18n.t("running"))}</p>
      </div>
    </div>`;
  document.body.appendChild(back);
  back.addEventListener("click", (e) => {
    if (e.target === back || e.target.hasAttribute("data-close")) closeProfile(back);
  });
  requestAnimationFrame(() => back.classList.add("show"));

  try {
    const pf = await engine.chart("profile", {});
    const kpi = (v, label, warn) =>
      `<div class="pf-kpi${warn ? " warn" : ""}"><b>${v}</b><span>${escapeHtml(label)}</span></div>`;
    back.querySelector("#pfTop").innerHTML = [
      kpi(fmtNum(pf.rows), i18n.t("pfRows")),
      kpi(fmtNum(pf.cols), i18n.t("pfCols")),
      kpi(fmtNum(pf.duplicates), i18n.t("pfDup"), pf.duplicates > 0),
      kpi(fmtNum(pf.totalNulls), i18n.t("pfNulls"), pf.totalNulls > 0),
      kpi((pf.nullRate * 100).toFixed(1) + "%", i18n.t("pfNullRate"), pf.nullRate > 0.05),
      kpi(pf.memoryKB > 1024 ? (pf.memoryKB / 1024).toFixed(1) + " MB" : pf.memoryKB.toFixed(0) + " KB", i18n.t("pfMem")),
    ].join("");

    const rows = pf.columns.map((c) => {
      const missPct = pf.rows ? (c.nulls / pf.rows) * 100 : 0;
      let spark = "";
      if (c.hist && c.hist.length) {
        const m = Math.max(...c.hist) || 1;
        spark = `<div class="pf-spark">${c.hist.map((h) => `<i style="height:${Math.max(1,(h/m)*100)}%"></i>`).join("")}</div>`;
      } else if (c.top && c.top.length) {
        const m = Math.max(...c.top.map((t) => t[1])) || 1;
        spark = `<div class="pf-spark cat">${c.top.map((t) => `<i style="height:${Math.max(1,(t[1]/m)*100)}%" title="${escapeHtml(t[0])}"></i>`).join("")}</div>`;
      }
      const stats = c.kind === "number" && c.mean != null
        ? `μ=${fmtNum(c.mean)} · σ=${fmtNum(c.std)} · [${fmtNum(c.min)}, ${fmtNum(c.max)}]`
        : (c.top && c.top.length ? `top: ${escapeHtml(String(c.top[0][0]))} (${fmtNum(c.top[0][1])})` : "—");
      return `<tr>
        <td class="pf-cname" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>
        <td><span class="th-kind ${c.kind}">${escapeHtml(c.dtype)}</span></td>
        <td><div class="pf-miss"><span class="pf-miss-bar"><i style="width:${missPct}%"></i></span>
            <span class="pf-stats">${fmtNum(c.nulls)}</span></div></td>
        <td class="pf-stats">${fmtNum(c.unique)}</td>
        <td>${spark}</td>
        <td class="pf-stats">${stats}</td>
      </tr>`;
    }).join("");

    back.querySelector("#pfBody").innerHTML = `
      <div class="pf-section-title">${escapeHtml(i18n.t("pfColumns"))}</div>
      <table class="pf-table">
        <thead><tr>
          <th>${escapeHtml(i18n.t("pfName"))}</th><th>${escapeHtml(i18n.t("pfType"))}</th>
          <th>${escapeHtml(i18n.t("pfMissing"))}</th><th>${escapeHtml(i18n.t("pfUnique"))}</th>
          <th>${escapeHtml(i18n.t("pfDist"))}</th><th>${escapeHtml(i18n.t("pfStats"))}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="pf-section-title">${escapeHtml(i18n.t("missingMatrix"))} · ${escapeHtml(i18n.t("corrHeatmap"))}</div>
      <div class="pf-charts">
        <div class="pf-chart" id="pfMissing"></div>
        <div class="pf-chart" id="pfCorr"></div>
      </div>`;

    const [miss, corr] = await Promise.all([
      engine.chart("missing", {}).catch(() => null),
      engine.chart("corr", {}).catch(() => null),
    ]);
    if (miss && back.isConnected) {
      const c1 = echarts.init(back.querySelector("#pfMissing"));
      c1.setOption(missingOption(miss)); profileCharts.push(c1);
    }
    if (corr && corr.labels.length && back.isConnected) {
      const c2 = echarts.init(back.querySelector("#pfCorr"));
      c2.setOption(corrOption(corr)); profileCharts.push(c2);
    }
  } catch (err) {
    back.querySelector("#pfBody").innerHTML = `<p class="hint">${escapeHtml(String(err.message || err))}</p>`;
  }
}

const profileCharts = [];
function closeProfile(back) {
  profileCharts.forEach((c) => c.dispose());
  profileCharts.length = 0;
  back.classList.remove("show");
  setTimeout(() => back.remove(), 160);
}

/* ===================== 代码面板 ===================== */
function renderCode() {
  $("codeView").innerHTML = highlight(state.name ? pipe.code() : "import pandas as pd");
}

function highlight(src) {
  return escapeHtml(src)
    .replace(/(^|\n)(#[^\n]*)/g, (m, a, b) => `${a}<span class="cmt">${b}</span>`)
    .replace(/\b(import|as|from|def|return|True|False|None|lambda)\b/g, '<span class="kw">$1</span>')
    .replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g, '<span class="str">$1</span>')
    .replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');
}

/* ===================== UI 绑定 ===================== */
function bindUI() {
  $("langToggle").addEventListener("click", () => {
    i18n.toggle();
    buildDatasetSelect();
    $("datasetSelect").value = state.name || DEFAULT_DATASET;
    // 切语言要把所有动态渲染的区域重绘一遍，否则只有静态文案会变
    renderPipeline();
    renderColumnPanel();
    renderChartPanel();
    if (state.summary || state.preview) {
      const rows = state.summary ? state.summary.rows : state.preview.rows.length;
      const cols = state.summary ? state.summary.cols : state.preview.columns.length;
      updateShape(rows, cols, state.mode === "live" ? i18n.t("liveMode") : i18n.t("previewMode"));
    }
    // 工具提示也要跟着换
    const tips = { undoBtn: "undo", redoBtn: "redo", savePipeBtn: "savePipe",
                   loadPipeBtn: "loadPipe", clearPipeBtn: "clearPipe" };
    for (const [id, key] of Object.entries(tips)) {
      const el = $(id);
      if (el) el.title = i18n.t(key);
    }
  });

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchTab(t.dataset.tab)));

  $("uploadBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const text = await f.text();
    // \w 不含中文，直接用会把汉字全替换成下划线，生成的代码变成
    // pd.read_csv("_____.csv")。改用 Unicode 属性类，保留各语言文字与数字。
    const name = f.name.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_]/gu, "_") || "uploaded";
    setCSV(name, text);
    toast(`${f.name} · ${(f.size / 1024).toFixed(0)} KB`);
  });

  $("addStepBtn").addEventListener("click", addStep);
  $("clearPipeBtn").addEventListener("click", () => pipe.clear());
  $("undoBtn").addEventListener("click", () => pipe.undo());
  $("redoBtn").addEventListener("click", () => pipe.redo());

  $("savePipeBtn").addEventListener("click", () => {
    download(`${state.name || "pipeline"}_pipeline.json`, pipe.serialize(), "application/json");
    toast(i18n.t("pipeSaved"));
  });
  $("loadPipeBtn").addEventListener("click", () => $("pipeFileInput").click());
  $("pipeFileInput").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (!obj || !Array.isArray(obj.steps)) throw new Error("bad");
      pipe.load(obj);
      toast(i18n.t("pipeLoaded"));
    } catch {
      toast(i18n.t("pipeBadFile"), true);
    }
    e.target.value = "";
  });

  // 键盘：Ctrl/⌘+Z 撤销，Ctrl/⌘+Shift+Z 重做
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    e.preventDefault();
    e.shiftKey ? pipe.redo() : pipe.undo();
  });
  $("profileBtn").addEventListener("click", openProfile);

  $("copyCodeBtn").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("codeView").textContent);
    toast(i18n.t("copied"));
  });

  $("downloadCodeBtn").addEventListener("click", () => {
    download(`${state.name || "analysis"}_pipeline.py`, $("codeView").textContent, "text/x-python");
  });

  $("exportBtn").addEventListener("click", async () => {
    if (!engine.ready) { toast(i18n.t("enginePending"), true); return; }
    try {
      const csv = await engine.exportResult("csv");
      download(`${state.name || "result"}.csv`, csv, "text/csv");
    } catch (err) { toast(String(err.message || err), true); }
  });

  // 列筛选：仅做视觉高亮，不裁剪数据——真要裁剪请用「选择列」操作，
  // 这样表格看到的永远和生成的 pandas 代码一致。
  $("colFilter").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll(".table-head .th[data-col]").forEach((th) => {
      const name = th.querySelector(".th-name")?.textContent.toLowerCase() || "";
      th.style.opacity = !q || name.includes(q) ? "1" : ".22";
    });
  });

  // 拖拽上传
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const text = await f.text();
    setCSV(f.name.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_]/gu, "_") || "uploaded", text);
  });
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
}

/* ===================== 小工具 ===================== */
let toastTimer;
function toast(msg, isError) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function fmtNum(v) {
  if (v == null) return "—";
  if (typeof v !== "number") return String(v);
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return v.toLocaleString("en-US", { maximumFractionDigits: 3 });
}
function sig(v) {
  if (typeof v !== "number") return String(v);
  return Math.abs(v) >= 1000 ? v.toFixed(0) : v.toPrecision(3).replace(/\.?0+$/, "");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}


function download(filename, text, mime) {
  const blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

window.addEventListener("resize", () => { if (statChart) statChart.resize(); });

/* 调试/自动化入口：控制台与端到端测试可直接驱动管道 */
window.__app = { pipe, state, engine, runPipeline, get table() { return table; } };

main();
