#!/usr/bin/env node
/**
 * Auto-Concurrency — Tu tinh concurrency toi uu dua tren CPU/RAM
 *
 * Tranh fix cung so luong song song. Dua tren:
 *   - os.cpus().length — so physical+logical core
 *   - os.totalmem() / os.freemem() — RAM con trong
 *   - Task type: cpu_bound, io_bound, llm_call
 *
 * API:
 *   computeOptimalConcurrency({ taskType }) → integer (1-16)
 *   suggestParallelism() → { subagent, file_read, llm }
 */

const os = require('os');

const CAP_MIN = 1;
const CAP_MAX = 16;

function clamp(n, lo = CAP_MIN, hi = CAP_MAX) {
  n = Math.floor(n);
  if (!Number.isFinite(n) || n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function freeMemGB() {
  return os.freemem() / (1024 ** 3);
}

function totalMemGB() {
  return os.totalmem() / (1024 ** 3);
}

/**
 * Tinh concurrency cho 1 loai task.
 *
 * Logic:
 *   cpu_bound: min(cpus - 1, floor(freemem_gb / 0.5))
 *              → CPU-heavy, 0.5GB per worker uoc luong
 *   io_bound:  min(cpus * 2, 16)
 *              → IO wait nhieu → oversubscribe OK
 *   llm_call:  4-8 dua tren freemem (buffer lon, avoid OOM)
 *              → <4GB free → 2, 4-8GB → 4, >8GB → 8
 */
function computeOptimalConcurrency({ taskType = 'cpu_bound' } = {}) {
  const cpus = os.cpus().length || 4;
  const freeGB = freeMemGB();

  switch (taskType) {
    case 'cpu_bound': {
      const byCpu = cpus - 1;
      const byMem = Math.floor(freeGB / 0.5); // 0.5GB per worker
      return clamp(Math.min(byCpu, byMem));
    }
    case 'io_bound': {
      return clamp(Math.min(cpus * 2, 16));
    }
    case 'llm_call': {
      // LLM call: bi chan boi mang + token buffer, KHONG CPU-bound
      // Nhung buffer phan hoi + JSON parse ton RAM
      if (freeGB < 2) return 2;
      if (freeGB < 4) return 3;
      if (freeGB < 8) return 4;
      if (freeGB < 16) return 6;
      return 8;
    }
    default:
      return clamp(Math.max(2, cpus - 1));
  }
}

/**
 * Goi y parallelism tong hop cho cac phan he cua orcai
 */
function suggestParallelism() {
  return {
    subagent: computeOptimalConcurrency({ taskType: 'llm_call' }),
    file_read: computeOptimalConcurrency({ taskType: 'io_bound' }),
    llm: computeOptimalConcurrency({ taskType: 'llm_call' }),
    cpu: computeOptimalConcurrency({ taskType: 'cpu_bound' })
  };
}

/**
 * Debug info — bao cao system resource hien tai
 */
function systemInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemGB: Number(totalMemGB().toFixed(2)),
    freeMemGB: Number(freeMemGB().toFixed(2)),
    loadavg: os.loadavg()
  };
}

module.exports = {
  computeOptimalConcurrency,
  suggestParallelism,
  systemInfo
};
