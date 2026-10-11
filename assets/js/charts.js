/* =============================================================
 * charts.js —— 图表渲染与自动荐图
 * -------------------------------------------------------------
 * 荐图规则按"选了几列、各是什么类型"决定——这是可视化里
 * 最基本的编码选择逻辑：类型决定可用的通道，通道决定图表。
 * ============================================================= */

const C = {
  accent: "#156082", accent2: "#c2610f", good: "#1a7f52",
  purple: "#7a4fc0", line: "#eef2f7", text: "#51607a", faint: "#8593a8",
};
const SERIES = ["#156082", "#c2610f", "#7a4fc0", "#1a7f52", "#b4332c", "#2a8fb8", "#b4790b", "#4a7a9e"];

const base = () => ({
  textStyle: { fontFamily: "inherit", color: C.text },
  grid: { left: 52, right: 16, top: 28, bottom: 42, containLabel: true },
  tooltip: { trigger: "item", confine: true },
});
const axisStyle = {
  axisLine: { lineStyle: { color: "#d8e0ea" } },
  axisTick: { show: false },
  axisLabel: { fontSize: 10, color: C.faint },
  splitLine: { lineStyle: { color: C.line } },
};

/**
 * 根据选中的列给出可用图表类型，第一个是推荐项
 * @param {object[]} cols 已选列 [{name, kind}]
 */
export function suggest(cols) {
  const k = cols.map((c) => c.kind);
  if (cols.length === 1) {
    if (k[0] === "number") return ["histogram", "box1"];
    return ["valueCounts", "pie"];
  }
  if (cols.length === 2) {
    const [a, b] = cols;
    if (a.kind === "number" && b.kind === "number") return ["scatter", "line"];
    if (a.kind === "datetime" && b.kind === "number") return ["line", "scatter"];
    if (b.kind === "datetime" && a.kind === "number") return ["line", "scatter"];
    const cat = a.kind === "number" ? b : a;
    const num = a.kind === "number" ? a : b;
    if (num.kind === "number" && cat.kind !== "number") return ["aggBar", "box", "scatter"];
    return ["crosstab"];          // 两个类别 → 交叉热力图
  }
  return [];
}

/** 图表类型 → 需要向 Python 请求的数据 kind 与参数 */
export function buildRequest(type, cols, opts = {}) {
  const [a, b] = cols;
  switch (type) {
    case "histogram": return { kind: "histogram", args: { col: a.name, bins: opts.bins || 30 } };
    case "box1":      return { kind: "box", args: { cat: null, num: a.name } };
    case "valueCounts":
    case "pie":       return { kind: "valueCounts", args: { col: a.name, top: opts.top || 20 } };
    case "scatter":   return { kind: "scatter", args: { x: a.name, y: b.name, color: opts.color || null } };
    case "line": {
      const x = a.kind === "number" && b.kind === "datetime" ? b : a;
      const y = x === a ? b : a;
      return { kind: "line", args: { x: x.name, y: y.name, how: opts.how || "mean" } };
    }
    case "aggBar": {
      const cat = a.kind === "number" ? b : a;
      const num = a.kind === "number" ? a : b;
      return { kind: "aggBar", args: { cat: cat.name, num: num.name, how: opts.how || "mean" } };
    }
    case "box": {
      const cat = a.kind === "number" ? b : a;
      const num = a.kind === "number" ? a : b;
      return { kind: "box", args: { cat: cat.name, num: num.name } };
    }
    case "crosstab":  return { kind: "crosstab", args: { a: a.name, b: b.name } };
    default: return null;
  }
}

