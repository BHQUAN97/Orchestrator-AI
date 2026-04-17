#!/usr/bin/env node
/**
 * WorkerPool — Pool worker_threads tai su dung, round-robin dispatch
 *
 * Muc tieu:
 *   - Tan dung multi-core CPU cho cong viec CPU-bound (TF-IDF, parse, hash...)
 *   - Khong spawn moi lan — workers persistent
 *   - Xu ly worker crash: respawn + reject pending task cua worker do
 *   - Graceful shutdown qua terminate()
 *
 * Usage:
 *   const pool = new WorkerPool({ scriptPath: require.resolve('./worker-tasks/tfidf-worker') });
 *   const result = await pool.run({ docs, query });
 *   pool.terminate();
 */

const os = require('os');
const path = require('path');
const { Worker } = require('node:worker_threads');

class WorkerPool {
  constructor({ scriptPath, size } = {}) {
    if (!scriptPath) throw new Error('WorkerPool: scriptPath required');
    this.scriptPath = scriptPath;
    // Mac dinh de lai 1 core cho main thread
    this.size = Math.max(1, size || Math.max(2, os.cpus().length - 1));
    this.workers = [];        // Array<{ worker, busy, currentTask }>
    this.queue = [];          // Pending task queue
    this.rr = 0;              // Round-robin cursor
    this.terminated = false;
    this._taskSeq = 0;

    // Tao workers ban dau
    for (let i = 0; i < this.size; i++) {
      this._spawnWorker(i);
    }
  }

  _spawnWorker(slotIndex) {
    try {
      const worker = new Worker(this.scriptPath);
      const slot = { worker, busy: false, currentTask: null, slotIndex };

      worker.on('message', (msg) => this._onMessage(slot, msg));
      worker.on('error', (err) => this._onError(slot, err));
      worker.on('exit', (code) => this._onExit(slot, code));

      this.workers[slotIndex] = slot;
    } catch (err) {
      // Neu spawn loi, ghi nho slot rong — se thu lai khi can
      this.workers[slotIndex] = null;
    }
  }

  _onMessage(slot, msg) {
    const task = slot.currentTask;
    slot.busy = false;
    slot.currentTask = null;
    if (task) {
      if (msg && msg.__error) {
        task.reject(new Error(msg.__error));
      } else {
        task.resolve(msg);
      }
    }
    this._drain();
  }

  _onError(slot, err) {
    const task = slot.currentTask;
    slot.busy = false;
    slot.currentTask = null;
    if (task) task.reject(err);
  }

  _onExit(slot, code) {
    // Worker da chet — cleanup va respawn neu pool con song
    const task = slot.currentTask;
    slot.busy = false;
    slot.currentTask = null;
    if (task) {
      task.reject(new Error(`Worker exited with code ${code} before completing task`));
    }
    if (!this.terminated) {
      // Respawn worker o cung slot
      this._spawnWorker(slot.slotIndex);
      // Tiep tuc drain queue
      this._drain();
    }
  }

  /**
   * Chay task tren 1 worker rong. Neu tat ca ban → enqueue.
   */
  run(taskPayload, transferList) {
    if (this.terminated) {
      return Promise.reject(new Error('WorkerPool terminated'));
    }
    return new Promise((resolve, reject) => {
      const task = {
        id: ++this._taskSeq,
        payload: taskPayload,
        transferList,
        resolve,
        reject
      };
      this.queue.push(task);
      this._drain();
    });
  }

  /**
   * Cap phat task trong queue cho workers rong (round-robin)
   */
  _drain() {
    if (!this.queue.length) return;

    // Tim worker rong, bat dau tu cursor rr
    for (let i = 0; i < this.workers.length && this.queue.length; i++) {
      const idx = (this.rr + i) % this.workers.length;
      const slot = this.workers[idx];
      if (!slot) {
        // Slot loi — thu respawn
        this._spawnWorker(idx);
        continue;
      }
      if (slot.busy) continue;

      const task = this.queue.shift();
      if (!task) break;
      slot.busy = true;
      slot.currentTask = task;
      try {
        slot.worker.postMessage(task.payload, task.transferList || []);
        this.rr = (idx + 1) % this.workers.length;
      } catch (err) {
        slot.busy = false;
        slot.currentTask = null;
        task.reject(err);
      }
    }
  }

  /**
   * Terminate tat ca workers. Pending tasks → reject.
   */
  async terminate() {
    if (this.terminated) return;
    this.terminated = true;

    // Reject pending queue
    while (this.queue.length) {
      const t = this.queue.shift();
      t.reject(new Error('WorkerPool terminated'));
    }

    const ps = [];
    for (const slot of this.workers) {
      if (!slot) continue;
      if (slot.currentTask) {
        slot.currentTask.reject(new Error('WorkerPool terminated'));
      }
      try { ps.push(slot.worker.terminate()); } catch {}
    }
    this.workers = [];
    await Promise.all(ps.map(p => p && p.catch && p.catch(() => {})));
  }

  stats() {
    const busy = this.workers.filter(w => w && w.busy).length;
    return {
      size: this.workers.length,
      busy,
      idle: this.workers.length - busy,
      queued: this.queue.length,
      terminated: this.terminated
    };
  }
}

// Cleanup tu dong khi process exit
const _pools = new Set();
function _trackPool(p) { _pools.add(p); }
function _untrackPool(p) { _pools.delete(p); }

process.on('exit', () => {
  for (const p of _pools) {
    try { p.terminate(); } catch {}
  }
});

// Wrap terminate de auto-untrack
const _origTerminate = WorkerPool.prototype.terminate;
WorkerPool.prototype.terminate = async function () {
  _untrackPool(this);
  return _origTerminate.call(this);
};
const _origCtor = WorkerPool;
function TrackedWorkerPool(opts) {
  const inst = new _origCtor(opts);
  _trackPool(inst);
  return inst;
}
TrackedWorkerPool.prototype = _origCtor.prototype;

module.exports = { WorkerPool };
