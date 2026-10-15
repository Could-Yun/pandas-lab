/* =============================================================
 * Pyodide Worker —— 真 pandas 执行引擎
 * -------------------------------------------------------------
 * 放在 Worker 里的原因：pandas 计算可能耗时数百毫秒到数秒，
 * 跑在主线程会冻结界面。Worker 保证 UI 永远可响应。
 *
 * 协议：主线程 postMessage({id, type, payload})
 *       Worker 回 postMessage({id, ok, result|error})
 *       另有无 id 的 {type:'status'} 消息用于加载进度广播。
 * ============================================================= */

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let pyodide = null;
let ready = false;

/* ---------- 向主线程广播状态 ---------- */
function status(phase, detail, progress) {
  self.postMessage({ type: "status", phase, detail, progress });
}

/* ---------- 启动 Pyodide ---------- */
async function boot() {
  try {
    status("loading", "pyodide-core", 0.05);
    importScripts(PYODIDE_BASE + "pyodide.js");

    pyodide = await self.loadPyodide({
      indexURL: PYODIDE_BASE,
      stdout: (s) => self.postMessage({ type: "stdout", text: s }),
      stderr: (s) => self.postMessage({ type: "stderr", text: s }),
    });
    status("loading", "runtime-ready", 0.45);

    // 只装必需包：pandas 会自动带上 numpy。不碰 matplotlib/scipy（体积大且用不到）
    status("loading", "pandas", 0.5);
    await pyodide.loadPackage(["pandas"], {
      messageCallback: (m) => status("loading", m, 0.7),
      errorCallback: (m) => self.postMessage({ type: "stderr", text: m }),
    });
    status("loading", "warmup", 0.9);

    // 预热 + 准备运行时辅助函数
    await pyodide.runPythonAsync(`
import json, io, math
import pandas as pd
import numpy as np

# 全局命名空间：数据集 registry 与管道中间结果缓存
_DATASETS = {}     # name -> 原始 DataFrame
_CACHE = {}        # 管道前缀哈希 -> DataFrame
pd.set_option("display.max_columns", None)

def _jsonable(v):
    """把单个值转成能安全 JSON 序列化的形式"""
    if v is None:
        return None
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return v
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, (pd.Timestamp,)):
        return v.isoformat()
    if v is pd.NaT:
        return None
    if isinstance(v, (np.ndarray, list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, (int, str)):
        return v
    try:
        if pd.isna(v):
            return None
    except Exception:
        pass
    return str(v)

def _col_kind(s):
    """把 dtype 归类为 UI 用的几种：number / category / datetime / bool / text"""
    if pd.api.types.is_bool_dtype(s):
        return "bool"
    if pd.api.types.is_numeric_dtype(s):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(s):
        return "datetime"
    nun = s.nunique(dropna=True)
    if nun <= max(20, int(len(s) * 0.05)):
        return "category"
    return "text"

def describe_frame(df, sample_rows=0):
    """返回 UI 需要的结构化摘要（不含完整数据）"""
    cols = []
    n = len(df)
    for name in df.columns:
        s = df[name]
        kind = _col_kind(s)
        info = {
            "name": str(name),
            "dtype": str(s.dtype),
            "kind": kind,
            "nulls": int(s.isna().sum()),
            "unique": int(s.nunique(dropna=True)),
        }
        try:
            if kind == "number" and n > 0:
                d = s.dropna()
                if len(d) > 0:
                    info["min"] = _jsonable(d.min())
                    info["max"] = _jsonable(d.max())
                    info["mean"] = _jsonable(d.mean())
                    info["std"] = _jsonable(d.std())
                    # 迷你直方图：固定 20 桶
                    cnt, edges = np.histogram(d.values.astype(float), bins=20)
                    info["hist"] = [int(c) for c in cnt]
                    info["bins"] = [_jsonable(e) for e in edges]
            elif kind in ("category", "bool", "text"):
                vc = s.astype("object").value_counts(dropna=True).head(8)
                info["top"] = [[_jsonable(k), int(v)] for k, v in vc.items()]
        except Exception as e:
            info["statError"] = str(e)
        cols.append(info)
    return {"rows": int(n), "cols": len(df.columns), "columns": cols}

def slice_rows(df, start, count):
    """取一段行，转成 UI 表格用的二维数组"""
    sub = df.iloc[start:start + count]
    data = []
    for _, row in sub.iterrows():
        data.append([_jsonable(v) for v in row.tolist()])
    return {
        "start": int(start),
        "index": [_jsonable(i) for i in sub.index.tolist()],
        "data": data,
    }

_RESULT = None   # 管道最终结果

class _PdProxy:
    """
    pandas 的透明代理，只改写 read_csv。

    目的：让 merge/concat 这类需要第二份数据的操作，生成的代码写成
    标准的 pd.read_csv("iris.csv") —— 在本工作台里它命中已注册的数据集，
    复制到 Jupyter 里它就是真的读文件。显示的代码和执行的代码因此完全一致，
    不需要为"能跑"而生成另一套只在这里有效的写法。
    """
    def __init__(self, real):
        object.__setattr__(self, "_real", real)

    def __getattr__(self, k):
        return getattr(object.__getattribute__(self, "_real"), k)

    def read_csv(self, path, **kw):
        key = str(path).replace("\\\\", "/").rsplit("/", 1)[-1]
        if key.lower().endswith(".csv"):
            key = key[:-4]
        if key in _DATASETS:
            return _DATASETS[key].copy()
        return object.__getattribute__(self, "_real").read_csv(path, **kw)

_PD = _PdProxy(pd)

def run_pipeline(name, steps):
    """
    按顺序执行管道。steps = [{"hash": 前缀哈希, "code": "..."}]

    记忆化：hash 标识"执行完该步之后"的数据帧状态。命中缓存就直接取，
    于是修改第 N 步时前 N-1 步完全不用重算——这是管道可以随意拖拽
    重排、实时改参数却依然流畅的原因。
    """
    global _RESULT
    df = _DATASETS[name]
    for st in steps:
        h = st["hash"]
        if h in _CACHE:
            df = _CACHE[h]
            continue
        # 必须传副本：像 df["新列"] = ... 这类原地赋值会改到上游对象本身，
        # 既会污染 _DATASETS 里的原始数据集，也会弄脏 _CACHE 中的中间结果。
        # 复制的代价（20 万行约几毫秒）远低于状态被悄悄改坏的代价。
        ns = {"pd": _PD, "np": np, "df": df.copy()}
        exec(st["code"], ns)
        df = ns["df"]
        if not isinstance(df, pd.DataFrame):
            df = pd.DataFrame(df)
        _CACHE[h] = df
    _RESULT = df
    return df

def trim_cache(valid_hashes, limit=40):
    """丢弃不再属于当前管道的缓存，避免内存无限增长"""
    keep = set(valid_hashes)
    for k in list(_CACHE.keys()):
        if k not in keep:
            del _CACHE[k]
    if len(_CACHE) > limit:
        for k in list(_CACHE.keys())[: len(_CACHE) - limit]:
            del _CACHE[k]

# =============================================================
# 图表数据：一律在 pandas 侧聚合完再回传，
# 前端只拿到几百个点，再大的数据集也不会卡在序列化上。
# =============================================================

def _cur():
    if _RESULT is None:
        raise ValueError("no data")
    return _RESULT

def ch_histogram(col, bins=30):
    s = _cur()[col].dropna().astype(float)
    if len(s) == 0:
        return {"labels": [], "counts": []}
    cnt, edges = np.histogram(s.values, bins=int(bins))
    labels = [f"{_fmt(edges[i])}" for i in range(len(cnt))]
    return {"labels": labels, "counts": [int(c) for c in cnt],
            "edges": [_jsonable(e) for e in edges]}

def ch_value_counts(col, top=20):
    vc = _cur()[col].astype("object").value_counts(dropna=False).head(int(top))
    return {"labels": [("NaN" if pd.isna(k) else str(k)) for k in vc.index],
            "counts": [int(v) for v in vc.values]}

def ch_scatter(x, y, color=None, limit=4000):
    df = _cur()
    cols = [x, y] + ([color] if color else [])
    sub = df[cols].dropna()
    n = len(sub)
    if n > limit:
        sub = sub.sample(n=int(limit), random_state=0)
    out = {"x": [_jsonable(v) for v in sub[x].tolist()],
           "y": [_jsonable(v) for v in sub[y].tolist()],
           "total": int(n), "shown": int(len(sub))}
    if color:
        out["c"] = [_jsonable(v) for v in sub[color].tolist()]
        out["groups"] = [str(g) for g in sub[color].astype("object").unique()[:12]]
    return out

def _box_stats(v):
    """返回 [下须, Q1, 中位数, Q3, 上须] 与离群点，按 1.5×IQR 规则"""
    q1, med, q3 = v.quantile(.25), v.quantile(.5), v.quantile(.75)
    iqr = q3 - q1
    inner_lo, inner_hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    within = v[(v >= inner_lo) & (v <= inner_hi)]
    lo = within.min() if len(within) else v.min()
    hi = within.max() if len(within) else v.max()
    out = v[(v < inner_lo) | (v > inner_hi)]
    return [lo, q1, med, q3, hi], out

def ch_box_by(cat, num, max_groups=12):
    # cat 为 None 时画单个箱（不分组）——对应"选中一个数值列"的场景
    if cat is None:
        v = _cur()[num].dropna().astype(float)
        if len(v) == 0:
            return {"groups": [], "box": [], "outliers": []}
        stats, out = _box_stats(v)
        return {
            "groups": [str(num)],
            "box": [[_jsonable(x) for x in stats]],
            "outliers": [[0, _jsonable(o)] for o in out.head(60)],
        }

    df = _cur()[[cat, num]].dropna()
    groups, data, outliers = [], [], []
    for i, (g, sub) in enumerate(df.groupby(cat, dropna=False)):
        if i >= max_groups:
            break
        v = sub[num].astype(float)
        if len(v) == 0:
            continue
        stats, out = _box_stats(v)
        groups.append(str(g))
        data.append([_jsonable(x) for x in stats])
        for ov in out.head(40):
            outliers.append([len(groups) - 1, _jsonable(ov)])
    return {"groups": groups, "box": data, "outliers": outliers}

def ch_agg_bar(cat, num, how="mean", top=20):
    df = _cur()[[cat, num]].dropna()
    g = getattr(df.groupby(cat, dropna=False)[num], how)()
    g = g.sort_values(ascending=False).head(int(top))
    return {"labels": [str(k) for k in g.index], "values": [_jsonable(v) for v in g.values]}

def ch_line(x, y, how="mean"):
    df = _cur()[[x, y]].dropna()
    g = getattr(df.groupby(x, dropna=False)[y], how)().sort_index()
    return {"labels": [_jsonable(k) for k in g.index], "values": [_jsonable(v) for v in g.values]}

def ch_crosstab(a, b, max_levels=15):
    df = _cur()
    ct = pd.crosstab(df[a], df[b])
    ct = ct.iloc[:max_levels, :max_levels]
    return {"rows": [str(r) for r in ct.index], "cols": [str(c) for c in ct.columns],
            "matrix": [[int(v) for v in row] for row in ct.values]}

def ch_corr(method="pearson"):
    c = _cur().corr(numeric_only=True, method=method)
    labels = [str(x) for x in c.columns]
    return {"labels": labels,
            "matrix": [[_jsonable(v) for v in row] for row in c.values]}

def ch_missing(bands=60):
    """缺失值矩阵：把行分成若干带，算每带每列的缺失比例"""
    df = _cur()
    n = len(df)
    if n == 0:
        return {"columns": [], "bands": 0, "matrix": []}
    bands = min(int(bands), n)
    idx = np.array_split(np.arange(n), bands)
    cols = list(df.columns)
    mat = []
    na = df.isna().values
    for part in idx:
        mat.append([float(na[part, j].mean()) for j in range(len(cols))])
    return {"columns": [str(c) for c in cols], "bands": bands, "matrix": mat,
            "totals": [int(df[c].isna().sum()) for c in cols]}

def ch_profile():
    """一键数据体检：整体概况 + 每列画像"""
    df = _cur()
    n = len(df)
    dup = int(df.duplicated().sum())
    total_cells = n * max(1, len(df.columns))
    out = {
        "rows": int(n), "cols": int(len(df.columns)),
        "duplicates": dup,
        "totalNulls": int(df.isna().sum().sum()),
        "nullRate": float(df.isna().sum().sum() / total_cells) if total_cells else 0.0,
        "memoryKB": float(df.memory_usage(deep=True).sum() / 1024),
        "columns": describe_frame(df)["columns"],
    }
    return out

def _fmt(v):
    try:
        f = float(v)
        if abs(f) >= 1000: return f"{f:.0f}"
        if abs(f) >= 1:    return f"{f:.2f}".rstrip("0").rstrip(".")
        return f"{f:.3g}"
    except Exception:
        return str(v)
`);

    ready = true;
    const ver = pyodide.runPython("pd.__version__");
    status("ready", `pandas ${ver}`, 1);
  } catch (err) {
    status("error", String(err && err.message ? err.message : err), 0);
  }
}

