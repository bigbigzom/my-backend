/**
 * 账号服务（v4.0 OOP重构）
 *
 * 封装 accounts-v2/AccountManagerV2，提供统一的账号管理接口。
 * AccountCultivator 按账号实例化（非单例）。
 */
import { AccountManagerV2, AccountCultivator, ACCOUNT_TYPE } from '../src/accounts-v2/index.js';
import { getProxyForAccount, isProxyReady } from '../src/utils/proxy-pool.js';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

export class AccountService {
  constructor() {
    this.manager = new AccountManagerV2();
  }

  /**
   * v6.4：前置检测单个代理IP是否可用（通过该IP访问B站nav接口）
   * @param {string} proxyAddr - ip:port
   * @returns {Promise<boolean>}
   */
  async _testProxyAvailable(proxyAddr) {
    if (!proxyAddr) return false;
    try {
      const p = proxyAddr.includes('://') ? proxyAddr : 'http://' + proxyAddr;
      const res = await undiciFetch('https://api.bilibili.com/x/web-interface/nav', {
        dispatcher: new ProxyAgent(p),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data.code === 0 || data.code === -101;
    } catch {
      return false;
    }
  }

  async _getCultivator(accountId) {
    const acc = this.get(accountId);
    if (!acc) throw new Error('账号不存在');
    // v5.9.9：养号前解析IP（注册IP优先→同地区回退→无则拒绝）
    const result = await this.resolveProxy(accountId);
    if (result.skipped) throw new Error(result.reason || '账号IP不可用，养号跳过');
    return new AccountCultivator({ account: acc, accountType: acc.accountType });
  }

  // ===== 账号CRUD =====
  list(filters = {}) {
    let accounts = this.manager.getAll();
    if (filters.type) accounts = accounts.filter(a => a.accountType === filters.type);
    if (filters.active) accounts = accounts.filter(a => a.isActive);
    return accounts.map(a => a.toDisplay ? a.toDisplay() : a);
  }

  get(id) {
    // v6.0：兼容前端 cloud_ 前缀
    const cleanId = String(id || '').replace(/^cloud_/, '');
    return this.manager.get(cleanId) || this.manager.getByUid(cleanId) || null;
  }
  getByUid(uid) { return this.manager.getByUid(uid); }
  getStats() { return this.manager.getStats(); }

  /**
   * v5.9.9：解析账号执行任务时应使用的代理IP
   * 优先级：注册IP > 最后一次启动IP > 同地区新IP > null（拒绝启动）
   * @returns {Promise<{proxy:string|null, skipped:boolean, reason?:string}>}
   */
  async resolveProxy(accountId) {
    const account = this.get(accountId);
    if (!account) return { proxy: null, skipped: true, reason: '账号不存在' };
    if (!account.isActive) return { proxy: null, skipped: true, reason: '账号非活跃状态' };

    let proxy = null;
    let proxySource = 'none';

    // 1. 最优先：注册IP（专属IP，前置检测可用性）
    if (account.registeredProxyIp && (account.proxyIpFailCount || 0) < 5) {
      console.log(`[AccountService] 账号 uid=${account.uid} 检测注册IP: ${account.registeredProxyIp}...`);
      const ok = await this._testProxyAvailable(account.registeredProxyIp);
      if (ok) {
        proxy = account.registeredProxyIp;
        proxySource = 'registered';
        account.proxyIpFailCount = 0;
        account.lastUsedProxyIp = proxy;
        console.log(`[AccountService] ✅ 注册IP可用`);
      } else {
        account.proxyIpFailCount = (account.proxyIpFailCount || 0) + 1;
        console.log(`[AccountService] ❌ 注册IP不可用，失败次数=${account.proxyIpFailCount}`);
      }
    }

    // 2. 回退：最后一次使用的IP（前置检测）
    if (!proxy && account.lastUsedProxyIp && account.lastUsedProxyIp !== account.registeredProxyIp && (account.proxyIpFailCount || 0) < 8) {
      console.log(`[AccountService] 账号 uid=${account.uid} 检测上次IP: ${account.lastUsedProxyIp}...`);
      const ok = await this._testProxyAvailable(account.lastUsedProxyIp);
      if (ok) {
        proxy = account.lastUsedProxyIp;
        proxySource = 'lastUsed';
        console.log(`[AccountService] ✅ 上次IP可用`);
      } else {
        account.proxyIpFailCount = (account.proxyIpFailCount || 0) + 1;
        console.log(`[AccountService] ❌ 上次IP不可用`);
      }
    }

    // 3. 都不可用 → 从代理池分配同地区新IP（代理池已验证过，直接用）
    if (!proxy) {
      const newProxy = getProxyForAccount(account);
      if (!newProxy) {
        this.manager.update(accountId, { proxyIpFailCount: account.proxyIpFailCount });
        return {
          proxy: null,
          skipped: true,
          reason: `注册IP和上次IP均失效，且代理池无${account.region || '未知'}地区可用IP。账号已静默，待代理池有该地区IP后自动恢复。`,
          region: account.region,
          needUserAttention: true,
        };
      }
      proxy = newProxy.proxy;
      proxySource = 'pool';
      account.bindProxy(proxy);
      account.proxyCity = newProxy.city || '';
      account.proxyIpFailCount = 0;
      this.manager.update(accountId, { lastUsedProxyIp: proxy, proxyCity: account.proxyCity, proxyIpFailCount: 0 });
      console.log(`[AccountService] ✅ 从代理池分配新IP: ${proxy}`);
    }

    account.proxy = proxy;
    // 持久化失败计数
    if (account.proxyIpFailCount > 0) {
      this.manager.update(accountId, { proxyIpFailCount: account.proxyIpFailCount });
    }
    console.log(`[AccountService] 账号 uid=${account.uid} 最终IP: ${proxy} (来源:${proxySource})`);
    return { proxy, skipped: false, region: account.region, source: proxySource };
  }

  importBatch(accounts) { return this.manager.importBatch(accounts); }
  delete(id) {
    const cleanId = String(id || '').replace(/^cloud_/, '');
    return this.manager.remove(cleanId) || this.manager.removeByUid(cleanId);
  }
  update(id, patch) { return this.manager.update(id, patch); }

  // ===== 账号健康 =====
  async refresh(id) {
    const acc = this.get(id);
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
  async getCultivationStatus(accountId) {
    const c = await this._getCultivator(accountId);
    return c.getReport ? c.getReport() : {};
  }

  async dailyCultivation(accountId, opts = {}) {
    const c = await this._getCultivator(accountId);
    return c.runDailyCultivation(opts);
  }

  async advanceCultivation(accountId) {
    const c = await this._getCultivator(accountId);
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

  async getIsolation(accountId) {
    const c = await this._getCultivator(accountId);
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
