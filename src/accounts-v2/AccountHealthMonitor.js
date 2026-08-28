/**
 * AccountHealthMonitor - 账号健康度监控
 *
 * 5维度综合评分，预测可用天数，分级预警。
 *
 * 评分维度（总和100分）：
 * 1. SESSDATA年龄（30%）- 越新越好
 * 2. 最后活跃时间（20%）- 越近越好
 * 3. 操作频率（20%）- 正常区间最好，过频扣分
 * 4. 风控事件（20%）- 无事件最好
 * 5. refresh_token有效性（10%）- 有则满分
 *
 * 设计模式：Strategy（策略模式）- 每个维度是独立的评分策略
 */
import { HEALTH_WEIGHTS, ALERT_LEVEL, COOKIE_TTL } from './constants.js';

export class AccountHealthMonitor {
  constructor() {
    this.weights = HEALTH_WEIGHTS;
  }

  /**
   * 评估账号健康度（综合评分）
   * @param {Account} account - 账号对象
   * @returns {Object} { score, factors, alertLevel, predictDays, details }
   */
  evaluate(account) {
    const factors = {
      sessdataAge: this._scoreSessdataAge(account),
      lastActive: this._scoreLastActive(account),
      operationFrequency: this._scoreOperationFrequency(account),
      riskEvents: this._scoreRiskEvents(account),
      refreshToken: this._scoreRefreshToken(account),
    };

    // 加权计算总分
    const score = Math.round(
      factors.sessdataAge * this.weights.SESSDATA_AGE / 100 +
      factors.lastActive * this.weights.LAST_ACTIVE / 100 +
      factors.operationFrequency * this.weights.OPERATION_FREQUENCY / 100 +
      factors.riskEvents * this.weights.RISK_EVENTS / 100 +
      factors.refreshToken * this.weights.REFRESH_TOKEN / 100
    );

    const predictDays = this._predictDays(account, score);
    const alertLevel = this._getAlertLevel(account, score, predictDays);

    // 更新账号的健康度字段
    account.healthScore = score;
    account.healthFactors = factors;
    account.alertLevel = alertLevel;
    account.predictDays = predictDays;
    account.lastCheck = new Date().toISOString();

    return { score, factors, alertLevel, predictDays };
  }

  // ============================================================
  // 各维度评分策略
  // ============================================================

  /**
   * 维度1：SESSDATA年龄评分（30%）
   * <7天=100, 7-14天=70, 14-21天=40, >21天=20, 过期=0
   */
  _scoreSessdataAge(account) {
    if (!account.lastLogin && !account.lastRefresh) return 50;
    const lastCredTime = new Date(account.lastRefresh || account.lastLogin).getTime();
    const ageDays = (Date.now() - lastCredTime) / (24 * 60 * 60 * 1000);

    if (account.isCookieExpired) return 0;
    if (ageDays < 7) return 100;
    if (ageDays < 14) return 70;
    if (ageDays < 21) return 40;
    return 20;
  }

  /**
   * 维度2：最后活跃时间评分（20%）
   * <1天=100, 1-3天=70, 3-7天=40, >7天=0
   */
  _scoreLastActive(account) {
    if (!account.lastActive) return 30;
    const days = (Date.now() - new Date(account.lastActive).getTime()) / (24 * 60 * 60 * 1000);
    if (days < 1) return 100;
    if (days < 3) return 70;
    if (days < 7) return 40;
    return 0;
  }

  /**
   * 维度3：操作频率评分（20%）
   * 今日0-5次=100, 6-15次=70, 16-30次=40, >30次=10（过频触发风控）
   */
  _scoreOperationFrequency(account) {
    const today = account.todayOperations;
    if (today <= 5) return 100;
    if (today <= 15) return 70;
    if (today <= 30) return 40;
    return 10;
  }

  /**
   * 维度4：风控事件评分（20%）
   * 无事件=100, 1-2条=60, 3-5条=30, >5条=0
   * 最近7天内的事件权重更高
   */
  _scoreRiskEvents(account) {
    const events = account.riskEvents || [];
    if (events.length === 0) return 100;

    // 计算最近7天的事件数
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentEvents = events.filter(e => new Date(e.time).getTime() > sevenDaysAgo);

    if (recentEvents.length === 0 && events.length <= 2) return 80;
    if (recentEvents.length <= 1) return 60;
    if (recentEvents.length <= 3) return 30;
    return 0;
  }

  /**
   * 维度5：refresh_token有效性评分（10%）
   * 有=100, 无=0（没有就无法自动刷新）
   */
  _scoreRefreshToken(account) {
    return account.canRefresh ? 100 : 0;
  }

  // ============================================================
  // 预测与预警
  // ============================================================

  /**
   * 预测账号还能使用多少天
   * 基于Cookie剩余天数 + 健康度修正
   */
  _predictDays(account, score) {
    const cookieDays = account.cookieRemainingDays;

    // 如果没有refresh_token，最多用到Cookie过期
    if (!account.canRefresh) {
      return Math.min(cookieDays, 30);
    }

    // 有refresh_token，理论上可以无限刷新
    // 但健康度低会增加刷新失败概率
    if (score >= 80) return 90;  // 健康，预计可用3个月+
    if (score >= 60) return 45;  // 良好，预计可用1.5个月
    if (score >= 40) return 14;  // 一般，预计可用2周
    if (score >= 20) return 7;   // 较差，预计可用1周
    return 3;                      // 危险，预计可用3天
  }

  /**
   * 获取预警级别
   */
  _getAlertLevel(account, score, predictDays) {
    if (account.isCookieExpired || !account.hasCredentials) return ALERT_LEVEL.EXPIRED;
    if (score < 40 || predictDays < 3) return ALERT_LEVEL.CRITICAL;
    if (score < 60 || predictDays < 7) return ALERT_LEVEL.WARNING;
    if (score < 80 || predictDays < 14) return ALERT_LEVEL.ATTENTION;
    return ALERT_LEVEL.NORMAL;
  }

  /**
   * 批量评估所有账号
   * @param {Array<Account>} accounts
   * @returns {Object} { results, summary, alerts }
   */
  evaluateAll(accounts) {
    const results = accounts.map(a => ({
      id: a.id,
      uid: a.uid,
      ...this.evaluate(a),
    }));

    const summary = {
      total: accounts.length,
      normal: results.filter(r => r.alertLevel === ALERT_LEVEL.NORMAL).length,
      attention: results.filter(r => r.alertLevel === ALERT_LEVEL.ATTENTION).length,
      warning: results.filter(r => r.alertLevel === ALERT_LEVEL.WARNING).length,
      critical: results.filter(r => r.alertLevel === ALERT_LEVEL.CRITICAL).length,
      expired: results.filter(r => r.alertLevel === ALERT_LEVEL.EXPIRED).length,
      avgScore: results.length > 0
        ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length)
        : 0,
    };

    const alerts = results
      .filter(r => r.alertLevel !== ALERT_LEVEL.NORMAL)
      .sort((a, b) => b.score - a.score);

    return { results, summary, alerts };
  }
}

export default AccountHealthMonitor;
