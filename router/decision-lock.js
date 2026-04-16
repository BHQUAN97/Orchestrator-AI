#!/usr/bin/env node
/**
 * Decision Lock — Registry quyết định đã được Tech Lead approve
 *
 * Vấn đề: Trong multi-model, agent sau có thể override quyết định của agent trước
 * → vỡ kiến trúc, FE/BE không khớp, API contract thay đổi giữa chừng.
 *
 * Giải pháp: Khi Tech Lead approve 1 quyết định → LOCK.
 * Agent sau nhận locked decisions trong context → KHÔNG được thay đổi.
 * Muốn thay đổi → phải escalate lên Tech Lead, Tech Lead unlock → re-decide.
 *
 * Cách dùng:
 *   const lock = new DecisionLock({ projectDir: '/path/to/project' });
 *   lock.lock({ decision: 'API dùng REST, không GraphQL', scope: 'api', approvedBy: 'tech-lead' });
 *   lock.isLocked('api');  // true
 *   lock.getActive();      // tất cả decisions đang lock
 */

const fs = require('fs');
const path = require('path');

// TTL default — configurable qua env DECISION_LOCK_TTL_HOURS (mac dinh 4h)
const DEFAULT_LOCK_TTL = (parseFloat(process.env.DECISION_LOCK_TTL_HOURS) || 4) * 60 * 60 * 1000;

// === Decision Lock Class ===
class DecisionLock {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.lockFile = options.lockFile || path.join(this.projectDir, '.sdd', 'decisions.lock.json');
    this.decisions = this._load();
  }

  /**
   * Lock 1 quyết định — chỉ Tech Lead được gọi
   * TTL default lay tu env DECISION_LOCK_TTL_HOURS (mac dinh 4h, truoc day 24h)
   * Lock 24h qua dai → block cong viec sau khi feature da merge/revert
   */
  lock({ decision, scope, approvedBy, reason = '', relatedFiles = [], ttl = DEFAULT_LOCK_TTL }) {
    const id = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const entry = {
      id,
      decision,
      scope,           // 'api', 'database', 'architecture', 'ui', 'auth', file path cụ thể
      approvedBy,      // 'tech-lead', 'user'
      reason,
      relatedFiles,
      ttl,             // thời gian sống (ms), mặc định 24h — hết hạn tự unlock
      status: 'active',
      lockedAt: new Date().toISOString(),
      unlockedAt: null,
      unlockReason: null
    };

    this.decisions.push(entry);
    this._save();

    return entry;
  }

  /**
   * Unlock quyết định — cần lý do
   * Chỉ Tech Lead hoặc User được gọi
   */
  unlock(decisionId, { reason, unlockedBy }) {
    const entry = this.decisions.find(d => d.id === decisionId);
    if (!entry) return null;

    entry.status = 'unlocked';
    entry.unlockedAt = new Date().toISOString();
    entry.unlockReason = `${unlockedBy}: ${reason}`;
    this._save();

    return entry;
  }

  /**
   * Check xem scope có bị lock không
   * Agent gọi trước khi thay đổi gì trong scope đó
   */
  isLocked(scope) {
    // Auto-unlock nếu lock đã hết hạn TTL
    this.decisions.forEach(d => {
      if (d.status === 'active' && this._isExpired(d)) {
        this._autoUnlock(d, 'TTL expired');
      }
    });

    return this.decisions.some(d =>
      d.status === 'active' && (d.scope === scope || d.relatedFiles.includes(scope))
    );
  }

  /**
   * Lấy quyết định lock cho scope cụ thể
   */
  getLockedFor(scope) {
    return this.decisions.filter(d =>
      d.status === 'active' && (d.scope === scope || d.relatedFiles.includes(scope))
    );
  }

  /**
   * Lấy tất cả decisions đang active — inject vào context cho agent
   */
  getActive() {
    // Dọn lock hết hạn trước khi trả kết quả
    this.cleanExpired();
    return this.decisions.filter(d => d.status === 'active');
  }

  /**
   * Lấy lịch sử — bao gồm cả unlocked
   */
  getHistory() {
    return [...this.decisions];
  }

  /**
   * Validate: agent muốn thay đổi scope → check lock
   * Trả về: { allowed: true } hoặc { allowed: false, blockedBy: [...] }
   */
  validate(scope, agentRole) {
    // Auto-unlock nếu lock đã hết hạn TTL
    this.decisions.forEach(d => {
      if (d.status === 'active' && this._isExpired(d)) {
        this._autoUnlock(d, 'TTL expired');
      }
    });

    const locks = this.getLockedFor(scope);

    if (locks.length === 0) {
      return { allowed: true };
    }

    // Tech Lead có thể override — nhưng vẫn cảnh báo
    if (agentRole === 'tech-lead') {
      return {
        allowed: true,
        warning: `Scope "${scope}" có ${locks.length} locked decisions. Tech Lead có thể override nhưng nên unlock trước.`,
        locks
      };
    }

    // Agent khác → blocked, phải escalate
    return {
      allowed: false,
      blockedBy: locks.map(l => ({
        id: l.id,
        decision: l.decision,
        approvedBy: l.approvedBy,
        lockedAt: l.lockedAt
      })),
      action: 'ESCALATE to Tech Lead để unlock hoặc điều chỉnh approach'
    };
  }

  /**
   * Cleanup — xóa locks quá cũ (mặc định 7 ngày)
   */
  cleanup(maxAgeDays = 7) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const before = this.decisions.length;

    this.decisions = this.decisions.filter(d => {
      if (d.status === 'unlocked') {
        return new Date(d.unlockedAt).getTime() > cutoff;
      }
      return true; // Giữ active decisions vĩnh viễn
    });

    if (this.decisions.length < before) {
      this._save();
    }

    return { removed: before - this.decisions.length };
  }

  /**
   * Dọn tất cả lock đã hết hạn TTL — tự động unlock với lý do "TTL expired"
   */
  cleanExpired() {
    let cleaned = 0;
    this.decisions.forEach(d => {
      if (d.status === 'active' && this._isExpired(d)) {
        // Unlock in-memory, KHONG ghi file tung entry — batch save cuoi
        d.status = 'unlocked';
        d.unlockedAt = new Date().toISOString();
        d.unlockReason = 'auto: TTL expired';
        cleaned++;
      }
    });
    // Batch save 1 lan thay vi N lan
    if (cleaned > 0) this._save();
    return { cleaned };
  }

  // === Private ===

  /**
   * Kiểm tra lock đã hết hạn chưa — so sánh thời gian hiện tại với lockedAt + ttl
   */
  _isExpired(lock) {
    const ttl = lock.ttl || DEFAULT_LOCK_TTL;
    return Date.now() - new Date(lock.lockedAt).getTime() > ttl;
  }

  /**
   * Tự động unlock — dùng cho TTL expired, không cần user can thiệp
   */
  _autoUnlock(entry, reason) {
    entry.status = 'unlocked';
    entry.unlockedAt = new Date().toISOString();
    entry.unlockReason = `auto: ${reason}`;
    this._save();
  }

  _load() {
    try {
      if (fs.existsSync(this.lockFile)) {
        return JSON.parse(fs.readFileSync(this.lockFile, 'utf-8'));
      }
    } catch (e) {
      console.error(`⚠️  Decision lock file corrupted: ${e.message}`);
    }
    return [];
  }

  _save() {
    const dir = path.dirname(this.lockFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.lockFile, JSON.stringify(this.decisions, null, 2), 'utf-8');
  }
}

module.exports = { DecisionLock };
