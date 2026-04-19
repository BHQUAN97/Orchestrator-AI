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

// Buffer sau khi feature closed — khop voi feature-registry
const FEATURE_CLOSED_BUFFER_MS = 24 * 60 * 60 * 1000;

// === Decision Lock Class ===
class DecisionLock {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.lockFile = options.lockFile || path.join(this.projectDir, '.sdd', 'decisions.lock.json');
    this.decisions = this._load();

    // Audit log — optional, lazy init. Neu fail → log warning 1 lan, tiep tuc chay
    this._auditLog = options.auditLog || null;
    this._auditInitTried = !!options.auditLog;
    this._auditWarned = false;

    // Feature registry — optional, lazy init. Lien ket lock voi vong doi feature
    this._featureRegistry = options.featureRegistry || null;
    this._featureRegistryInitTried = !!options.featureRegistry;
  }

  /**
   * Lazy-init FeatureRegistry on first use.
   */
  _getFeatureRegistry() {
    if (this._featureRegistry) return this._featureRegistry;
    if (this._featureRegistryInitTried) return null;
    this._featureRegistryInitTried = true;
    try {
      const { FeatureRegistry } = require('./feature-registry');
      this._featureRegistry = new FeatureRegistry({ projectDir: this.projectDir });
      return this._featureRegistry;
    } catch (e) {
      console.warn(`⚠️  DecisionLock: feature registry disabled (${e.message})`);
      return null;
    }
  }

  /**
   * Lazy-init AuditLog on first use. Returns null on failure (after warning once).
   */
  _getAudit() {
    if (this._auditLog) return this._auditLog;
    if (this._auditInitTried) return null;
    this._auditInitTried = true;
    try {
      const { AuditLog } = require('./audit-log');
      this._auditLog = new AuditLog({ projectDir: this.projectDir });
      return this._auditLog;
    } catch (e) {
      if (!this._auditWarned) {
        console.warn(`⚠️  DecisionLock: audit log disabled (${e.message})`);
        this._auditWarned = true;
      }
      return null;
    }
  }

  /**
   * Safe audit emit — swallow errors so audit never breaks lock logic
   */
  _emit(event, payload) {
    const audit = this._getAudit();
    if (!audit) return;
    try { audit.append({ event, ...payload }); }
    catch (e) {
      if (!this._auditWarned) {
        console.warn(`⚠️  DecisionLock: audit append failed (${e.message})`);
        this._auditWarned = true;
      }
    }
  }

  /**
   * Lock 1 quyết định — chỉ Tech Lead được gọi
   * TTL default lay tu env DECISION_LOCK_TTL_HOURS (mac dinh 4h, truoc day 24h)
   * Lock 24h qua dai → block cong viec sau khi feature da merge/revert
   */
  lock({ decision, scope, approvedBy, reason = '', relatedFiles = [], ttl = DEFAULT_LOCK_TTL, featureId = null }) {
    const id = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const entry = {
      id,
      decision,
      scope,           // 'api', 'database', 'architecture', 'ui', 'auth', file path cụ thể
      approvedBy,      // 'tech-lead', 'user'
      reason,
      relatedFiles,
      ttl,             // fallback TTL (ms) — van ap dung neu khong co featureId, hoac buffer sau close
      featureId,       // neu co → lock song theo feature thay vi TTL co dinh
      status: 'active',
      lockedAt: new Date().toISOString(),
      unlockedAt: null,
      unlockReason: null
    };

    this.decisions.push(entry);
    this._save();

    this._emit('lock_created', {
      actor: approvedBy,
      scope,
      decisionId: id,
      details: { decision, reason, relatedFiles, ttl, featureId }
    });

    return entry;
  }

  /**
   * Unlock quyết định — cần lý do
   * Chỉ Tech Lead hoặc User được gọi
   * Validation: refuse silently (return null) neu caller bypass constraints —
   *   match existing soft-fail style (entry-not-found cung return null).
   */
  unlock(decisionId, { reason, unlockedBy } = {}) {
    const entry = this.decisions.find(d => d.id === decisionId);
    if (!entry) return null;

    // Guard 1: chi tech-lead/user duoc unlock — tranh agent thuong bypass lock
    if (unlockedBy !== 'tech-lead' && unlockedBy !== 'user') {
      console.warn(`⚠️  DecisionLock.unlock refused: unlockedBy="${unlockedBy}" not authorized (need tech-lead|user)`);
      this._emit('lock_unlock_refused', {
        actor: unlockedBy || 'unknown',
        scope: entry.scope,
        decisionId,
        details: { reason: 'unauthorized_role', providedRole: unlockedBy || null }
      });
      return null;
    }

    // Guard 2: khong re-unlock entry da unlocked — tranh ghi de audit trail
    if (entry.status !== 'active') {
      console.warn(`⚠️  DecisionLock.unlock refused: decision ${decisionId} already ${entry.status}`);
      this._emit('lock_unlock_refused', {
        actor: unlockedBy,
        scope: entry.scope,
        decisionId,
        details: { reason: 'already_unlocked', currentStatus: entry.status }
      });
      return null;
    }

    // Guard 3: reason bat buoc — audit trail can ly do
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      console.warn(`⚠️  DecisionLock.unlock refused: reason required for ${decisionId}`);
      this._emit('lock_unlock_refused', {
        actor: unlockedBy,
        scope: entry.scope,
        decisionId,
        details: { reason: 'missing_reason' }
      });
      return null;
    }

    entry.status = 'unlocked';
    entry.unlockedAt = new Date().toISOString();
    entry.unlockReason = `${unlockedBy}: ${reason}`;
    this._save();

    this._emit('lock_unlocked', {
      actor: unlockedBy,
      scope: entry.scope,
      decisionId,
      details: { reason, decision: entry.decision }
    });

    return entry;
  }

  /**
   * Check xem scope có bị lock không
   * Agent gọi trước khi thay đổi gì trong scope đó
   * Performance: batch in-memory unlock, save 1 lan thay vi N lan
   */
  isLocked(scope) {
    if (this._unlockExpiredInMemory() > 0) this._save();

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
    // Batch unlock expired in-memory, save 1 lan — tranh I/O explosion khi 10
    // parallel subtasks moi cai goi validate() → 10 sync writes cho cung expired locks
    if (this._unlockExpiredInMemory() > 0) this._save();

    const locks = this.getLockedFor(scope);

    if (locks.length === 0) {
      this._emit('lock_validated_allowed', {
        actor: agentRole,
        scope,
        details: { reason: 'no_active_lock' }
      });
      return { allowed: true };
    }

    // Tech Lead có thể override — nhưng vẫn cảnh báo
    if (agentRole === 'tech-lead') {
      const lockIds = locks.map(l => l.id);
      this._emit('lock_validated_allowed', {
        actor: agentRole,
        scope,
        details: { reason: 'tech_lead_override', lockIds, lockCount: locks.length }
      });
      this._emit('lock_override_warning', {
        actor: agentRole,
        scope,
        details: { lockIds, lockCount: locks.length, message: 'tech-lead accessing locked scope without explicit unlock' }
      });
      return {
        allowed: true,
        warning: `Scope "${scope}" có ${locks.length} locked decisions. Tech Lead có thể override nhưng nên unlock trước.`,
        locks
      };
    }

    // Agent khác → blocked, phải escalate
    const blockingIds = locks.map(l => l.id);
    this._emit('lock_validated_blocked', {
      actor: agentRole,
      scope,
      details: {
        blockingLockIds: blockingIds,
        lockCount: locks.length,
        action: 'ESCALATE'
      }
    });
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
    const cleaned = this._unlockExpiredInMemory();
    if (cleaned > 0) this._save();
    return { cleaned };
  }

  /**
   * Helper: unlock expired locks in-memory (KHONG save) — caller chiu trach nhiem save
   * Tach ra de share giua isLocked/validate/cleanExpired va batch save
   */
  _unlockExpiredInMemory() {
    let count = 0;
    for (const d of this.decisions) {
      if (d.status === 'active' && this._isExpired(d)) {
        d.status = 'unlocked';
        d.unlockedAt = new Date().toISOString();
        d.unlockReason = this._expiredReason(d);
        count++;
        this._emit('lock_expired', {
          actor: 'system',
          scope: d.scope,
          decisionId: d.id,
          details: {
            decision: d.decision,
            lockedAt: d.lockedAt,
            ttl: d.ttl,
            featureId: d.featureId || null,
            reason: d.unlockReason
          }
        });
      }
    }
    return count;
  }

  /**
   * Unlock tat ca decisions gan voi 1 feature. Goi khi feature closed (hook tu ben ngoai).
   * Neu caller dung FeatureRegistry truc tiep → nen goi ham nay voi cung featureId.
   */
  unlockByFeature(featureId, { reason = 'feature closed', unlockedBy = 'system' } = {}) {
    const unlocked = [];
    for (const d of this.decisions) {
      if (d.status === 'active' && d.featureId === featureId) {
        d.status = 'unlocked';
        d.unlockedAt = new Date().toISOString();
        d.unlockReason = `${unlockedBy}: ${reason}`;
        unlocked.push(d);
        this._emit('lock_unlocked', {
          actor: unlockedBy,
          scope: d.scope,
          decisionId: d.id,
          details: { reason, featureId, decision: d.decision }
        });
      }
    }
    if (unlocked.length > 0) this._save();
    return unlocked;
  }

  /**
   * Tien nghi: close feature trong registry VA unlock all decisions cua feature do.
   */
  closeFeatureAndUnlock(featureId, { reason = 'feature closed', closedBy = 'system' } = {}) {
    const reg = this._getFeatureRegistry();
    let feature = null;
    if (reg) {
      feature = reg.closeFeature(featureId, { closedBy, reason });
    }
    const unlocked = this.unlockByFeature(featureId, { reason, unlockedBy: closedBy });
    return { feature, unlocked };
  }

  // === Private ===

  /**
   * Kiểm tra lock đã hết hạn chưa. Uu tien featureId neu co:
   *  - feature mo → KHONG expire (bo qua TTL)
   *  - feature dong → expire sau closedAt + 24h buffer
   *  - khong co feature → fallback TTL truyen thong
   */
  _isExpired(lock) {
    if (lock.featureId) {
      const reg = this._getFeatureRegistry();
      if (reg) {
        const feature = reg.getFeature(lock.featureId);
        if (!feature || feature.status === 'open') {
          // Feature chua dong → lock van song
          return false;
        }
        // Feature dong → expire sau buffer
        const endAt = new Date(feature.closedAt).getTime() + FEATURE_CLOSED_BUFFER_MS;
        return Date.now() > endAt;
      }
      // Registry khong co → fallback TTL thuong
    }
    const ttl = lock.ttl || DEFAULT_LOCK_TTL;
    return Date.now() - new Date(lock.lockedAt).getTime() > ttl;
  }

  /**
   * Tao ly do unlock cho lock expired — phan biet feature vs TTL
   */
  _expiredReason(lock) {
    if (lock.featureId) {
      const reg = this._getFeatureRegistry();
      const feature = reg ? reg.getFeature(lock.featureId) : null;
      if (feature && feature.status === 'closed') {
        return `auto: feature closed (${lock.featureId})`;
      }
    }
    return 'auto: TTL expired';
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
