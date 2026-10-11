/* =============================================================
 * csv.js —— 轻量 CSV 解析器
 * -------------------------------------------------------------
 * 用途：在 Pyodide（约 10–20 秒）加载完成之前，先把默认数据集解析出来
 * 立即渲染表格，让用户一进页面就有数据可看、可滚动、可排序。
 * 真正的分析仍然全部交给 pandas——这里只负责"秒开预览"。
 *
 * 支持：引号包裹、引号内逗号与换行、"" 转义、CRLF、自动分隔符嗅探。
 * ============================================================= */

/** 从前几行嗅探分隔符 */
function sniffDelimiter(text) {
  const sample = text.slice(0, 8192).split(/\r?\n/).slice(0, 5);
  const cands = [",", "\t", ";", "|"];
  let best = ",", bestScore = -1;
  for (const d of cands) {
    const counts = sample.map((l) => l.split(d).length - 1);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    // 各行分隔符数量越一致越可信
    const avg = total / counts.length;
    const variance = counts.reduce((a, c) => a + (c - avg) ** 2, 0) / counts.length;
    const score = avg - variance;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/**
 * 解析 CSV 文本
 * @returns {{columns: string[], rows: string[][], delimiter: string}}
 */
export function parseCSV(text, delimiter) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // 去 BOM
  const d = delimiter || sniffDelimiter(text);

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // "" -> 字面量引号
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === d) { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      // 跳过完全空行
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  // 收尾
  if (field !== "" || row.length) {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
  }

  if (!rows.length) return { columns: [], rows: [], delimiter: d };

  const columns = rows[0].map((h, i) => (h.trim() || `col_${i}`));
  const body = rows.slice(1);
  // 补齐/截断到表头列数，避免错行
  for (const r of body) {
    if (r.length < columns.length) while (r.length < columns.length) r.push("");
    else if (r.length > columns.length) r.length = columns.length;
  }
  return { columns, rows: body, delimiter: d };
}

/** 粗略推断列类型（仅用于预览期的右对齐与迷你图，pandas 就绪后会被真实 dtype 覆盖） */
export function guessKinds(columns, rows) {
  const sample = rows.slice(0, 200);
  return columns.map((_, ci) => {
    let num = 0, nonEmpty = 0, uniq = new Set();
    for (const r of sample) {
      const v = r[ci];
      if (v === "" || v == null) continue;
      nonEmpty++;
      if (uniq.size < 50) uniq.add(v);
      if (v !== "" && !isNaN(Number(v))) num++;
    }
    if (nonEmpty === 0) return "text";
    if (num / nonEmpty > 0.9) return "number";
    if (uniq.size <= Math.max(20, sample.length * 0.05)) return "category";
    return "text";
  });
}

/** 预览期的迷你分布：数值列做直方图，类别列做 Top 计数 */
export function previewStats(columns, rows, kinds) {
  return columns.map((name, ci) => {
    const info = { name, kind: kinds[ci], dtype: kinds[ci] === "number" ? "float64?" : "object?", nulls: 0, unique: 0 };
    const vals = [];
    const counts = new Map();
    for (const r of rows) {
      const v = r[ci];
      if (v === "" || v == null) { info.nulls++; continue; }
      if (kinds[ci] === "number") {
        const f = Number(v);
        if (!Number.isNaN(f)) vals.push(f);
      } else {
        counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
    if (kinds[ci] === "number" && vals.length) {
      const min = Math.min(...vals), max = Math.max(...vals);
      const B = 20, hist = new Array(B).fill(0);
      const span = max - min || 1;
      for (const v of vals) {
        let b = Math.floor(((v - min) / span) * B);
        if (b >= B) b = B - 1;
        if (b < 0) b = 0;
        hist[b]++;
      }
      info.min = min; info.max = max;
      info.mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      info.hist = hist;
      info.unique = new Set(vals).size;
    } else {
      info.unique = counts.size;
      info.top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    }
    return info;
  });
}
