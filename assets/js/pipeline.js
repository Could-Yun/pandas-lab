/* =============================================================
 * pipeline.js —— 管道状态与执行编排
 * -------------------------------------------------------------
 * 管道 = 有序的步骤列表。每步带一个"前缀哈希"，标识执行完该步
 * 之后的数据帧状态。只要前缀没变，Python 侧就能直接复用缓存，
 * 因此改动靠后的步骤几乎是瞬时的。
 * ============================================================= */

import { OPS, stepCode, pipelineCode } from "./ops.js?v=2";

/* FNV-1a 32 位哈希：短、快、碰撞率对本场景足够 */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

let uid = 0;

export class Pipeline {
  constructor() {
    this.datasetName = null;
    this.steps = [];          // [{id, op, params, enabled, shape}]
    this.onChange = () => {};
    this._undo = [];          // 历史快照栈
    this._redo = [];
    this._muted = false;      // 撤销/重做回放时不再记历史
  }

  reset(datasetName) {
    this.datasetName = datasetName;
    this.steps = [];
    this._undo = [];
    this._redo = [];
    this.onChange();
  }

  /** 变更前记录快照，供撤销使用 */
  _snapshot() {
    if (this._muted) return;
    this._undo.push(JSON.stringify(this.steps.map(({ op, params, enabled }) => ({ op, params, enabled }))));
    if (this._undo.length > 50) this._undo.shift();
    this._redo.length = 0;
  }

  _restore(json) {
    const arr = JSON.parse(json);
    this.steps = arr.map((s) => ({
      id: `s${++uid}`, op: s.op, params: s.params || {},
      enabled: s.enabled !== false, shape: null,
    }));
  }

  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  undo() {
    if (!this._undo.length) return;
    const cur = JSON.stringify(this.steps.map(({ op, params, enabled }) => ({ op, params, enabled })));
    this._redo.push(cur);
    this._muted = true;
    this._restore(this._undo.pop());
    this._muted = false;
    this.onChange();
  }

  redo() {
    if (!this._redo.length) return;
    const cur = JSON.stringify(this.steps.map(({ op, params, enabled }) => ({ op, params, enabled })));
    this._undo.push(cur);
    this._muted = true;
    this._restore(this._redo.pop());
    this._muted = false;
    this.onChange();
  }

  add(op, params = {}) {
    const def = OPS[op];
    if (!def) return null;
    this._snapshot();
    // 用字段默认值补全
    const p = { ...params };
    (def.fields || []).forEach((f) => {
      if (p[f.k] === undefined && f.def !== undefined) p[f.k] = f.def;
    });
    const step = { id: `s${++uid}`, op, params: p, enabled: true, shape: null };
    this.steps.push(step);
    this.onChange();
    return step;
  }

  /** 清空所有步骤（会触发重算回到原始数据） */
  clear() {
    if (!this.steps.length) return;
    this._snapshot();
    this.steps = [];
    this.onChange();
  }

  remove(id) {
    this._snapshot();
    this.steps = this.steps.filter((s) => s.id !== id);
    this.onChange();
  }

  update(id, params) {
    const s = this.steps.find((x) => x.id === id);
    if (!s) return;
    this._snapshot();
    s.params = { ...s.params, ...params };
    this.onChange();
  }

  toggle(id) {
    const s = this.steps.find((x) => x.id === id);
    if (!s) return;
    this._snapshot();
    s.enabled = !s.enabled;
    this.onChange();
  }

  /** 把 from 位置的步骤移动到 to 位置 */
  move(from, to) {
    if (from === to || from < 0 || to < 0 || from >= this.steps.length || to >= this.steps.length) return;
    this._snapshot();
    const [s] = this.steps.splice(from, 1);
    this.steps.splice(to, 0, s);
    this.onChange();
  }

  get enabledSteps() { return this.steps.filter((s) => s.enabled); }

  /**
   * 构造给 Worker 的执行载荷：每步 {hash, code}
   * hash 为「数据集名 + 截至该步的全部代码」的累积哈希
   */
  buildPayload() {
    const payload = [];
    let acc = `@${this.datasetName}`;
    for (const s of this.enabledSteps) {
      const code = stepCode(s).join("\n");
      acc += "\n" + code;
      payload.push({ hash: hash32(acc), code });
      s._hash = hash32(acc);
    }
    return payload;
  }

  /** 完整 pandas 脚本（用于代码面板与导出） */
  code() {
    return pipelineCode(this.datasetName || "data", this.steps);
  }

  serialize() {
    return JSON.stringify({
      dataset: this.datasetName,
      steps: this.steps.map(({ op, params, enabled }) => ({ op, params, enabled })),
    });
  }

  load(json) {
    const o = typeof json === "string" ? JSON.parse(json) : json;
    this.steps = (o.steps || []).map((s) => ({
      id: `s${++uid}`, op: s.op, params: s.params || {},
      enabled: s.enabled !== false, shape: null,
    }));
    this.onChange();
  }
}
