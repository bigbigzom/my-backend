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
    this.proxyCity = data.proxyCity || '';
    this.userAgent = data.userAgent || '';
    // v1.5.3：IP粘性字段（注册时的中国IP + 运行时绑定 + 失败计数）
    // 目标：每个账号尽可能长时间复用同一个中国IP，直到确认失效才更换
    this.registeredProxyIp = data.registeredProxyIp || data.proxy || null;  // 注册时使用的中国IP（本地同步过来）
    this.lastUsedProxyIp = data.lastUsedProxyIp || data.registeredProxyIp || data.proxy || null;  // 最近一次实际使用的IP
    this.proxyIpFailCount = data.proxyIpFailCount || 0;  // 当前绑定IP连续失败次数（>=3 视为失效）
    this.proxyIpBoundAt = data.proxyIpBoundAt || data.registeredAt || null;  // 当前IP绑定时间
    this.registeredAt = data.registeredAt || null;  // 注册时间戳
    // 完整设备环境（本地登录时采集，后端操作时必须使用相同环境，降低平台安全机制）
    this.deviceProfile = data.deviceProfile || data.deviceEnv || null;

    // 养号系统字段
    this.accountType = data.accountType || 'comment_account';  // video_publisher / comment_account
    this.cultivationStage = data.cultivationStage || 'newborn'; // newborn/growing/maturing/ready
    this.daysInStage = data.daysInStage || 0;
    this.totalCultivationDays = data.totalCultivationDays || 0;
    this.lastCultivationDate = data.lastCultivationDate || null;
    this.userDataDir = data.userDataDir || '';
    // v3.1 Cookie 延迟使用（温号期/错峰窗口/错峰刷新）
    this.warmUpStartedAt = data.warmUpStartedAt || null;        // 温号期起点（导入/刷新时间）
    this.warmUpDurationHours = data.warmUpDurationHours || 0;   // 温号总时长（0=用默认72h）
    this.warmUpDisabled = data.warmUpDisabled || false;          // 手动关闭温号（老号迁移用）
    this.activeWindowStart = data.activeWindowStart != null ? data.activeWindowStart : null; // 活跃窗口起(h)
    this.activeWindowEnd = data.activeWindowEnd != null ? data.activeWindowEnd : null;       // 活跃窗口止(h)
    this.nextRefreshAt = data.nextRefreshAt || null;            // 错峰刷新时刻

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

    // 平台安全机制记录
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

  /** 是否被账号受限/终止 */
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

  /** 添加安全事件 */
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
  // v1.5.3 IP粘性管理（每个账号尽可能复用同一个中国IP）
  // ============================================================
  /**
   * 获取账号应使用的代理IP（粘性策略）
   * 优先级：lastUsedProxyIp（未失效）> registeredProxyIp（未失效）> null（调用方从池分配新IP）
   * @param {Function} isProxyReadyFn - 检查IP是否仍在可用池的函数 (proxyAddr) => boolean
   * @returns {string|null} ip:port 字符串
   */
  getStickyProxy(isProxyReadyFn) {
    // 1. 优先用最近一次使用的IP（如果仍可用且失败次数<3）
    if (this.lastUsedProxyIp && this.proxyIpFailCount < 3) {
      if (!isProxyReadyFn || isProxyReadyFn(this.lastUsedProxyIp)) {
        return this.lastUsedProxyIp;
      }
    }
    // 2. 回退到注册时的IP（如果仍可用）
    if (this.registeredProxyIp && this.registeredProxyIp !== this.lastUsedProxyIp) {
      if (!isProxyReadyFn || isProxyReadyFn(this.registeredProxyIp)) {
        this.lastUsedProxyIp = this.registeredProxyIp;
        this.proxyIpFailCount = 0;
        this.proxyIpBoundAt = Date.now();
        return this.registeredProxyIp;
      }
    }
    // 3. 都不可用 → 返回null，调用方从代理池分配新IP
    return null;
  }

  /**
   * 绑定一个新的代理IP（当粘性IP失效后，从池分配到新IP时调用）
   */
  bindProxy(proxyAddr) {
    if (!proxyAddr) return this;
    this.lastUsedProxyIp = proxyAddr;
    this.proxyIpFailCount = 0;
    this.proxyIpBoundAt = Date.now();
    return this;
  }

  /**
   * 标记当前绑定IP失败一次（连续3次视为失效，下次getStickyProxy会返回null触发换新）
   */
  markProxyFailed() {
    this.proxyIpFailCount = (this.proxyIpFailCount || 0) + 1;
    return this;
  }

  /**
   * 标记当前IP使用成功（重置失败计数）
   */
  markProxySuccess() {
    this.proxyIpFailCount = 0;
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
      proxyCity: this.proxyCity,
      userAgent: this.userAgent,
      registeredProxyIp: this.registeredProxyIp,
      lastUsedProxyIp: this.lastUsedProxyIp,
      proxyIpFailCount: this.proxyIpFailCount,
      proxyIpBoundAt: this.proxyIpBoundAt,
      registeredAt: this.registeredAt,
      deviceProfile: this.deviceProfile,
      accountType: this.accountType,
      cultivationStage: this.cultivationStage,
      daysInStage: this.daysInStage,
      totalCultivationDays: this.totalCultivationDays,
      lastCultivationDate: this.lastCultivationDate,
      userDataDir: this.userDataDir,
      warmUpStartedAt: this.warmUpStartedAt,
      warmUpDurationHours: this.warmUpDurationHours,
      warmUpDisabled: this.warmUpDisabled,
      activeWindowStart: this.activeWindowStart,
      activeWindowEnd: this.activeWindowEnd,
      nextRefreshAt: this.nextRefreshAt,
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
      proxyCity: this.proxyCity,
      deviceProfile: this.deviceProfile ? {
        platform: this.deviceProfile.platform,
        screen: `${this.deviceProfile.screenWidth}x${this.deviceProfile.screenHeight}`,
        timezone: this.deviceProfile.timezone,
        userAgent: this.deviceProfile.userAgent ? this.deviceProfile.userAgent.substring(0, 50) + '...' : '',
      } : null,
      todayOperations: this.todayOperations,
      riskEventCount: this.riskEvents.length,
    };
  }
}

export default Account;
