/* =============================================================
 * table.js —— 虚拟滚动数据表格
 * -------------------------------------------------------------
 * 只渲染可视窗口内的行，十万行也不卡。
 * 数据来源抽象为 DataSource：既可以是内存数组（预览期），
 * 也可以是 pandas 后端的异步切片（分析期），表格本身不关心。
 * ============================================================= */

const ROW_H = 32;
const BUFFER = 8;          // 上下各多渲染几行，滚动时不露白
const MIN_COL_W = 86;
const MAX_COL_W = 260;
const IDX_W = 56;

export class DataTable {
  /**
   * @param {object} els  {head, body, rows, spacer, empty, wrap}
   */
  constructor(els) {
    this.els = els;
    this.columns = [];      // [{name, kind, dtype, nulls, unique, hist, top, ...}]
    this.widths = [];
    this.total = 0;
    this.source = null;     // async (start, count) => {index:[], data:[][]}
    this.cache = new Map(); // 块缓存：blockIndex -> rows
    this.blockSize = 200;
    this.selected = [];        // 已选列索引，最多 2 个（图表需要 1–2 列）
    this.sort = null;       // {col, dir}
    this.onColumnClick = () => {};
    this.onSortChange = null;
    this._pendingBlocks = new Set();
    this._renderToken = 0;

    this.els.body.addEventListener("scroll", () => this._onScroll(), { passive: true });
    // 表头跟随横向滚动
    this.els.body.addEventListener("scroll", () => {
      this.els.head.scrollLeft = this.els.body.scrollLeft;
    }, { passive: true });
  }

  /** 设置数据源与列信息 */
  setData({ columns, total, source }) {
    this.columns = columns;
    this.total = total;
    this.source = source;
    this.cache.clear();
    this._pendingBlocks.clear();
    this._renderToken++;
    this.widths = columns.map((c) => this._measure(c));
    this.els.spacer.style.height = `${total * ROW_H}px`;
    this.els.spacer.style.width = `${IDX_W + this.widths.reduce((a, b) => a + b, 0)}px`;
    this.els.body.scrollTop = 0;
    this._renderHead();
    this._render();
    this.els.empty.classList.toggle("hidden", total > 0 || columns.length > 0);
  }

  /** 仅更新列元信息（例如 pandas 就绪后用真实 dtype 覆盖预览推断） */
  updateColumns(columns) {
    this.columns = columns;
    this._renderHead();
  }

  _measure(col) {
    const nameLen = String(col.name).length;
    let w = Math.max(MIN_COL_W, nameLen * 9 + 28);
    if (col.kind === "number") w = Math.max(w, 96);
    return Math.min(MAX_COL_W, w);
  }

  _renderHead() {
    const h = this.els.head;
    const parts = [`<div class="th th-idx"></div>`];
    this.columns.forEach((c, i) => {
      const pos = this.selected.indexOf(i);
      const sel = pos >= 0 ? " selected" : "";
      const order = this.selected.length > 1 && pos >= 0 ? `<span class="th-pick">${pos + 1}</span>` : "";
      const sortMark =
        this.sort && this.sort.col === c.name
          ? `<span class="th-sort">${this.sort.dir === "asc" ? "▲" : "▼"}</span>`
          : "";
      parts.push(`
        <div class="th${sel}" data-col="${i}" style="width:${this.widths[i]}px" title="${esc(c.name)} · ${esc(c.dtype || c.kind)}">
          ${sortMark}${order}
          <div class="th-name">${esc(c.name)}</div>
          <div class="th-meta">
            <span class="th-kind ${c.kind}">${shortKind(c)}</span>
            ${c.nulls ? `<span class="th-nulls" title="缺失 / nulls">∅${c.nulls}</span>` : ""}
          </div>
          ${spark(c)}
        </div>`);
    });
    h.innerHTML = parts.join("");
    h.querySelectorAll(".th[data-col]").forEach((el) => {
      el.addEventListener("click", (e) => {
        const i = +el.dataset.col;
        // Ctrl/⌘ + 点击 = 加选第二列（用于双列图表），再点已选列则取消
        if (e.ctrlKey || e.metaKey) {
          const at = this.selected.indexOf(i);
          if (at >= 0) this.selected.splice(at, 1);
          else { this.selected.push(i); if (this.selected.length > 2) this.selected.shift(); }
        } else {
          this.selected = this.selected.length === 1 && this.selected[0] === i ? [] : [i];
        }
        this._renderHead();
        this.onColumnClick(this.selected.map((k) => this.columns[k]), this.selected);
      });
    });
  }

