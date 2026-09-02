/**
 * 账号服务（v4.0 OOP重构）
 *
 * 封装 accounts-v2/AccountManagerV2，提供统一的账号管理接口。
 * AccountCultivator 按账号实例化（非单例）。
 */
import { AccountManagerV2, AccountCultivator, ACCOUNT_TYPE } from '../src/accounts-v2/index.js';

export class AccountService {
  constructor() {
    this.manager = new AccountManagerV2();
  }

  _getCultivator(accountId) {
    const acc = this.manager.get(accountId);
    if (!acc) throw new Error('账号不存在');
    return new AccountCultivator({ account: acc, accountType: acc.accountType });
  }

  // ===== 账号CRUD =====
  list(filters = {}) {
    let accounts = this.manager.getAll();
    if (filters.type) accounts = accounts.filter(a => a.accountType === filters.type);
    if (filters.active) accounts = accounts.filter(a => a.isActive);
    return accounts.map(a => a.toDisplay ? a.toDisplay() : a);
  }

  get(id) { return this.manager.get(id); }
  getByUid(uid) { return this.manager.getByUid(uid); }
  getStats() { return this.manager.getStats(); }

  importBatch(accounts) { return this.manager.importBatch(accounts); }
  delete(id) { return this.manager.remove(id); }
  update(id, patch) { return this.manager.update(id, patch); }

  // ===== 账号健康 =====
  async refresh(id) {
    const acc = this.manager.get(id);
    if (!acc) throw new Error('账号不存在');
    return this.manager.refreshAccount ? await this.manager.refreshAccount(id) : { id, refreshed: true };
  }

  async refreshAll() {
    const due = this.manager.getNeedsRefresh();
    const results = [];
    for (const acc of due) {
      try { if (this.manager.refreshAccount) results.push(await this.manager.refreshAccount(acc.id)); } catch (e) {}
    }
    return { refreshed: results.length, total: due.length };
  }

  async verify(id) { return this.manager.checkHealth(id); }
  healthCheck() { return this.manager.checkAllHealth(); }

  async refreshDue() {
    const due = this.manager.getRefreshDue();
    const results = [];
    for (const acc of due) {
      try { if (this.manager.refreshAccount) results.push(await this.manager.refreshAccount(acc.id)); } catch (e) {}
    }
    return { refreshed: results.length, total: due.length };
  }

  // ===== 养号 =====
  getCultivationStatus(accountId) {
    const c = this._getCultivator(accountId);
    return c.getReport ? c.getReport() : {};
  }

  async dailyCultivation(accountId, opts = {}) {
    return this._getCultivator(accountId).runDailyCultivation(opts);
  }

  advanceCultivation(accountId) {
    const c = this._getCultivator(accountId);
    const success = c.advanceStage();
    return { success, stage: c.stage };
  }

  setAccountType(accountId, type) {
    const acc = this.manager.get(accountId);
    if (!acc) throw new Error('账号不存在');
    const validTypes = [ACCOUNT_TYPE.VIDEO_PUBLISHER, ACCOUNT_TYPE.COMMENT_ACCOUNT, 'publisher', 'commenter'];
    if (!validTypes.includes(type)) throw new Error('无效的账号类型');
    const mapped = type === 'publisher' ? ACCOUNT_TYPE.VIDEO_PUBLISHER : type === 'commenter' ? ACCOUNT_TYPE.COMMENT_ACCOUNT : type;
    acc.accountType = mapped;
    this.manager.update(accountId, { accountType: mapped });
    return { accountId, accountType: mapped };
  }

  getIsolation(accountId) {
    const c = this._getCultivator(accountId);
    return c.getIsolationInfo ? c.getIsolationInfo() : {};
  }

  resetWarmup(id) {
    return this.manager.update(id, {
      cultivationStage: 'newborn', daysInStage: 0, totalCultivationDays: 0,
      warmupCompleted: false, nextWarmupDate: null,
    });
  }

  // ===== 使用策略 =====
  getUsagePolicy(id) { return this.manager.getUsagePolicy(id); }
  listUsagePolicies() { return this.manager.getAllUsagePolicies(); }

  setActiveHours(id, hours) {
    return this.manager.update(id, { activeHours: hours });
  }

  setIpRole(id, role) {
    if (!['publisher', 'commenter'].includes(role)) throw new Error('ipRole必须是publisher或commenter');
    const mapped = role === 'publisher' ? ACCOUNT_TYPE.VIDEO_PUBLISHER : ACCOUNT_TYPE.COMMENT_ACCOUNT;
    return this.manager.update(id, { accountType: mapped, ipRole: role });
  }

  setSocialSeparation(id, enabled) {
    return this.manager.update(id, { socialSeparation: !!enabled });
  }

  getPublisherIps() {
    return this.manager.getAll()
      .filter(a => a.accountType === ACCOUNT_TYPE.VIDEO_PUBLISHER || a.ipRole === 'publisher')
      .map(a => ({ id: a.id, uid: a.uid, proxy: a.proxy || a.primaryProxy || '', ipRole: 'publisher' }));
  }

  getRiskDetail(id) {
    const acc = this.manager.get(id);
    if (!acc) return null;
    return {
      id: acc.id, uid: acc.uid, riskLevel: acc.riskLevel || 'low',
      riskScore: acc.riskScore || 0, riskFactors: acc.riskFactors || [],
      lastRiskCheck: acc.lastRiskCheck || null,
    };
  }

  // ===== 视频发布者 =====
  listPublishers() {
    const all = this.manager.getAll();
    const publishers = all.filter(a => a.accountType === ACCOUNT_TYPE.VIDEO_PUBLISHER || a.ipRole === 'publisher');
    const commenters = all.filter(a => !(a.accountType === ACCOUNT_TYPE.VIDEO_PUBLISHER || a.ipRole === 'publisher'));
    return {
      accounts: all.map(a => a.toDisplay ? a.toDisplay() : a),
      publishers: publishers.map(a => a.toDisplay ? a.toDisplay() : a),
      commenters: commenters.map(a => a.toDisplay ? a.toDisplay() : a),
      total: all.length,
    };
  }

  setPublisher(id, isPublisher) {
    const role = isPublisher ? 'publisher' : 'commenter';
    return this.setIpRole(id, role);
  }

  // ===== 代理批量 =====
  proxyBatch(ids, proxy) {
    const results = [];
    for (const id of ids) {
      const r = this.manager.update(id, { proxy });
      if (r) results.push(id);
    }
    return { updated: results.length, ids: results };
  }

  get accountTypes() { return ACCOUNT_TYPE; }
}

export default AccountService;