const bootPromise = boot();

/* ---------- 请求分发 ---------- */
const handlers = {
  /** 注册一份 CSV 文本为数据集 */
  async loadCSV({ name, text }) {
    pyodide.globals.set("_csv_text", text);
    pyodide.globals.set("_csv_name", name);
    await pyodide.runPythonAsync(`
_DATASETS[_csv_name] = pd.read_csv(io.StringIO(_csv_text))
_CACHE.clear()
# 同时把它设为"当前结果"：管道为空时，图表与数据体检要有东西可取
_RESULT = _DATASETS[_csv_name]
`);
    const summary = pyodide.runPython(
      `json.dumps(describe_frame(_DATASETS[${JSON.stringify(name)}]))`
    );
    return JSON.parse(summary);
  },

  /**
   * 执行任意 Python 代码。
   * 在模块全局命名空间里跑，使其能访问 _DATASETS / _CACHE / _RESULT 等运行时状态
   * （这是 REPL 该有的语义；用隔离命名空间会让注册数据集、清缓存之类的操作失效）。
   */
  async exec({ code }) {
    pyodide.globals.set("_user_code", code);
    const out = await pyodide.runPythonAsync(`
try:
    exec(_user_code, globals())
    _r = {"ok": True}
except Exception as _e:
    import traceback
    _r = {"ok": False, "error": f"{type(_e).__name__}: {_e}",
          "trace": traceback.format_exc().splitlines()[-3:]}
json.dumps(_r)
`);
    const r = JSON.parse(out);
    if (!r.ok) throw new Error(r.error + (r.trace ? "\n" + r.trace.join("\n") : ""));
    return r;
  },

  /** 取某个数据集的行切片 */
  async rows({ name, start, count }) {
    const out = pyodide.runPython(
      `json.dumps(slice_rows(_DATASETS[${JSON.stringify(name)}], ${start | 0}, ${count | 0}))`
    );
    return JSON.parse(out);
  },

  /** 执行整条管道，返回最终结果的摘要 */
  async pipeline({ name, steps }) {
    pyodide.globals.set("_pipe_name", name);
    pyodide.globals.set("_pipe_steps", pyodide.toPy(steps));
    const out = await pyodide.runPythonAsync(`
_steps = [dict(s) for s in _pipe_steps.to_py()] if hasattr(_pipe_steps, "to_py") else _pipe_steps
try:
    _df = run_pipeline(_pipe_name, _steps)
    trim_cache([s["hash"] for s in _steps])
    _out = describe_frame(_df)
    _out["ok"] = True
except Exception as _e:
    import traceback
    _out = {"ok": False, "error": f"{type(_e).__name__}: {_e}",
            "trace": traceback.format_exc().splitlines()[-3:]}
json.dumps(_out)
`);
    return JSON.parse(out);
  },

  /** 取管道结果的行切片 */
  async resultRows({ start, count }) {
    const out = pyodide.runPython(
      `json.dumps(slice_rows(_RESULT, ${start | 0}, ${count | 0})) if _RESULT is not None else json.dumps({"start":0,"index":[],"data":[]})`
    );
    return JSON.parse(out);
  },

  /** 图表数据：统一入口，kind 决定调用哪个聚合函数 */
  async chart({ kind, args }) {
    const a = args || {};
    // JS 的 null/undefined 经 JSON.stringify 会变成字符串 "null"，
    // 拼进 Python 代码就是未定义的标识符。统一用这个转换器生成合法字面量。
    const lit = (v) => {
      if (v === null || v === undefined) return "None";
      if (typeof v === "boolean") return v ? "True" : "False";
      if (typeof v === "number") return Number.isFinite(v) ? String(v) : "None";
      return JSON.stringify(String(v));
    };
    const call = {
      histogram:    () => `ch_histogram(${lit(a.col)}, ${a.bins || 30})`,
      valueCounts:  () => `ch_value_counts(${lit(a.col)}, ${a.top || 20})`,
      scatter:      () => `ch_scatter(${lit(a.x)}, ${lit(a.y)}, ${lit(a.color)})`,
      box:          () => `ch_box_by(${lit(a.cat)}, ${lit(a.num)})`,
      aggBar:       () => `ch_agg_bar(${lit(a.cat)}, ${lit(a.num)}, ${lit(a.how || "mean")})`,
      line:         () => `ch_line(${lit(a.x)}, ${lit(a.y)}, ${lit(a.how || "mean")})`,
      crosstab:     () => `ch_crosstab(${lit(a.a)}, ${lit(a.b)})`,
      corr:         () => `ch_corr(${lit(a.method || "pearson")})`,
      missing:      () => `ch_missing()`,
      profile:      () => `ch_profile()`,
    }[kind];
    if (!call) throw new Error("unknown chart kind: " + kind);

    pyodide.globals.set("_chart_expr", call());
    const out = await pyodide.runPythonAsync(`
try:
    _res = eval(_chart_expr)
    _res["ok"] = True
except Exception as _e:
    _res = {"ok": False, "error": f"{type(_e).__name__}: {_e}"}
json.dumps(_res)
`);
    const r = JSON.parse(out);
    if (!r.ok) throw new Error(r.error);
    return r;
  },

  /** 把管道结果导出为 CSV / JSON 文本 */
  async exportResult({ format }) {
    const expr =
      format === "json"
        ? `_RESULT.to_json(orient="records", force_ascii=False, indent=2)`
        : `_RESULT.to_csv(index=False)`;
    return pyodide.runPython(`${expr} if _RESULT is not None else ""`);
  },

  /** 取摘要 */
  async summary({ name }) {
    const out = pyodide.runPython(
      `json.dumps(describe_frame(_DATASETS[${JSON.stringify(name)}]))`
    );
    return JSON.parse(out);
  },

  async ping() {
    return { ready, version: pyodide ? pyodide.runPython("pd.__version__") : null };
  },
};

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};
  if (!id) return;
  try {
    await bootPromise;
    if (!ready) throw new Error("引擎未就绪 / engine not ready");
    const fn = handlers[type];
    if (!fn) throw new Error("未知请求类型 / unknown request: " + type);
    const result = await fn(payload || {});
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
};
