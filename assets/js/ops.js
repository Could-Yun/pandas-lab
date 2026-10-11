/* =============================================================
 * ops.js —— 操作注册表
 * -------------------------------------------------------------
 * 每个操作定义四件事：
 *   fields   参数表单结构（由 opform.js 渲染）
 *   code     生成的 pandas 代码（字符串或字符串数组）
 *   summary  管道卡片上显示的一行摘要
 *   needs    依赖的上下文（如必须有数值列）
 *
 * 代码生成的约定：当前数据帧始终叫 df，每步产出仍赋回 df。
 * 这样生成的脚本可以直接粘到 Jupyter 里跑。
 * ============================================================= */

/* ---------- Python 字面量辅助 ---------- */
export const py = {
  str: (s) => JSON.stringify(String(s ?? "")),
  list: (a) => "[" + (a || []).map((x) => py.str(x)).join(", ") + "]",
  numList: (a) => "[" + (a || []).join(", ") + "]",
  dict: (o) => "{" + Object.entries(o || {}).map(([k, v]) => `${py.str(k)}: ${v}`).join(", ") + "}",
  strDict: (o) => "{" + Object.entries(o || {}).map(([k, v]) => `${py.str(k)}: ${py.str(v)}`).join(", ") + "}",
  bool: (b) => (b ? "True" : "False"),
  num: (n) => (n === "" || n == null || isNaN(Number(n)) ? "None" : String(Number(n))),
};

const AGGS = ["mean", "sum", "count", "median", "min", "max", "std", "var", "nunique", "first", "last"];
const DTYPES = ["int64", "float64", "str", "bool", "category", "datetime64[ns]"];

/* =============================================================
 * 操作定义
 * cat: inspect | select | filter | sort | clean | derive | aggregate
 * ============================================================= */
