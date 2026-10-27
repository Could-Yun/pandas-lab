/* =============================================================
 * engine.js —— 与 Pyodide Worker 的 RPC 封装
 * 主线程只通过这里和 Python 打交道；所有调用返回 Promise。
 * ============================================================= */

export class Engine {
  constructor(workerUrl) {
    this.worker = new Worker(workerUrl, { type: "classic" });
    this.seq = 0;
    this.pending = new Map();
    this.ready = false;
    this.version = null;

    /** 状态回调：({phase, detail, progress}) => void */
    this.onStatus = () => {};
    /** Python stdout/stderr 回调 */
    this.onOutput = () => {};

    this._readyResolvers = [];

    this.worker.onmessage = (e) => {
      const msg = e.data || {};

      if (msg.type === "status") {
        if (msg.phase === "ready") {
          this.ready = true;
          this.version = msg.detail;
          this._readyResolvers.forEach((r) => r());
          this._readyResolvers = [];
        }
        this.onStatus(msg);
        return;
      }

      if (msg.type === "stdout" || msg.type === "stderr") {
        this.onOutput(msg.type, msg.text);
        return;
      }

      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
    };

    this.worker.onerror = (e) => {
      this.onStatus({ type: "status", phase: "error", detail: e.message || "worker error", progress: 0 });
    };
  }

  /** 等待引擎就绪 */
  whenReady() {
    if (this.ready) return Promise.resolve();
    return new Promise((res) => this._readyResolvers.push(res));
  }

  _call(type, payload) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  loadCSV(name, text) { return this._call("loadCSV", { name, text }); }
  rows(name, start, count) { return this._call("rows", { name, start, count }); }
  summary(name) { return this._call("summary", { name }); }
  exec(code) { return this._call("exec", { code }); }
  ping() { return this._call("ping", {}); }

  /** 图表数据 */
  chart(kind, args) { return this._call("chart", { kind, args }); }

  /** 执行管道：steps = [{hash, code}] */
  pipeline(name, steps) { return this._call("pipeline", { name, steps }); }
  resultRows(start, count) { return this._call("resultRows", { start, count }); }
  exportResult(format) { return this._call("exportResult", { format }); }
}
