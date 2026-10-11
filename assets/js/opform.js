/* =============================================================
 * opform.js —— 操作选择器 + 参数表单
 * 表单结构完全由 ops.js 的 fields 声明驱动，新增操作不用改这里。
 * ============================================================= */

import { OPS, CATEGORIES } from "./ops.js?v=2";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

/* ---------------- 操作选择器 ---------------- */
export function openOpPicker({ t, onPick }) {
  const groups = CATEGORIES.map((cat) => {
    const items = Object.entries(OPS)
      .filter(([, d]) => d.cat === cat)
      .map(([id, d]) => `
        <button class="op-item" data-op="${id}">
          <span class="op-icon">${d.icon || "·"}</span>
          <span class="op-label">
            <b>${esc(t(`op.${id}`))}</b>
            <small>${esc(t(`opd.${id}`))}</small>
          </span>
        </button>`).join("");
    return `<div class="op-group"><h4>${esc(t(`cat.${cat}`))}</h4><div class="op-list">${items}</div></div>`;
  }).join("");

  const modal = mount(`
    <div class="modal-card wide">
      <div class="modal-head">
        <h3>${esc(t("addStep"))}</h3>
        <button class="modal-x" data-close>✕</button>
      </div>
      <input class="op-search" id="opSearch" placeholder="${esc(t("searchOp"))}" />
      <div class="op-body">${groups}</div>
    </div>`);

  const search = modal.querySelector("#opSearch");
  search.focus();
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    modal.querySelectorAll(".op-item").forEach((el) => {
      const txt = el.textContent.toLowerCase() + " " + el.dataset.op;
      el.style.display = !q || txt.includes(q) ? "" : "none";
    });
    modal.querySelectorAll(".op-group").forEach((g) => {
      const any = [...g.querySelectorAll(".op-item")].some((e) => e.style.display !== "none");
      g.style.display = any ? "" : "none";
    });
  });

  modal.querySelectorAll(".op-item").forEach((el) =>
    el.addEventListener("click", () => { close(modal); onPick(el.dataset.op); }));
}

/* ---------------- 参数表单 ---------------- */
export function openOpForm({ t, op, params, columns, onSubmit, isNew }) {
  const def = OPS[op];
  if (!def) return;

  const modal = mount(`
    <div class="modal-card">
      <div class="modal-head">
        <h3><span class="op-icon">${def.icon || "·"}</span> ${esc(t(`op.${op}`))}</h3>
        <button class="modal-x" data-close>✕</button>
      </div>
      <p class="modal-desc">${esc(t(`opd.${op}`))}</p>
      <form class="op-form" id="opForm"></form>
      <div class="modal-foot">
        <code class="code-preview" id="codePreview"></code>
        <div class="modal-actions">
          <button class="btn" type="button" data-close>${esc(t("cancel"))}</button>
          <button class="btn primary" type="button" id="okBtn">${esc(isNew ? t("add") : t("apply"))}</button>
        </div>
      </div>
    </div>`);

  const form = modal.querySelector("#opForm");
  const cur = { ...(params || {}) };
  (def.fields || []).forEach((f) => { if (cur[f.k] === undefined && f.def !== undefined) cur[f.k] = f.def; });

  function render() {
    form.innerHTML = (def.fields || [])
      .filter((f) => !f.when || f.when(cur))
      .map((f) => fieldHtml(f, cur, columns, t))
      .join("");
    bindFields();
    updatePreview();
  }

  function bindFields() {
    form.querySelectorAll("[data-field]").forEach((el) => {
      const k = el.dataset.field;
      const ev = el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
      el.addEventListener(ev, () => {
        if (el.type === "checkbox") {
          const arr = [...form.querySelectorAll(`[data-field="${k}"]:checked`)].map((x) => x.value);
          cur[k] = arr;
        } else {
          cur[k] = el.value;
        }
        const needRerender = (def.fields || []).some((f) => f.when);
        if (needRerender) render(); else updatePreview();
      });
    });
    // 多选列的快捷操作
    form.querySelectorAll("[data-selall]").forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.selall;
        const boxes = [...form.querySelectorAll(`[data-field="${k}"]`)];
        const allOn = boxes.every((x) => x.checked);
        boxes.forEach((x) => (x.checked = !allOn));
        cur[k] = boxes.filter((x) => x.checked).map((x) => x.value);
        updatePreview();
      }));
    // 聚合映射的增删
    form.querySelectorAll("[data-aggadd]").forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.aggadd;
        cur[k] = [...(cur[k] || []), { col: "", fn: "mean" }];
        render();
      }));
    form.querySelectorAll("[data-aggdel]").forEach((b) =>
      b.addEventListener("click", () => {
        const [k, i] = b.dataset.aggdel.split("|");
        cur[k] = (cur[k] || []).filter((_, idx) => idx !== +i);
        render();
      }));
    form.querySelectorAll("[data-aggfield]").forEach((el) =>
      el.addEventListener("change", () => {
        const [k, i, which] = el.dataset.aggfield.split("|");
        const arr = [...(cur[k] || [])];
        arr[+i] = { ...arr[+i], [which]: el.value };
        cur[k] = arr;
        updatePreview();
      }));
  }

  function updatePreview() {
    try {
      const out = def.code(cur);
      modal.querySelector("#codePreview").textContent = Array.isArray(out) ? out.join("\n") : out;
    } catch {
      modal.querySelector("#codePreview").textContent = "…";
    }
  }

  modal.querySelector("#okBtn").addEventListener("click", () => {
    const missing = (def.fields || []).filter(
      (f) => f.req && (!f.when || f.when(cur)) &&
        (cur[f.k] === undefined || cur[f.k] === "" || (Array.isArray(cur[f.k]) && !cur[f.k].length))
    );
    if (missing.length) {
      const el = form.querySelector(`[data-field="${missing[0].k}"]`);
      if (el) { el.focus(); el.classList.add("invalid"); setTimeout(() => el.classList.remove("invalid"), 1200); }
      return;
    }
    close(modal);
    onSubmit(cur);
  });

  render();
}