  _onScroll() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this._render());
  }

  async _render() {
    const token = this._renderToken;
    const body = this.els.body;
    const scrollTop = body.scrollTop;
    const viewH = body.clientHeight || 400;

    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
    const last = Math.min(this.total, Math.ceil((scrollTop + viewH) / ROW_H) + BUFFER);
    if (last <= first) { this.els.rows.innerHTML = ""; return; }

    const need = [];
    for (let b = Math.floor(first / this.blockSize); b <= Math.floor((last - 1) / this.blockSize); b++) {
      if (!this.cache.has(b) && !this._pendingBlocks.has(b)) need.push(b);
    }

    // 先用已有缓存画一遍（避免滚动时闪白），缺的块异步补
    this._paint(first, last);

    if (need.length && this.source) {
      await Promise.all(need.map(async (b) => {
        this._pendingBlocks.add(b);
        try {
          const res = await this.source(b * this.blockSize, this.blockSize);
          if (token !== this._renderToken) return;       // 数据源已切换，丢弃
          this.cache.set(b, res);
        } catch (err) {
          console.warn("[table] 取数失败 block", b, err);
        } finally {
          this._pendingBlocks.delete(b);
        }
      }));
      if (token === this._renderToken) this._paint(first, last);
    }
  }

  _paint(first, last) {
    const frag = [];
    for (let r = first; r < last; r++) {
      const b = Math.floor(r / this.blockSize);
      const blk = this.cache.get(b);
      const off = r - b * this.blockSize;
      const rowData = blk && blk.data[off];
      const idxLabel = blk && blk.index ? blk.index[off] : r;

      const cells = [`<div class="td-idx">${rowData ? esc(idxLabel) : ""}</div>`];
      this.columns.forEach((c, i) => {
        const w = this.widths[i];
        if (!rowData) { cells.push(`<div class="td" style="width:${w}px"></div>`); return; }
        const v = rowData[i];
        if (v === null || v === undefined || v === "") {
          cells.push(`<div class="td null" style="width:${w}px">NaN</div>`);
        } else {
          const isNum = c.kind === "number" && typeof v === "number";
          cells.push(
            `<div class="td${isNum ? " num" : ""}" style="width:${w}px" title="${esc(v)}">${esc(fmt(v, c))}</div>`
          );
        }
      });
      frag.push(`<div class="tr${r % 2 ? " odd" : ""}">${cells.join("")}</div>`);
    }
    this.els.rows.style.transform = `translateY(${first * ROW_H}px)`;
    this.els.rows.innerHTML = frag.join("");
  }
}

/* ---------- 辅助 ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function fmt(v, col) {
  if (typeof v === "number") {
    if (Number.isInteger(v)) return v.toLocaleString("en-US");
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-4 || a >= 1e10)) return v.toExponential(3);
    return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
  if (typeof v === "boolean") return v ? "True" : "False";
  return v;
}

function shortKind(c) {
  const d = (c.dtype || "").toLowerCase();
  if (d.startsWith("int")) return "int";
  if (d.startsWith("float")) return "float";
  if (d.startsWith("datetime")) return "date";
  if (d === "bool") return "bool";
  if (d === "category") return "cat";
  if (c.kind === "number") return "num";
  if (c.kind === "category") return "cat";
  if (c.kind === "datetime") return "date";
  if (c.kind === "bool") return "bool";
  return "str";
}

/** 列头迷你分布图：数值列直方图，类别列 Top 值条 */
function spark(c) {
  if (c.hist && c.hist.length) {
    const max = Math.max(...c.hist) || 1;
    const bars = c.hist.map((h) => `<i style="height:${Math.max(1, (h / max) * 100)}%"></i>`).join("");
    return `<div class="th-spark">${bars}</div>`;
  }
  if (c.top && c.top.length) {
    const max = Math.max(...c.top.map((t) => t[1])) || 1;
    const bars = c.top.slice(0, 10)
      .map((t) => `<i style="height:${Math.max(1, (t[1] / max) * 100)}%" title="${esc(t[0])}: ${t[1]}"></i>`)
      .join("");
    return `<div class="th-spark cat">${bars}</div>`;
  }
  return `<div class="th-spark"></div>`;
}
