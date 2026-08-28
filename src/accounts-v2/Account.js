/**
 * Account 账号实体类
 *
 * 面向对象设计：每个账号是一个独立对象，封装自身状态、Cookie、健康度和行为。
 *
 * 职责：
 * - 存储账号完整数据（Cookie、refresh_token、指纹、代理、时间戳）
 * - 管理自身状态（状态机转换）
 * - 计算自身健康度
 * - 序列化/反序列化（持久化）
 *
 * 不职责：
 * - 不直接调用B站API（由 BiliAuthAPI 负责）
 * - 不执行刷新逻辑（由 CookieRefresher 负责）
 * - 不管理账号集合（由 AccountManagerV2 负责）
 */
import { ACCOUNT_STATUS, COOKIE_FIELDS, COOKIE_TTL, ALERT_LEVEL } from './constants.js';

export class Account {
  /**
   * @param {Object} data - 初始化数据
   */
  constructor(data = {}) {
    // 基本信息
    this.id = data.id || data.uid || `acc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.uid = data.uid || '';
    this.phone = data.phone || '';
    this.remark = data.remark || '';
    this.username = data.username || '';

    // 状态
    this.status = data.status || ACCOUNT_STATUS.NEW;
    this.trustedDevice = data.trustedDevice || false;

    // Cookie（完整存储，不只存 SESSDATA）
    this.cookies = data.cookies || {};  // { SESSDATA: '', bili_jct: '', ... }
    this.cookieStr = data.cookieStr || ''; // 完整 cookie 字符串
    this.refreshToken = data.refreshToken || ''; // localStorage ac_time_value（关键！）

    // 设备与网络
    this.fingerprintId = data.fingerprintId || '';
    this.fingerprint = data.fingerprint || null;
    this.proxy = data.proxy || null;
    this.userAgent = data.userAgent || '';
    this.userDataDir = data.userDataDir || '';

    // 时间戳
    this.createdAt = data.createdAt || new Date().toISOString();
    this.lastLogin = data.lastLogin || null;
    this.lastActive = data.lastActive || null;
    this.lastRefresh = data.lastRefresh || null;
    this.lastCheck = data.lastCheck || null;
    this.cookieExpire = data.cookieExpire || (Date.now() + COOKIE_TTL.DEFAULT);

    // 健康度
    this.healthScore = data.healthScore || 0;
    this.healthFactors = data.healthFactors || {};
    this.alertLevel = data.alertLevel || ALERT_LEVEL.NORMAL;
    this.predictDays = data.predictDays || 0;

    // 风控记录
    this.riskEvents = data.riskEvents || []; // [{ time, type, detail }]
    this.operationCount = data.operationCount || 0; // 累计操作次数
    this.dailyOperations = data.dailyOperations || {}; // { '2026-08-28': 5 }

    // 扩展字段（兼容旧数据）
    this.useProxy = data.useProxy !== false;
    this.persona = data.persona || null;
    this.behaviorProfile = data.behaviorProfile || null;
    this.extra = data.extra || {};
  }

  // ============================================================
  // Cookie 便捷访问
  // ============================================================

  /** 获取 SESSDATA */
  get sessdata() {
    return this.cookies[COOKIE_FIELDS.SESSDATA] || '';
  }

  /** 获取 bili_jct (CSRF) */
  get csrf() {
    return this.cookies[COOKIE_FIELDS.BILI_JCT] || '';
  }

  /** 获取 DedeUserID */
  get dedeUserId() {
    return this.cookies[COOKIE_FIELDS.DEDE_USER_ID] || this.uid;
  }

  /** 是否有完整的登录凭证 */
  get hasCredentials() {
    return !!(this.sessdata && this.csrf);
  }

  /** 是否有 refresh_token（可刷新） */
  get canRefresh() {
    return !!this.refreshToken;
  }

  /** Cookie 是否过期 */
  get isCookieExpired() {
    return Date.now() > this.cookieExpire;
  }

  /** Cookie 剩余毫秒数 */
  get cookieRemainingMs() {
    return Math.max(0, this.cookieExpire - Date.now());
  }

  /** Cookie 剩余天数 */
  get cookieRemainingDays() {
    return Math.round(this.cookieRemainingMs / (24 * 60 * 60 * 1000));
  }

  // ============================================================
  // 状态管理（状态机）
  // ============================================================

  /** 是否处于活跃可用状态 */
  get isActive() {
    return this.status === ACCOUNT_STATUS.ACTIVE;
  }

  /** 是否需要刷新 */
  get needsRefresh() {
    return this.status === ACCOUNT_STATUS.NEEDS_REFRESH ||
           (this.hasCredentials && this.cookieRemainingDays < 7);
  }

  /** 是否需要重新登录 */
  get needsRelogin() {
    return this.status === ACCOUNT_STATUS.NEEDS_RELOGIN ||
           this.status === ACCOUNT_STATUS.REFRESH_FAILED ||
           !this.hasCredentials;
  }

  /** 是否被封号/终止 */
  get isTerminated() {
    return this.status === ACCOUNT_STATUS.BANNED ||
           this.status === ACCOUNT_STATUS.TERMINATED;
  }

  /**
   * 转换状态（带简单校验）
   * @param {string} newStatus - 目标状态
   * @param {string} reason - 转换原因
   */
  transitionTo(newStatus, reason = '') {
    const oldStatus = this.status;
    this.status = newStatus;
    if (reason) {
      this.addRiskEvent('status_change', `${oldStatus} → ${newStatus}: ${reason}`);
    }
    return this;
  }

  // ============================================================
  // 活跃与操作记录
  // ============================================================

  /** 记录一次活跃操作 */
  recordActivity(operationType = 'unknown') {
    this.lastActive = new Date().toISOString();
    this.operationCount++;
    const today = new Date().toISOString().slice(0, 10);
    this.dailyOperations[today] = (this.dailyOperations[today] || 0) + 1;
    return this;
  }

  /** 获取今日操作次数 */
  get todayOperations() {
    const today = new Date().toISOString().slice(0, 10);
    return this.dailyOperations[today] || 0;
  }

  /** 添加风控事件 */
  addRiskEvent(type, detail) {
    this.riskEvents.push({
      time: new Date().toISOString(),
      type,
      detail,
    });
    // 最多保留50条
    if (this.riskEvents.length > 50) {
      this.riskEvents = this.riskEvents.slice(-50);
    }
    return this;
  }

  // ============================================================
  // Cookie 操作
  // ============================================================

  /**
   * 从 cookie 字符串解析并设置 cookies
   * @param {string} cookieStr - "SESSDATA=xxx; bili_jct=xxx; ..."
   */
  setCookieFromString(cookieStr) {
    this.cookieStr = cookieStr;
    this.cookies = {};
    cookieStr.split(';').forEach(pair => {
      const [name, ...valueParts] = pair.trim().split('=');
      if (name) {
        this.cookies[name.trim()] = valueParts.join('=').trim();
      }
    });
    // 自动提取 uid
    if (this.cookies[COOKIE_FIELDS.DEDE_USER_ID]) {
      this.uid = this.cookies[COOKIE_FIELDS.DEDE_USER_ID];
    }
    return this;
  }

  /**
   * 从 puppeteer cookies 数组设置
   * @param {Array} cookieArray - [{ name, value, ... }]
   */
  setCookieFromArray(cookieArray) {
    this.cookies = {};
    cookieArray.forEach(c => {
      this.cookies[c.name] = c.value;
    });
    this.cookieStr = cookieArray.map(c => `${c.name}=${c.value}`).join('; ');
    if (this.cookies[COOKIE_FIELDS.DEDE_USER_ID]) {
      this.uid = this.cookies[COOKIE_FIELDS.DEDE_USER_ID];
    }
    return this;
  }

  /**
   * 更新 Cookie（刷新成功后调用）
   * @param {Object} newCookies - 新的 cookies 对象
   * @param {string} newRefreshToken - 新的 refresh_token
   */
  updateCredentials(newCookies, newRefreshToken) {
    if (newCookies) {
      if (typeof newCookies === 'string') {
        this.setCookieFromString(newCookies);
      } else if (Array.isArray(newCookies)) {
        this.setCookieFromArray(newCookies);
      } else {
        this.cookies = { ...this.cookies, ...newCookies };
        this.cookieStr = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      }
    }
    if (newRefreshToken) {
      this.refreshToken = newRefreshToken;
    }
    this.lastRefresh = new Date().toISOString();
    this.cookieExpire = Date.now() + COOKIE_TTL.DEFAULT;
    this.transitionTo(ACCOUNT_STATUS.ACTIVE, 'Cookie刷新成功');
    return this;
  }

  /**
   * 标记登录成功
   */
  markLoginSuccess() {
    this.lastLogin = new Date().toISOString();
    this.lastActive = this.lastLogin;
    this.cookieExpire = Date.now() + COOKIE_TTL.DEFAULT;
    this.trustedDevice = true;
    this.transitionTo(ACCOUNT_STATUS.ACTIVE, '登录成功');
    return this;
  }

  // ============================================================
  // 序列化
  // ============================================================

  /** 转换为纯对象（用于持久化） */
  toJSON() {
    return {
      id: this.id,
      uid: this.uid,
      phone: this.phone,
      remark: this.remark,
      username: this.username,
      status: this.status,
      trustedDevice: this.trustedDevice,
      cookies: this.cookies,
      cookieStr: this.cookieStr,
      refreshToken: this.refreshToken,
      fingerprintId: this.fingerprintId,
      fingerprint: this.fingerprint,
      proxy: this.proxy,
      userAgent: this.userAgent,
      userDataDir: this.userDataDir,
      createdAt: this.createdAt,
      lastLogin: this.lastLogin,
      lastActive: this.lastActive,
      lastRefresh: this.lastRefresh,
      lastCheck: this.lastCheck,
      cookieExpire: this.cookieExpire,
      healthScore: this.healthScore,
      healthFactors: this.healthFactors,
      alertLevel: this.alertLevel,
      predictDays: this.predictDays,
      riskEvents: this.riskEvents,
      operationCount: this.operationCount,
      dailyOperations: this.dailyOperations,
      useProxy: this.useProxy,
      persona: this.persona,
      behaviorProfile: this.behaviorProfile,
      extra: this.extra,
    };
  }

  /** 从纯对象创建 Account 实例 */
  static fromJSON(data) {
    return new Account(data);
  }

  /**
   * 转换为前端展示用的精简对象（脱敏）
   */
  toDisplay() {
    return {
      id: this.id,
      uid: this.uid,
      phone: this.phone ? this.phone.slice(0, 3) + '****' + this.phone.slice(-4) : '',
      remark: this.remark,
      status: this.status,
      trustedDevice: this.trustedDevice,
      hasCredentials: this.hasCredentials,
      canRefresh: this.canRefresh,
      cookieRemainingDays: this.cookieRemainingDays,
      cookieExpire: this.cookieExpire,
      healthScore: this.healthScore,
      alertLevel: this.alertLevel,
      predictDays: this.predictDays,
      lastLogin: this.lastLogin,
      lastActive: this.lastActive,
      lastRefresh: this.lastRefresh,
      fingerprintId: this.fingerprintId,
      proxy: this.proxy ? (this.proxy.city || this.proxy.proxy) : null,
      todayOperations: this.todayOperations,
      riskEventCount: this.riskEvents.length,
    };
  }
}

export default Account;