/* ---------------- 字段渲染 ---------------- */
function fieldHtml(f, cur, columns, t) {
  const label = `<label class="f-label">${esc(t(`field.${f.k}`) || f.k)}${f.req ? ' <i class="req">*</i>' : ""}</label>`;
  const v = cur[f.k];
  const cols = columns || [];
  const pool = f.numeric ? cols.filter((c) => c.kind === "number") : cols;

  switch (f.type) {
    case "number":
      return `<div class="f-row">${label}<input class="f-input" type="number" data-field="${f.k}"
        value="${v ?? ""}" ${f.min != null ? `min="${f.min}"` : ""} placeholder="${esc(f.ph || "")}" /></div>`;

    case "text":
      return `<div class="f-row">${label}<input class="f-input" type="text" data-field="${f.k}"
        value="${esc(v ?? "")}" placeholder="${esc(f.ph || "")}" /></div>`;

    case "expr":
      return `<div class="f-row">${label}
        <input class="f-input mono" type="text" data-field="${f.k}" value="${esc(v ?? "")}"
          placeholder="${esc(f.ph || "")}" spellcheck="false" />
        <div class="f-help">${esc(t("exprHelp"))}</div></div>`;

    case "select":
      return `<div class="f-row">${label}<select class="f-input" data-field="${f.k}">
        ${(f.opts || []).map((o) => `<option value="${o}"${v === o ? " selected" : ""}>${esc(t(`opt.${o}`) || o)}</option>`).join("")}
      </select></div>`;

    case "dataset": {
      const list = (window.__datasets || []);
      return `<div class="f-row">${label}<select class="f-input" data-field="${f.k}">
        <option value="">—</option>
        ${list.map((d) => `<option value="${esc(d.id)}"${v === d.id ? " selected" : ""}>${esc(d.label)}</option>`).join("")}
      </select><div class="f-help">${esc(t("datasetHelp"))}</div></div>`;
    }

    case "column":
      return `<div class="f-row">${label}<select class="f-input" data-field="${f.k}">
        <option value="">—</option>
        ${pool.map((c) => `<option value="${esc(c.name)}"${v === c.name ? " selected" : ""}>${esc(c.name)} · ${c.kind}</option>`).join("")}
      </select></div>`;

    case "columns": {
      const sel = Array.isArray(v) ? v : [];
      return `<div class="f-row">${label}
        <button class="btn sm ghost f-selall" type="button" data-selall="${f.k}">${esc(t("toggleAll"))}</button>
        <div class="f-checks">
          ${pool.map((c) => `<label class="f-check"><input type="checkbox" data-field="${f.k}"
            value="${esc(c.name)}"${sel.includes(c.name) ? " checked" : ""} /> <span>${esc(c.name)}</span>
            <i class="k ${c.kind}">${c.kind[0]}</i></label>`).join("")}
        </div></div>`;
    }

    case "aggmap": {
      const rows = Array.isArray(v) && v.length ? v : [{ col: "", fn: "mean" }];
      if (!Array.isArray(cur[f.k]) || !cur[f.k].length) cur[f.k] = rows;
      const AG = ["mean", "sum", "count", "median", "min", "max", "std", "var", "nunique", "first", "last"];
      return `<div class="f-row">${label}
        <div class="agg-list">
          ${rows.map((r, i) => `
            <div class="agg-row">
              <select class="f-input" data-aggfield="${f.k}|${i}|col">
                <option value="">—</option>
                ${cols.map((c) => `<option value="${esc(c.name)}"${r.col === c.name ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
              </select>
              <select class="f-input narrow" data-aggfield="${f.k}|${i}|fn">
                ${AG.map((a) => `<option value="${a}"${r.fn === a ? " selected" : ""}>${a}</option>`).join("")}
              </select>
              <button class="btn sm ghost" type="button" data-aggdel="${f.k}|${i}">✕</button>
            </div>`).join("")}
        </div>
        <button class="btn sm ghost" type="button" data-aggadd="${f.k}">＋ ${esc(t("addAgg"))}</button>
      </div>`;
    }

    default:
      return "";
  }
}

/* ---------------- 模态框基础 ---------------- */
function mount(html) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = html;
  document.body.appendChild(back);
  back.addEventListener("click", (e) => {
    if (e.target === back || e.target.hasAttribute("data-close")) close(back);
  });
  const esc_ = (e) => { if (e.key === "Escape") { close(back); document.removeEventListener("keydown", esc_); } };
  document.addEventListener("keydown", esc_);
  requestAnimationFrame(() => back.classList.add("show"));
  return back;
}

function close(back) {
  back.classList.remove("show");
  setTimeout(() => back.remove(), 160);
}
