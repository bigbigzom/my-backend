/**
 * AccountManagerV2 - 账号管理器（v2重构版）
 *
 * 面向对象设计：管理 Account 对象集合，提供CRUD、批量操作、刷新调度、健康度检查。
 *
 * 职责：
 * - 账号CRUD（增删改查）
 * - 批量刷新Cookie（调度 CookieRefresher）
 * - 批量健康度检查（调度 AccountHealthMonitor）
 * - 账号状态机转换
 * - 事件通知（刷新成功/失败、健康度预警等）
 * - 持久化（JSON文件存储）
 *
 * 不职责：
 * - 不直接调用B站API（由 BiliAuthAPI / CookieRefresher 负责）
 * - 不计算健康度（由 AccountHealthMonitor 负责）
 * - 不执行登录（由 LoginSession / LocalLoginService 负责）
 *
 * 设计模式：
 * - Singleton（单例）- 全局唯一管理器
 * - Observer（观察者）- 事件通知
 * - Facade（外观）- 对外提供统一接口
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Account } from './Account.js';
import { CookieRefresher } from './CookieRefresher.js';
import { AccountHealthMonitor } from './AccountHealthMonitor.js';
import { BiliAuthAPI } from './BiliAuthAPI.js';
import { ACCOUNT_STATUS, INTERVALS, ALERT_LEVEL } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class AccountManagerV2 extends EventEmitter {
  /**
   * @param {Object} options - 配置
   * @param {string} options.storagePath - 持久化文件路径
   * @param {number} options.refreshConcurrency - 刷新并发数
   */
  constructor(options = {}) {
    super();
    this.storagePath = options.storagePath ||
      path.join(__dirname, '..', '..', 'data', 'accounts-v2.json');
    this.refreshConcurrency = options.refreshConcurrency || 2;
    this.accounts = new Map(); // id -> Account
    this.healthMonitor = new AccountHealthMonitor();
    this.isRefreshing = false;
    this._load();
  }

  // ============================================================
  // 单例
  // ============================================================
  static _instance = null;
  static getInstance(options = {}) {
    if (!AccountManagerV2._instance) {
      AccountManagerV2._instance = new AccountManagerV2(options);
    }
    return AccountManagerV2._instance;
  }

  // ============================================================
  // 持久化
  // ============================================================

  _load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const data = JSON.parse(fs.readFileSync(this.storagePath, 'utf-8'));
        (data.accounts || []).forEach(a => {
          const account = Account.fromJSON(a);
          this.accounts.set(account.id, account);
        });
        console.log(`[AccountManagerV2] 加载 ${this.accounts.size} 个账号`);
      }
    } catch (e) {
      console.error('[AccountManagerV2] 加载失败:', e.message);
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        version: '2.0',
        updatedAt: new Date().toISOString(),
        accounts: Array.from(this.accounts.values()).map(a => a.toJSON()),
      };
      fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[AccountManagerV2] 保存失败:', e.message);
    }
  }

  // ============================================================
  // CRUD
  // ============================================================

  /** 添加账号 */
  add(accountData) {
    const account = accountData instanceof Account ? accountData : new Account(accountData);
    this.accounts.set(account.id, account);
    this._save();
    this.emit('accountAdded', account.toDisplay());
    return account;
  }

  /** 获取账号 */
  get(id) {
    return this.accounts.get(id) || null;
  }

  /** 通过UID获取 */
  getByUid(uid) {
    return Array.from(this.accounts.values()).find(a => a.uid === String(uid)) || null;
  }

  /** 更新账号 */
  update(id, updates) {
    const account = this.accounts.get(id);
    if (!account) return null;
    Object.assign(account, updates);
    this._save();
    this.emit('accountUpdated', account.toDisplay());
    return account;
  }

  /** 删除账号 */
  remove(id) {
    const account = this.accounts.get(id);
    if (!account) return false;
    this.accounts.delete(id);
    this._save();
    this.emit('accountRemoved', { id, uid: account.uid });
    return true;
  }

  /** 获取所有账号 */
  getAll() {
    return Array.from(this.accounts.values());
  }

  /** 获取活跃账号 */
  getActive() {
    return this.getAll().filter(a => a.isActive);
  }

  /** 获取需要刷新的账号 */
  getNeedsRefresh() {
    return this.getAll().filter(a => a.needsRefresh && a.canRefresh);
  }

  /** 获取需要重新登录的账号 */
  getNeedsRelogin() {
    return this.getAll().filter(a => a.needsRelogin);
  }

  /** 账号数量 */
  get count() {
    return this.accounts.size;
  }

  // ============================================================
  // 批量导入（兼容旧格式）
  // ============================================================

  /**
   * 批量导入账号（兼容旧版 account-manager 格式）
   * @param {Array} accounts - 账号数据数组
   * @returns {number} 成功导入数量
   */
  importBatch(accounts) {
    let count = 0;
    accounts.forEach(data => {
      try {
        // 兼容旧格式：cookie 字符串
        const account = new Account({
          id: data.id || data.uid || `acc_${Date.now()}_${count}`,
          uid: data.uid || '',
          phone: data.phone || '',
          remark: data.remark || data.username || '',
          username: data.username || '',
          status: data.status || ACCOUNT_STATUS.ACTIVE,
          trustedDevice: data.trustedDevice || false,
          refreshToken: data.refreshToken || data.ac_time_value || '',
          fingerprintId: data.fingerprintId || '',
          proxy: data.proxy || null,
          userAgent: data.userAgent || '',
          useProxy: data.useProxy,
          persona: data.persona,
          behaviorProfile: data.behaviorProfile,
        });
        if (data.cookie) {
          account.setCookieFromString(data.cookie);
        } else if (data.cookies) {
          account.cookies = data.cookies;
          account.cookieStr = Object.entries(data.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
        }
        if (data.cookieExpire) account.cookieExpire = data.cookieExpire;
        if (data.lastLogin) account.lastLogin = data.lastLogin;
        if (data.sessdata && data.csrf && !data.cookie) {
          account.setCookieFromString(`SESSDATA=${data.sessdata}; bili_jct=${data.csrf}`);
        }
        this.accounts.set(account.id, account);
        count++;
      } catch (e) {
        console.error('[AccountManagerV2] 导入失败:', e.message);
      }
    });
    this._save();
    this.emit('batchImported', { count });
    return count;
  }

  // ============================================================
  // Cookie 刷新
  // ============================================================

  /**
   * 刷新单个账号的Cookie
   * @param {string} id - 账号ID
   * @param {Object} options - 刷新配置
   * @returns {Object} 刷新结果
   */
  async refreshAccount(id, options = {}) {
    const account = this.accounts.get(id);
    if (!account) return { success: false, error: '账号不存在' };
    if (!account.canRefresh) return { success: false, error: '没有refresh_token，无法刷新' };

    // 刷新冷却检查
    if (account.lastRefresh) {
      const sinceRefresh = Date.now() - new Date(account.lastRefresh).getTime();
      if (sinceRefresh < INTERVALS.REFRESH_COOLDOWN) {
        return { success: false, skipped: true, error: '刷新冷却中，请稍后再试' };
      }
    }

    account.transitionTo(ACCOUNT_STATUS.REFRESHING, '开始刷新Cookie');

    const refresher = new CookieRefresher(account, options);
    const result = await refresher.refresh();

    if (result.success && !result.skipped) {
      this._save();
      this.emit('refreshSuccess', { id, uid: account.uid, result });
    } else if (!result.success) {
      this._save();
      this.emit('refreshFailed', { id, uid: account.uid, error: result.error });
    }

    return result;
  }

  /**
   * 批量刷新所有需要刷新的账号
   * @param {Object} options - 配置
   * @returns {Object} { total, success, failed, skipped, results }
   */
  async refreshAllNeedsRefresh(options = {}) {
    if (this.isRefreshing) {
      return { success: false, error: '已有刷新任务在执行' };
    }
    this.isRefreshing = true;

    const targets = this.getNeedsRefresh();
    const results = [];
    let success = 0, failed = 0, skipped = 0;

    this.emit('batchRefreshStart', { total: targets.length });

    // 并发控制
    const queue = [...targets];
    const worker = async () => {
      while (queue.length > 0) {
        const account = queue.shift();
        try {
          const result = await this.refreshAccount(account.id, options);
          results.push({ id: account.id, uid: account.uid, ...result });
          if (result.success && !result.skipped) success++;
          else if (result.skipped) skipped++;
          else failed++;
        } catch (e) {
          failed++;
          results.push({ id: account.id, uid: account.uid, success: false, error: e.message });
        }
        // 刷新间隔（防风控）
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
      }
    };

    const workers = Array.from({ length: Math.min(this.refreshConcurrency, targets.length) }, () => worker());
    await Promise.all(workers);

    this.isRefreshing = false;
    this.emit('batchRefreshComplete', { total: targets.length, success, failed, skipped });

    return { total: targets.length, success, failed, skipped, results };
  }

  // ============================================================
  // 健康度检查
  // ============================================================

  /**
   * 检查单个账号健康度
   * @param {string} id
   */
  checkHealth(id) {
    const account = this.accounts.get(id);
    if (!account) return null;
    const result = this.healthMonitor.evaluate(account);
    this._save();

    // 预警事件
    if (result.alertLevel !== ALERT_LEVEL.NORMAL) {
      this.emit('healthAlert', { id, uid: account.uid, ...result });
    }
    return result;
  }

  /**
   * 批量检查所有账号健康度
   */
  checkAllHealth() {
    const result = this.healthMonitor.evaluateAll(this.getAll());
    this._save();

    if (result.alerts.length > 0) {
      this.emit('batchHealthAlert', { alerts: result.alerts, summary: result.summary });
    }
    return result;
  }

  // ============================================================
  // 登录态验证
  // ============================================================

  /**
   * 验证单个账号登录态
   * @param {string} id
   */
  async verifyLogin(id) {
    const account = this.accounts.get(id);
    if (!account) return { valid: false, error: '账号不存在' };
    if (!account.hasCredentials) return { valid: false, error: '没有凭证' };

    try {
      const api = new BiliAuthAPI({ userAgent: account.userAgent, proxy: account.proxy });
      const result = await api.verifyLogin(account.cookieStr);
      account.recordActivity('verify_login');

      if (result.isLogin) {
        if (!account.isActive) account.transitionTo(ACCOUNT_STATUS.ACTIVE, '登录态验证通过');
        this._save();
        return { valid: true, ...result };
      } else {
        account.transitionTo(ACCOUNT_STATUS.NEEDS_RELOGIN, '登录态验证失败');
        this._save();
        this.emit('loginExpired', { id, uid: account.uid });
        return { valid: false, ...result };
      }
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }

  /**
   * 批量验证所有账号登录态
   */
  async verifyAllLogins() {
    const accounts = this.getAll();
    const results = [];
    let valid = 0, invalid = 0;

    for (const account of accounts) {
      const result = await this.verifyLogin(account.id);
      results.push({ id: account.id, uid: account.uid, ...result });
      if (result.valid) valid++; else invalid++;
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
    }

    return { total: accounts.length, valid, invalid, results };
  }

  // ============================================================
  // 统计与展示
  // ============================================================

  /** 获取所有账号的展示数据（脱敏） */
  getAllDisplay() {
    return this.getAll().map(a => a.toDisplay());
  }

  /** 获取统计摘要 */
  getStats() {
    const all = this.getAll();
    return {
      total: all.length,
      active: all.filter(a => a.isActive).length,
      needsRefresh: all.filter(a => a.needsRefresh).length,
      needsRelogin: all.filter(a => a.needsRelogin).length,
      canRefresh: all.filter(a => a.canRefresh).length,
      trustedDevice: all.filter(a => a.trustedDevice).length,
      avgHealthScore: all.length > 0
        ? Math.round(all.reduce((s, a) => s + a.healthScore, 0) / all.length)
        : 0,
      alerts: all.filter(a => a.alertLevel !== ALERT_LEVEL.NORMAL && a.alertLevel !== ALERT_LEVEL.EXPIRED).length,
      expired: all.filter(a => a.alertLevel === ALERT_LEVEL.EXPIRED).length,
    };
  }
}

export default AccountManagerV2;