/** 把 Python 返回的数据画成 ECharts option */
export function buildOption(type, data, cols, t) {
  const [a, b] = cols;
  switch (type) {
    case "histogram":
      return {
        ...base(),
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, confine: true },
        xAxis: { type: "category", data: data.labels, name: a.name, nameLocation: "middle", nameGap: 26,
          nameTextStyle: { fontSize: 10, color: C.faint }, ...axisStyle,
          axisLabel: { ...axisStyle.axisLabel, interval: Math.max(0, Math.floor(data.labels.length / 8)) } },
        yAxis: { type: "value", ...axisStyle },
        series: [{ type: "bar", data: data.counts, itemStyle: { color: C.accent }, barCategoryGap: "8%" }],
      };

    case "valueCounts":
      return {
        ...base(),
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, confine: true },
        grid: { ...base().grid, left: 8, containLabel: true },
        xAxis: { type: "value", ...axisStyle },
        yAxis: { type: "category", data: [...data.labels].reverse(), ...axisStyle,
          axisLabel: { ...axisStyle.axisLabel, width: 92, overflow: "truncate" } },
        series: [{ type: "bar", data: [...data.counts].reverse(),
          itemStyle: { color: C.purple, borderRadius: [0, 3, 3, 0] } }],
      };

    case "pie":
      return {
        ...base(),
        legend: { type: "scroll", bottom: 0, textStyle: { fontSize: 10, color: C.faint } },
        color: SERIES,
        series: [{
          type: "pie", radius: ["38%", "66%"], center: ["50%", "44%"],
          data: data.labels.map((l, i) => ({ name: l, value: data.counts[i] })),
          label: { fontSize: 10 }, itemStyle: { borderColor: "#fff", borderWidth: 1.5 },
        }],
      };

    case "scatter": {
      const pts = data.x.map((v, i) => [v, data.y[i]]);
      return {
        ...base(),
        tooltip: { trigger: "item", confine: true,
          formatter: (p) => `${a.name}: ${p.value[0]}<br/>${b.name}: ${p.value[1]}` },
        xAxis: { type: "value", name: a.name, nameLocation: "middle", nameGap: 26,
          nameTextStyle: { fontSize: 10, color: C.faint }, scale: true, ...axisStyle },
        yAxis: { type: "value", name: b.name, nameTextStyle: { fontSize: 10, color: C.faint },
          scale: true, ...axisStyle },
        series: [{ type: "scatter", data: pts, symbolSize: 5,
          itemStyle: { color: C.accent, opacity: .55 } }],
      };
    }

    case "line":
      return {
        ...base(),
        tooltip: { trigger: "axis", confine: true },
        xAxis: { type: "category", data: data.labels, ...axisStyle,
          axisLabel: { ...axisStyle.axisLabel, interval: Math.max(0, Math.floor(data.labels.length / 8)) } },
        yAxis: { type: "value", scale: true, ...axisStyle },
        series: [{ type: "line", data: data.values, smooth: true, symbolSize: 4,
          lineStyle: { color: C.accent, width: 2 }, itemStyle: { color: C.accent },
          areaStyle: { color: "rgba(21,96,130,.10)" } }],
      };

    case "aggBar":
      return {
        ...base(),
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, confine: true },
        xAxis: { type: "category", data: data.labels, ...axisStyle,
          axisLabel: { ...axisStyle.axisLabel, rotate: data.labels.some((l) => String(l).length > 6) ? 32 : 0 } },
        yAxis: { type: "value", scale: true, ...axisStyle },
        series: [{ type: "bar", data: data.values,
          itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] } }],
      };

    case "box":
    case "box1":
      return {
        ...base(),
        tooltip: { trigger: "item", confine: true },
        xAxis: { type: "category", data: data.groups.length ? data.groups : [""], ...axisStyle },
        yAxis: { type: "value", scale: true, ...axisStyle },
        series: [
          { type: "boxplot", data: data.box, itemStyle: { color: "#e7f1f6", borderColor: C.accent } },
          { type: "scatter", data: data.outliers, symbolSize: 4,
            itemStyle: { color: C.accent2, opacity: .6 } },
        ],
      };

    case "crosstab": {
      const pts = [];
      let max = 0;
      data.matrix.forEach((row, i) => row.forEach((v, j) => { pts.push([j, i, v]); if (v > max) max = v; }));
      return {
        ...base(),
        grid: { left: 8, right: 16, top: 16, bottom: 56, containLabel: true },
        tooltip: { position: "top", confine: true,
          formatter: (p) => `${data.rows[p.value[1]]} × ${data.cols[p.value[0]]}<br/><b>${p.value[2]}</b>` },
        xAxis: { type: "category", data: data.cols, splitArea: { show: true }, ...axisStyle,
          axisLabel: { ...axisStyle.axisLabel, rotate: 32 } },
        yAxis: { type: "category", data: data.rows, splitArea: { show: true }, ...axisStyle },
        visualMap: { min: 0, max: max || 1, calculable: true, orient: "horizontal",
          left: "center", bottom: 0, itemHeight: 70, itemWidth: 10,
          textStyle: { fontSize: 9, color: C.faint },
          inRange: { color: ["#eef4f8", "#9cc4d6", C.accent] } },
        series: [{ type: "heatmap", data: pts,
          label: { show: pts.length <= 60, fontSize: 9 },
          itemStyle: { borderColor: "#fff", borderWidth: 1 } }],
      };
    }

    default:
      return null;
  }
}