export const OPS = {

  /* ---------------- 行列选择 ---------------- */
  head: {
    cat: "select", icon: "⇥",
    fields: [{ k: "n", type: "number", def: 10, min: 1 }],
    code: (p) => `df = df.head(${py.num(p.n)})`,
    summary: (p) => `n=${p.n}`,
  },
  tail: {
    cat: "select", icon: "⇤",
    fields: [{ k: "n", type: "number", def: 10, min: 1 }],
    code: (p) => `df = df.tail(${py.num(p.n)})`,
    summary: (p) => `n=${p.n}`,
  },
  sample: {
    cat: "select", icon: "🎲",
    fields: [
      { k: "n", type: "number", def: 100, min: 1 },
      { k: "seed", type: "number", def: 42 },
    ],
    code: (p) => `df = df.sample(n=min(${py.num(p.n)}, len(df)), random_state=${py.num(p.seed)})`,
    summary: (p) => `n=${p.n}, seed=${p.seed}`,
  },
  select_columns: {
    cat: "select", icon: "▥",
    fields: [{ k: "cols", type: "columns", req: true }],
    code: (p) => `df = df[${py.list(p.cols)}]`,
    summary: (p) => `${(p.cols || []).length} 列 / cols`,
  },
  drop_columns: {
    cat: "select", icon: "⊟",
    fields: [{ k: "cols", type: "columns", req: true }],
    code: (p) => `df = df.drop(columns=${py.list(p.cols)})`,
    summary: (p) => (p.cols || []).join(", "),
  },
  iloc_rows: {
    cat: "select", icon: "↕",
    fields: [
      { k: "start", type: "number", def: 0, min: 0 },
      { k: "end", type: "number", def: 100, min: 1 },
    ],
    code: (p) => `df = df.iloc[${py.num(p.start)}:${py.num(p.end)}]`,
    summary: (p) => `[${p.start}:${p.end}]`,
  },

  /* ---------------- 筛选 ---------------- */
  query: {
    cat: "filter", icon: "🔍",
    fields: [{ k: "expr", type: "expr", req: true, ph: 'age > 30 and sex == "female"' }],
    code: (p) => `df = df.query(${py.str(p.expr)})`,
    summary: (p) => p.expr,
  },
  filter_nulls: {
    cat: "filter", icon: "∅",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "mode", type: "select", opts: ["notna", "isna"], def: "notna" },
    ],
    code: (p) => `df = df[df[${py.str(p.col)}].${p.mode}()]`,
    summary: (p) => `${p.col}.${p.mode}()`,
  },
  nlargest: {
    cat: "filter", icon: "▲",
    fields: [
      { k: "n", type: "number", def: 10, min: 1 },
      { k: "col", type: "column", req: true, numeric: true },
    ],
    code: (p) => `df = df.nlargest(${py.num(p.n)}, ${py.str(p.col)})`,
    summary: (p) => `top ${p.n} · ${p.col}`,
  },
  nsmallest: {
    cat: "filter", icon: "▼",
    fields: [
      { k: "n", type: "number", def: 10, min: 1 },
      { k: "col", type: "column", req: true, numeric: true },
    ],
    code: (p) => `df = df.nsmallest(${py.num(p.n)}, ${py.str(p.col)})`,
    summary: (p) => `bottom ${p.n} · ${p.col}`,
  },
  drop_duplicates: {
    cat: "filter", icon: "⧉",
    fields: [
      { k: "cols", type: "columns" },
      { k: "keep", type: "select", opts: ["first", "last", "none"], def: "first" },
    ],
    code: (p) => {
      const sub = p.cols && p.cols.length ? `subset=${py.list(p.cols)}, ` : "";
      const keep = p.keep === "none" ? "False" : py.str(p.keep);
      return `df = df.drop_duplicates(${sub}keep=${keep})`;
    },
    summary: (p) => (p.cols && p.cols.length ? p.cols.join(", ") : "全部列 / all"),
  },

  /* ---------------- 排序 ---------------- */
  sort_values: {
    cat: "sort", icon: "↓↑",
    fields: [
      { k: "cols", type: "columns", req: true },
      { k: "asc", type: "select", opts: ["asc", "desc"], def: "asc" },
    ],
    code: (p) => `df = df.sort_values(by=${py.list(p.cols)}, ascending=${py.bool(p.asc !== "desc")})`,
    summary: (p) => `${(p.cols || []).join(", ")} ${p.asc === "desc" ? "↓" : "↑"}`,
  },
  reset_index: {
    cat: "sort", icon: "#",
    fields: [{ k: "drop", type: "select", opts: ["yes", "no"], def: "yes" }],
    code: (p) => `df = df.reset_index(drop=${py.bool(p.drop !== "no")})`,
    summary: (p) => `drop=${p.drop !== "no"}`,
  },

  /* ---------------- 清洗 ---------------- */
  dropna: {
    cat: "clean", icon: "🧹",
    fields: [
      { k: "cols", type: "columns" },
      { k: "how", type: "select", opts: ["any", "all"], def: "any" },
    ],
    code: (p) => {
      const sub = p.cols && p.cols.length ? `subset=${py.list(p.cols)}, ` : "";
      return `df = df.dropna(${sub}how=${py.str(p.how || "any")})`;
    },
    summary: (p) => (p.cols && p.cols.length ? p.cols.join(", ") : "全部列 / all"),
  },
  fillna: {
    cat: "clean", icon: "✚",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "method", type: "select", opts: ["mean", "median", "mode", "ffill", "bfill", "value"], def: "mean" },
      { k: "value", type: "text", when: (p) => p.method === "value" },
    ],
    code: (p) => {
      const c = py.str(p.col);
      switch (p.method) {
        case "mean":   return `df[${c}] = df[${c}].fillna(df[${c}].mean())`;
        case "median": return `df[${c}] = df[${c}].fillna(df[${c}].median())`;
        case "mode":   return `df[${c}] = df[${c}].fillna(df[${c}].mode().iloc[0])`;
        case "ffill":  return `df[${c}] = df[${c}].ffill()`;
        case "bfill":  return `df[${c}] = df[${c}].bfill()`;
        default: {
          const v = p.value;
          const lit = v !== "" && !isNaN(Number(v)) ? Number(v) : py.str(v);
          return `df[${c}] = df[${c}].fillna(${lit})`;
        }
      }
    },
    summary: (p) => `${p.col} ← ${p.method}${p.method === "value" ? `(${p.value})` : ""}`,
  },
  astype: {
    cat: "clean", icon: "⇄",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "dtype", type: "select", opts: DTYPES, def: "float64" },
    ],
    code: (p) =>
      p.dtype === "datetime64[ns]"
        ? `df[${py.str(p.col)}] = pd.to_datetime(df[${py.str(p.col)}], errors="coerce")`
        : `df[${py.str(p.col)}] = df[${py.str(p.col)}].astype(${py.str(p.dtype)})`,
    summary: (p) => `${p.col} → ${p.dtype}`,
  },
  rename: {
    cat: "clean", icon: "✎",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "to", type: "text", req: true },
    ],
    code: (p) => `df = df.rename(columns=${py.strDict({ [p.col]: p.to })})`,
    summary: (p) => `${p.col} → ${p.to}`,
  },
  replace: {
    cat: "clean", icon: "⇋",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "from", type: "text", req: true },
      { k: "to", type: "text" },
    ],
    code: (p) => {
      const lit = (v) => (v !== "" && !isNaN(Number(v)) ? Number(v) : py.str(v));
      return `df[${py.str(p.col)}] = df[${py.str(p.col)}].replace(${lit(p.from)}, ${lit(p.to)})`;
    },
    summary: (p) => `${p.col}: ${p.from} → ${p.to}`,
  },
  clip: {
    cat: "clean", icon: "✂",
    fields: [
      { k: "col", type: "column", req: true, numeric: true },
      { k: "lower", type: "number" },
      { k: "upper", type: "number" },
    ],
    code: (p) => `df[${py.str(p.col)}] = df[${py.str(p.col)}].clip(lower=${py.num(p.lower)}, upper=${py.num(p.upper)})`,
    summary: (p) => `${p.col} ∈ [${p.lower ?? "-∞"}, ${p.upper ?? "∞"}]`,
  },
  str_ops: {
    cat: "clean", icon: "Aa",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "fn", type: "select", opts: ["lower", "upper", "strip", "title", "len"], def: "lower" },
    ],
    code: (p) => {
      const c = py.str(p.col);
      return p.fn === "len"
        ? `df[${py.str(p.col + "_len")}] = df[${c}].astype(str).str.len()`
        : `df[${c}] = df[${c}].astype(str).str.${p.fn}()`;
    },
    summary: (p) => `${p.col}.str.${p.fn}()`,
  },

  /* ---------------- 派生 ---------------- */
  assign: {
    cat: "derive", icon: "ƒ",
    fields: [
      { k: "name", type: "text", req: true, ph: "new_col" },
      { k: "expr", type: "expr", req: true, ph: "fare / age" },
    ],
    code: (p) => `df[${py.str(p.name)}] = df.eval(${py.str(p.expr)})`,
    summary: (p) => `${p.name} = ${p.expr}`,
  },
  cut: {
    cat: "derive", icon: "▦",
    fields: [
      { k: "col", type: "column", req: true, numeric: true },
      { k: "bins", type: "number", def: 4, min: 2 },
      { k: "name", type: "text", ph: "(自动 / auto)" },
    ],
    code: (p) => {
      const out = p.name || `${p.col}_bin`;
      return `df[${py.str(out)}] = pd.cut(df[${py.str(p.col)}], bins=${py.num(p.bins)})`;
    },
    summary: (p) => `${p.col} → ${p.bins} 等宽区间`,
  },
  qcut: {
    cat: "derive", icon: "▩",
    fields: [
      { k: "col", type: "column", req: true, numeric: true },
      { k: "q", type: "number", def: 4, min: 2 },
      { k: "name", type: "text", ph: "(自动 / auto)" },
    ],
    code: (p) => {
      const out = p.name || `${p.col}_q`;
      return `df[${py.str(out)}] = pd.qcut(df[${py.str(p.col)}], q=${py.num(p.q)}, duplicates="drop")`;
    },
    summary: (p) => `${p.col} → ${p.q} 等频分位`,
  },
  rank: {
    cat: "derive", icon: "①",
    fields: [
      { k: "col", type: "column", req: true, numeric: true },
      { k: "method", type: "select", opts: ["average", "min", "max", "dense", "first"], def: "dense" },
    ],
    code: (p) =>
      `df[${py.str(p.col + "_rank")}] = df[${py.str(p.col)}].rank(method=${py.str(p.method)}, ascending=False)`,
    summary: (p) => `${p.col} rank(${p.method})`,
  },
  round_num: {
    cat: "derive", icon: "0.0",
    fields: [{ k: "n", type: "number", def: 2, min: 0 }],
    code: (p) => `df = df.round(${py.num(p.n)})`,
    summary: (p) => `${p.n} 位小数 / decimals`,
  },

  /* ---------------- 聚合 ---------------- */
  groupby_agg: {
    cat: "aggregate", icon: "Σ",
    fields: [
      { k: "by", type: "columns", req: true },
      { k: "aggs", type: "aggmap", req: true },
    ],
    code: (p) => {
      const m = {};
      (p.aggs || []).forEach(({ col, fn }) => {
        if (!col || !fn) return;
        if (!m[col]) m[col] = [];
        if (!m[col].includes(fn)) m[col].push(fn);
      });
      const body = Object.entries(m)
        .map(([c, fns]) => `${py.str(c)}: ${fns.length > 1 ? py.list(fns) : py.str(fns[0])}`)
        .join(", ");
      return [
        `df = df.groupby(${py.list(p.by)}, dropna=False).agg({${body}})`,
        `df.columns = ["_".join(c).rstrip("_") if isinstance(c, tuple) else c for c in df.columns]`,
        `df = df.reset_index()`,
      ];
    },
    summary: (p) =>
      `by ${(p.by || []).join(",")} · ${(p.aggs || []).map((a) => `${a.fn}(${a.col})`).join(", ")}`,
  },
  value_counts: {
    cat: "aggregate", icon: "#",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "normalize", type: "select", opts: ["no", "yes"], def: "no" },
    ],
    code: (p) => [
      `df = df[${py.str(p.col)}].value_counts(normalize=${py.bool(p.normalize === "yes")}, dropna=False).reset_index()`,
      `df.columns = [${py.str(p.col)}, ${py.str(p.normalize === "yes" ? "proportion" : "count")}]`,
    ],
    summary: (p) => `${p.col}${p.normalize === "yes" ? " (比例)" : ""}`,
  },
  pivot_table: {
    cat: "aggregate", icon: "⊞",
    fields: [
      { k: "index", type: "columns", req: true },
      { k: "columns", type: "column" },
      { k: "values", type: "column", req: true, numeric: true },
      { k: "aggfunc", type: "select", opts: AGGS, def: "mean" },
    ],
    code: (p) => {
      const colsArg = p.columns ? `columns=${py.str(p.columns)}, ` : "";
      return [
        `df = pd.pivot_table(df, index=${py.list(p.index)}, ${colsArg}values=${py.str(p.values)}, aggfunc=${py.str(p.aggfunc)})`,
        `df = df.reset_index()`,
      ];
    },
    summary: (p) => `${(p.index || []).join(",")} × ${p.columns || "—"} → ${p.aggfunc}(${p.values})`,
  },
  describe: {
    cat: "aggregate", icon: "📊",
    fields: [{ k: "which", type: "select", opts: ["numeric", "all"], def: "numeric" }],
    code: (p) => [
      p.which === "all"
        ? `df = df.describe(include="all").reset_index().rename(columns={"index": "stat"})`
        : `df = df.describe().reset_index().rename(columns={"index": "stat"})`,
    ],
    summary: (p) => p.which,
  },
  corr: {
    cat: "aggregate", icon: "⊗",
    fields: [{ k: "method", type: "select", opts: ["pearson", "spearman", "kendall"], def: "pearson" }],
    code: (p) => [
      `df = df.corr(numeric_only=True, method=${py.str(p.method)}).reset_index().rename(columns={"index": "column"})`,
    ],
    summary: (p) => p.method,
  },

  /* ---------------- 重塑与合并（M4） ---------------- */
  merge: {
    cat: "reshape", icon: "⋈",
    fields: [
      { k: "right", type: "dataset", req: true },
      { k: "on", type: "columns", req: true },
      { k: "how", type: "select", opts: ["inner", "left", "right", "outer"], def: "left" },
    ],
    code: (p) => [
      `df_right = pd.read_csv(${py.str((p.right || "other") + ".csv")})`,
      `df = df.merge(df_right, on=${py.list(p.on)}, how=${py.str(p.how || "left")})`,
    ],
    summary: (p) => `${p.how} ⋈ ${p.right} on ${(p.on || []).join(",")}`,
  },
  concat: {
    cat: "reshape", icon: "⊕",
    fields: [{ k: "right", type: "dataset", req: true }],
    code: (p) => [
      `df_other = pd.read_csv(${py.str((p.right || "other") + ".csv")})`,
      `df = pd.concat([df, df_other], ignore_index=True)`,
    ],
    summary: (p) => `+ ${p.right}`,
  },
  melt: {
    cat: "reshape", icon: "⇵",
    fields: [
      { k: "id_vars", type: "columns", req: true },
      { k: "value_vars", type: "columns" },
    ],
    code: (p) => {
      const vv = p.value_vars && p.value_vars.length ? `, value_vars=${py.list(p.value_vars)}` : "";
      return `df = df.melt(id_vars=${py.list(p.id_vars)}${vv}, var_name="variable", value_name="value")`;
    },
    summary: (p) => `宽→长 · id=${(p.id_vars || []).join(",")}`,
  },
  pivot: {
    cat: "reshape", icon: "⊡",
    fields: [
      { k: "index", type: "column", req: true },
      { k: "columns", type: "column", req: true },
      { k: "values", type: "column", req: true },
    ],
    code: (p) => [
      `df = df.pivot(index=${py.str(p.index)}, columns=${py.str(p.columns)}, values=${py.str(p.values)})`,
      `df = df.reset_index()`,
      `df.columns.name = None`,
    ],
    summary: (p) => `长→宽 · ${p.index} × ${p.columns}`,
  },
  transpose: {
    cat: "reshape", icon: "⇄",
    fields: [],
    code: () => [`df = df.T.reset_index().rename(columns={"index": "field"})`],
    summary: () => "行列互换 / transpose",
  },
  explode: {
    cat: "reshape", icon: "✳",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "sep", type: "text", def: ",", ph: "," },
    ],
    code: (p) => [
      `df[${py.str(p.col)}] = df[${py.str(p.col)}].astype(str).str.split(${py.str(p.sep || ",")})`,
      `df = df.explode(${py.str(p.col)}).reset_index(drop=True)`,
      `df[${py.str(p.col)}] = df[${py.str(p.col)}].str.strip()`,
    ],
    summary: (p) => `${p.col} 按 "${p.sep}" 拆成多行`,
  },
  crosstab_op: {
    cat: "reshape", icon: "▦",
    fields: [
      { k: "a", type: "column", req: true },
      { k: "b", type: "column", req: true },
      { k: "normalize", type: "select", opts: ["no", "index", "columns", "all"], def: "no" },
    ],
    code: (p) => {
      const nm = p.normalize && p.normalize !== "no" ? `, normalize=${py.str(p.normalize)}` : "";
      return [
        `df = pd.crosstab(df[${py.str(p.a)}], df[${py.str(p.b)}]${nm}).reset_index()`,
        `df.columns.name = None`,
      ];
    },
    summary: (p) => `${p.a} × ${p.b}`,
  },

  /* ---------------- 时间序列与窗口（M4） ---------------- */
  rolling: {
    cat: "timeseries", icon: "〰",
    fields: [
      { k: "col", type: "column", req: true, numeric: true },
      { k: "window", type: "number", def: 7, min: 2 },
      { k: "fn", type: "select", opts: ["mean", "sum", "std", "min", "max"], def: "mean" },
    ],
    code: (p) =>
      `df[${py.str(`${p.col}_roll${p.window}_${p.fn}`)}] = df[${py.str(p.col)}].rolling(${py.num(p.window)}, min_periods=1).${p.fn}()`,
    summary: (p) => `${p.col} 滚动${p.window} ${p.fn}`,
  },
  cumulative: {
    cat: "timeseries", icon: "∫",
    fields: [
      { k: "col", type: "column", req: true, numeric: true },
      { k: "fn", type: "select", opts: ["cumsum", "cummax", "cummin", "cumprod"], def: "cumsum" },
    ],
    code: (p) => `df[${py.str(`${p.col}_${p.fn}`)}] = df[${py.str(p.col)}].${p.fn}()`,
    summary: (p) => `${p.col}.${p.fn}()`,
  },
  shift: {
    cat: "timeseries", icon: "↦",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "periods", type: "number", def: 1 },
    ],
    code: (p) => `df[${py.str(`${p.col}_shift`)}] = df[${py.str(p.col)}].shift(${py.num(p.periods)})`,
    summary: (p) => `${p.col} 平移 ${p.periods}`,
  },
  diff: {
    cat: "timeseries", icon: "Δ",
    fields: [
      { k: "col", type: "column", req: true, numeric: true },
      { k: "periods", type: "number", def: 1 },
    ],
    code: (p) => `df[${py.str(`${p.col}_diff`)}] = df[${py.str(p.col)}].diff(${py.num(p.periods)})`,
    summary: (p) => `${p.col}.diff(${p.periods})`,
  },
  pct_change: {
    cat: "timeseries", icon: "%",
    fields: [
      { k: "col", type: "column", req: true, numeric: true },
      { k: "periods", type: "number", def: 1 },
    ],
    code: (p) => `df[${py.str(`${p.col}_pct`)}] = df[${py.str(p.col)}].pct_change(${py.num(p.periods)})`,
    summary: (p) => `${p.col} 环比变化`,
  },
  resample: {
    cat: "timeseries", icon: "📅",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "rule", type: "select", opts: ["D", "W", "ME", "QE", "YE"], def: "ME" },
      { k: "values", type: "column", req: true, numeric: true },
      { k: "fn", type: "select", opts: ["mean", "sum", "count", "min", "max"], def: "mean" },
    ],
    code: (p) => [
      `df[${py.str(p.col)}] = pd.to_datetime(df[${py.str(p.col)}], errors="coerce")`,
      `df = df.set_index(${py.str(p.col)}).resample(${py.str(p.rule)})[${py.str(p.values)}].${p.fn}().reset_index()`,
    ],
    summary: (p) => `按 ${p.rule} 重采样 · ${p.fn}(${p.values})`,
  },
  dt_extract: {
    cat: "timeseries", icon: "🕐",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "part", type: "select", opts: ["year", "month", "day", "dayofweek", "quarter", "hour"], def: "year" },
    ],
    code: (p) => [
      `df[${py.str(p.col)}] = pd.to_datetime(df[${py.str(p.col)}], errors="coerce")`,
      `df[${py.str(`${p.col}_${p.part}`)}] = df[${py.str(p.col)}].dt.${p.part}`,
    ],
    summary: (p) => `${p.col}.dt.${p.part}`,
  },

  /* ---------------- 文本处理（M4） ---------------- */
  str_contains: {
    cat: "text", icon: "⊂",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "pat", type: "text", req: true, ph: "Miss|Mrs" },
      { k: "mode", type: "select", opts: ["keep", "drop"], def: "keep" },
    ],
    code: (p) => {
      const m = `df[${py.str(p.col)}].astype(str).str.contains(${py.str(p.pat)}, case=False, na=False, regex=True)`;
      return `df = df[${p.mode === "drop" ? "~" : ""}${m}]`;
    },
    summary: (p) => `${p.mode === "drop" ? "排除" : "保留"} ${p.col} ~ /${p.pat}/`,
  },
  str_extract: {
    cat: "text", icon: "⌖",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "pat", type: "text", req: true, ph: "([A-Za-z]+)\\." },
      { k: "name", type: "text", ph: "(自动 / auto)" },
    ],
    code: (p) =>
      `df[${py.str(p.name || p.col + "_extract")}] = df[${py.str(p.col)}].astype(str).str.extract(${py.str(p.pat)}, expand=False)`,
    summary: (p) => `${p.col} 提取 /${p.pat}/`,
  },
  str_replace: {
    cat: "text", icon: "⇆",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "pat", type: "text", req: true },
      { k: "to", type: "text" },
    ],
    code: (p) =>
      `df[${py.str(p.col)}] = df[${py.str(p.col)}].astype(str).str.replace(${py.str(p.pat)}, ${py.str(p.to ?? "")}, regex=True)`,
    summary: (p) => `${p.col}: /${p.pat}/ → "${p.to ?? ""}"`,
  },
  str_split: {
    cat: "text", icon: "⫽",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "sep", type: "text", def: " ", ph: "空格 / space" },
      { k: "idx", type: "number", def: 0, min: 0 },
    ],
    code: (p) =>
      `df[${py.str(`${p.col}_part${p.idx}`)}] = df[${py.str(p.col)}].astype(str).str.split(${py.str(p.sep || " ")}).str[${py.num(p.idx)}]`,
    summary: (p) => `${p.col} 按 "${p.sep}" 取第 ${p.idx} 段`,
  },

  /* ---------------- 数值变换（M4） ---------------- */
  interpolate: {
    cat: "clean", icon: "⤳",
    fields: [
      { k: "col", type: "column", req: true, numeric: true },
      { k: "method", type: "select", opts: ["linear", "nearest", "polynomial"], def: "linear" },
    ],
    code: (p) =>
      p.method === "polynomial"
        ? `df[${py.str(p.col)}] = df[${py.str(p.col)}].interpolate(method="polynomial", order=2)`
        : `df[${py.str(p.col)}] = df[${py.str(p.col)}].interpolate(method=${py.str(p.method)})`,
    summary: (p) => `${p.col} 插值(${p.method})`,
  },
  get_dummies: {
    cat: "derive", icon: "⊞",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "drop_first", type: "select", opts: ["no", "yes"], def: "no" },
    ],
    code: (p) =>
      `df = pd.get_dummies(df, columns=${py.list([p.col])}, drop_first=${py.bool(p.drop_first === "yes")})`,
    summary: (p) => `${p.col} 独热编码`,
  },

  /* ---------------- 自定义与高级（M5） ---------------- */
  apply_fn: {
    cat: "derive", icon: "λ",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "expr", type: "expr", req: true, ph: "x * 2 if x > 100 else x" },
      { k: "name", type: "text", ph: "(覆盖原列 / overwrite)" },
    ],
    code: (p) =>
      `df[${py.str(p.name || p.col)}] = df[${py.str(p.col)}].apply(lambda x: ${p.expr})`,
    summary: (p) => `${p.col}.apply(λx: ${p.expr})`,
  },
  map_values: {
    cat: "clean", icon: "🗺",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "pairs", type: "text", req: true, ph: "male=男, female=女" },
      { k: "name", type: "text", ph: "(覆盖原列 / overwrite)" },
    ],
    code: (p) => {
      const m = {};
      String(p.pairs || "").split(",").forEach((kv) => {
        const i = kv.indexOf("=");
        if (i > 0) m[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      });
      return `df[${py.str(p.name || p.col)}] = df[${py.str(p.col)}].map(${py.strDict(m)}).fillna(df[${py.str(p.col)}])`;
    },
    summary: (p) => `${p.col}: ${p.pairs}`,
  },
  between: {
    cat: "filter", icon: "⇿",
    fields: [
      { k: "col", type: "column", req: true, numeric: true },
      { k: "lower", type: "number", req: true },
      { k: "upper", type: "number", req: true },
    ],
    code: (p) =>
      `df = df[df[${py.str(p.col)}].between(${py.num(p.lower)}, ${py.num(p.upper)})]`,
    summary: (p) => `${p.lower} ≤ ${p.col} ≤ ${p.upper}`,
  },
  isin: {
    cat: "filter", icon: "∈",
    fields: [
      { k: "col", type: "column", req: true },
      { k: "values", type: "text", req: true, ph: "A, B, C" },
      { k: "mode", type: "select", opts: ["keep", "drop"], def: "keep" },
    ],
    code: (p) => {
      const vals = String(p.values || "").split(",").map((v) => v.trim()).filter(Boolean);
      return `df = df[${p.mode === "drop" ? "~" : ""}df[${py.str(p.col)}].astype(str).isin(${py.list(vals)})]`;
    },
    summary: (p) => `${p.col} ${p.mode === "drop" ? "∉" : "∈"} {${p.values}}`,
  },
  abs_val: {
    cat: "derive", icon: "|x|",
    fields: [{ k: "col", type: "column", req: true, numeric: true }],
    code: (p) => `df[${py.str(p.col)}] = df[${py.str(p.col)}].abs()`,
    summary: (p) => `|${p.col}|`,
  },
  log_transform: {
    cat: "derive", icon: "ln",
    fields: [
      { k: "col", type: "column", req: true, numeric: true },
      { k: "base", type: "select", opts: ["log1p", "log", "log10"], def: "log1p" },
    ],
    code: (p) => {
      const fn = p.base === "log1p" ? "np.log1p" : p.base === "log10" ? "np.log10" : "np.log";
      return `df[${py.str(`${p.col}_${p.base}`)}] = ${fn}(df[${py.str(p.col)}])`;
    },
    summary: (p) => `${p.base}(${p.col})`,
  },
  minmax_scale: {
    cat: "derive", icon: "⇕",
    fields: [{ k: "col", type: "column", req: true, numeric: true }],
    code: (p) => {
      const c = py.str(p.col);
      return `df[${py.str(p.col + "_scaled")}] = (df[${c}] - df[${c}].min()) / (df[${c}].max() - df[${c}].min())`;
    },
    summary: (p) => `${p.col} → [0, 1]`,
  },
  zscore: {
    cat: "derive", icon: "σ",
    fields: [{ k: "col", type: "column", req: true, numeric: true }],
    code: (p) => {
      const c = py.str(p.col);
      return `df[${py.str(p.col + "_z")}] = (df[${c}] - df[${c}].mean()) / df[${c}].std()`;
    },
    summary: (p) => `${p.col} 标准化 / z-score`,
  },
  set_index: {
    cat: "sort", icon: "⚿",
    fields: [{ k: "col", type: "column", req: true }],
    code: (p) => `df = df.set_index(${py.str(p.col)})`,
    summary: (p) => `索引 = ${p.col}`,
  },
  sort_index: {
    cat: "sort", icon: "⇅",
    fields: [{ k: "asc", type: "select", opts: ["asc", "desc"], def: "asc" }],
    code: (p) => `df = df.sort_index(ascending=${py.bool(p.asc !== "desc")})`,
    summary: (p) => `按索引 ${p.asc === "desc" ? "↓" : "↑"}`,
  },
  select_dtypes: {
    cat: "select", icon: "⌗",
    fields: [{ k: "which", type: "select", opts: ["number", "object", "bool", "datetime"], def: "number" }],
    code: (p) => {
      const m = { number: "number", object: "object", bool: "bool", datetime: "datetime64[ns]" };
      return `df = df.select_dtypes(include=[${py.str(m[p.which] || "number")}])`;
    },
    summary: (p) => `只保留 ${p.which} 类型列`,
  },
  duplicated_flag: {
    cat: "derive", icon: "⚑",
    fields: [{ k: "cols", type: "columns" }],
    code: (p) => {
      const sub = p.cols && p.cols.length ? `subset=${py.list(p.cols)}` : "";
      return `df["is_duplicate"] = df.duplicated(${sub}, keep=False)`;
    },
    summary: (p) => (p.cols && p.cols.length ? p.cols.join(",") : "全部列 / all"),
  },
  sample_frac: {
    cat: "select", icon: "⅟",
    fields: [
      { k: "frac", type: "number", def: 0.1, min: 0 },
      { k: "seed", type: "number", def: 42 },
    ],
    code: (p) => `df = df.sample(frac=${py.num(p.frac)}, random_state=${py.num(p.seed)})`,
    summary: (p) => `抽样 ${Math.round((p.frac || 0) * 100)}%`,
  },
  group_head: {
    cat: "aggregate", icon: "⊤",
    fields: [
      { k: "by", type: "columns", req: true },
      { k: "n", type: "number", def: 3, min: 1 },
    ],
    code: (p) =>
      `df = df.groupby(${py.list(p.by)}, dropna=False).head(${py.num(p.n)})`,
    summary: (p) => `每组前 ${p.n} 行 · by ${(p.by || []).join(",")}`,
  },
  fillna_all: {
    cat: "clean", icon: "✛",
    fields: [{ k: "method", type: "select", opts: ["zero", "mean", "ffill", "bfill"], def: "zero" }],
    code: (p) => {
      switch (p.method) {
        case "mean":  return `df = df.fillna(df.mean(numeric_only=True))`;
        case "ffill": return `df = df.ffill()`;
        case "bfill": return `df = df.bfill()`;
        default:      return `df = df.fillna(0)`;
      }
    },
    summary: (p) => `全表填充 · ${p.method}`,
  },
};

/* 分类顺序与图标（用于"添加操作"面板分组） */
export const CATEGORIES = ["select", "filter", "sort", "clean", "derive", "aggregate", "reshape", "timeseries", "text"];

/** 生成某一步的代码（统一返回字符串数组） */
export function stepCode(step) {
  const def = OPS[step.op];
  if (!def) return [`# unknown op: ${step.op}`];
  const out = def.code(step.params || {});
  return Array.isArray(out) ? out : [out];
}

/** 生成整条管道的完整脚本 */
export function pipelineCode(datasetName, steps, { withHeader = true } = {}) {
  const lines = [];
  if (withHeader) {
    lines.push("import pandas as pd", "");
  }
  lines.push(`df = pd.read_csv(${py.str(datasetName + ".csv")})`);
  for (const s of steps) {
    if (!s.enabled) continue;
    lines.push(...stepCode(s));
  }
  return lines.join("\n");
}
