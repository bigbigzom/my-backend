/**
 * RiskController - 风控降级与全局熔断（v7.1 新增）
 *
 * 职责：账号风控等级评估 + 自动降级 + 全局熔断
 * 被所有Service执行前调用，不重复造轮子。
 *
 * 风控等级：low → medium → high → cooling → muted
 */

const RISK_LEVELS = {
  LOW: { level: 'low', score: 0, commentMultiplier: 1.0 },
  MEDIUM: { level: 'medium', score: 30, commentMultiplier: 0.5 },
  HIGH: { level: 'high', score: 60, commentMultiplier: 0.2 },
  COOLING: { level: 'cooling', score: 80, commentMultiplier: 0 },
  MUTED: { level: 'muted', score: 100, commentMultiplier: 0 },
};

export class RiskController {
  constructor({ accountService, globalPolicyService }) {
    this.accountService = accountService;
    this.globalPolicyService = globalPolicyService;
    this.globalMuted = false;
    this.mutedUntil = null;
    this.consecutiveRiskEvents = 0;
    this.riskLogs = [];
  }

  /**
   * 评估账号风控等级
   * @param {string} accountId
   * @param {Object} factors - 风控因素 { commentDeleted, captcha, rateLimited, ipFlagged }
   */
  evaluate(accountId, factors = {}) {
    const account = this.accountService.get(accountId);
    if (!account) return { level: 'muted', canAct: false };

    let score = account.riskScore || 0;
    if (factors.commentDeleted) score += 15;
    if (factors.captcha) score += 25;
    if (factors.rateLimited) score += 30;
    if (factors.ipFlagged) score += 20;
    // 自然衰减（每24小时-5分）
    const lastCheck = account.lastRiskCheck ? Date.now() - new Date(account.lastRiskCheck).getTime() : 86400000;
    score = Math.max(0, score - Math.floor(lastCheck / 86400000) * 5);

    let level = 'low';
    if (score >= 100) level = 'muted';
    else if (score >= 80) level = 'cooling';
    else if (score >= 60) level = 'high';
    else if (score >= 30) level = 'medium';

    this.accountService.update(accountId, {
      riskLevel: level,
      riskScore: score,
      lastRiskCheck: new Date().toISOString(),
      riskFactors: Object.keys(factors).filter(k => factors[k]),
    });

    const canAct = !this.globalMuted && level !== 'muted' && level !== 'cooling';
    if (!canAct) this.consecutiveRiskEvents++;
    else this.consecutiveRiskEvents = Math.max(0, this.consecutiveRiskEvents - 1);

    // 全局熔断检测
    this._checkGlobalCircuitBreaker();

    return { level, score, canAct, multiplier: RISK_LEVELS[level.toUpperCase()]?.commentMultiplier || 0 };
  }

  /** 执行前检查（所有Service调用） */
  preCheck(accountId) {
    if (this.globalMuted) {
      return { allowed: false, reason: '全局熔断中', mutedUntil: this.mutedUntil };
    }
    const account = this.accountService.get(accountId);
    if (!account) return { allowed: false, reason: '账号不存在' };
    if (account.riskLevel === 'muted') return { allowed: false, reason: '账号已封禁' };
    if (account.riskLevel === 'cooling') return { allowed: false, reason: '账号冷却中' };
    return { allowed: true };
  }

  /** 标记账号风控事件 */
  reportRiskEvent(accountId, eventType) {
    const factors = {};
    if (eventType === 'comment_deleted') factors.commentDeleted = true;
    if (eventType === 'captcha') factors.captcha = true;
    if (eventType === 'rate_limited') factors.rateLimited = true;
    if (eventType === 'ip_flagged') factors.ipFlagged = true;
    const result = this.evaluate(accountId, factors);
    this.riskLogs.push({ accountId, eventType, timestamp: Date.now(), resultLevel: result.level });
    if (this.riskLogs.length > 500) this.riskLogs = this.riskLogs.slice(-500);
    return result;
  }

  /** 全局熔断 */
  _checkGlobalCircuitBreaker() {
    const threshold = this.globalPolicyService?.get()?.risk?.globalMuteThreshold || 5;
    if (this.consecutiveRiskEvents >= threshold && !this.globalMuted) {
      this.globalMuted = true;
      const hours = this.globalPolicyService?.get()?.risk?.cooldownHours || 4;
      this.mutedUntil = Date.now() + hours * 3600000;
      console.warn(`[RiskController] ⚠️ 全局熔断触发！连续${this.consecutiveRiskEvents}个风控事件，冷却${hours}小时`);
    }
    // 自动恢复
    if (this.globalMuted && this.mutedUntil && Date.now() > this.mutedUntil) {
      this.globalMuted = false;
      this.consecutiveRiskEvents = 0;
      this.mutedUntil = null;
      console.log('[RiskController] ✅ 全局熔断已解除');
    }
  }

  /** 手动解除全局熔断 */
  liftGlobalMute() {
    this.globalMuted = false;
    this.consecutiveRiskEvents = 0;
    this.mutedUntil = null;
    return { success: true };
  }

  /** 获取风控面板数据 */
  getDashboard() {
    const accounts = this.accountService.list();
    const byLevel = { low: 0, medium: 0, high: 0, cooling: 0, muted: 0 };
    for (const a of accounts) {
      const lvl = a.riskLevel || 'low';
      byLevel[lvl] = (byLevel[lvl] || 0) + 1;
    }
    return {
      globalMuted: this.globalMuted,
      mutedUntil: this.mutedUntil,
      consecutiveRiskEvents: this.consecutiveRiskEvents,
      accountDistribution: byLevel,
      totalAccounts: accounts.length,
      recentLogs: this.riskLogs.slice(-20).reverse(),
    };
  }
}

export default RiskController;