/** 相关性热力图 */
export function corrOption(data) {
  const pts = [];
  data.matrix.forEach((row, i) => row.forEach((v, j) => pts.push([j, i, v == null ? "-" : +v.toFixed(2)])));
  const n = data.labels.length;
  return {
    ...base(),
    grid: { left: 8, right: 14, top: 14, bottom: 60, containLabel: true },
    tooltip: { position: "top", confine: true,
      formatter: (p) => `${data.labels[p.value[1]]} × ${data.labels[p.value[0]]}<br/><b>${p.value[2]}</b>` },
    xAxis: { type: "category", data: data.labels, ...axisStyle,
      axisLabel: { ...axisStyle.axisLabel, rotate: 38 }, splitArea: { show: true } },
    yAxis: { type: "category", data: data.labels, ...axisStyle, splitArea: { show: true } },
    visualMap: { min: -1, max: 1, calculable: true, orient: "horizontal",
      left: "center", bottom: 0, itemWidth: 10, itemHeight: 90,
      textStyle: { fontSize: 9, color: C.faint },
      inRange: { color: ["#b4332c", "#f3f6f9", C.accent] } },
    series: [{ type: "heatmap", data: pts,
      label: { show: n <= 12, fontSize: 9 },
      itemStyle: { borderColor: "#fff", borderWidth: 1 } }],
  };
}

/** 缺失值矩阵：行分带 × 列，颜色深浅表示该带的缺失比例 */
export function missingOption(data) {
  const pts = [];
  data.matrix.forEach((row, i) => row.forEach((v, j) => pts.push([j, i, +(v * 100).toFixed(1)])));
  return {
    ...base(),
    grid: { left: 8, right: 14, top: 14, bottom: 70, containLabel: true },
    tooltip: { position: "top", confine: true,
      formatter: (p) => `${data.columns[p.value[0]]}<br/>缺失 / missing: <b>${p.value[2]}%</b>` },
    xAxis: { type: "category", data: data.columns, ...axisStyle,
      axisLabel: { ...axisStyle.axisLabel, rotate: 42 } },
    yAxis: { type: "category", data: data.matrix.map((_, i) => i), show: false },
    visualMap: { min: 0, max: 100, calculable: true, orient: "horizontal",
      left: "center", bottom: 0, itemWidth: 10, itemHeight: 90,
      text: ["100%", "0%"], textStyle: { fontSize: 9, color: C.faint },
      inRange: { color: ["#f3f6f9", "#f0c9a0", "#b4332c"] } },
    series: [{ type: "heatmap", data: pts, itemStyle: { borderWidth: 0 } }],
  };
}
