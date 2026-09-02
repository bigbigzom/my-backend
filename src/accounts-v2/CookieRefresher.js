/**
 * CookieRefresher - B站Cookie刷新引擎（完整6步流程）
 *
 * 基于 bilibili-API-collect 官方文档实现。
 * 这是从"7天过期"到"无限续期"的核心突破点。
 *
 * 完整流程：
 * 1. 检查是否需要刷新（cookie/info）
 * 2. RSA-OAEP加密生成 CorrespondPath
 * 3. 获取 refresh_csrf 实时口令（correspond/1/）
 * 4. 刷新Cookie获取新会话（cookie/refresh）
 * 5. 确认更新使旧会话失效（confirm/refresh）
 * 6. SSO跨域登录（保持全局会话）
 *
 * 设计模式：Template Method（模板方法）+ Event Emitter
 * - 每一步是独立方法，可单独调用/测试
 * - 每一步触发事件，便于监控和日志
 * - 失败时保留中间状态，便于重试
 */
import { EventEmitter } from 'events';
import { BiliAuthAPI } from './BiliAuthAPI.js';
import { ACCOUNT_STATUS, TIMEOUTS, INTERVALS } from './constants.js';

export class CookieRefresher extends EventEmitter {
  /**
   * @param {Account} account - 要刷新的账号
   * @param {Object} options - 配置
   * @param {string} options.userAgent - UA
   * @param {string} options.proxy - 代理
   */
  constructor(account, options = {}) {
    super();
    this.account = account;
    this.options = options;
    this.api = new BiliAuthAPI({
      userAgent: options.userAgent || account.userAgent,
      proxy: options.proxy || account.proxy,
      deviceProfile: account.deviceProfile || options.deviceProfile || null,
    });
    this.stepResults = {}; // 每步的结果
    this.currentStep = 0;
  }

  // ============================================================
  // 完整刷新流程
  // ============================================================

  /**
   * 执行完整的6步刷新流程
   * @returns {Object} { success, newCookies, newRefreshToken, steps }
   */
  async refresh() {
    this.emit('refreshStart', { accountId: this.account.id, uid: this.account.uid });

    try {
      // 前置检查
      if (!this.account.hasCredentials) {
        throw new Error('账号没有完整的登录凭证（缺少SESSDATA或bili_jct）');
      }
      if (!this.account.canRefresh) {
        throw new Error('账号没有refresh_token，无法刷新（需要重新登录获取ac_time_value）');
      }

      // 步骤1：检查是否需要刷新
      this.currentStep = 1;
      const info = await this.step1_checkNeedRefresh();
      this.stepResults.step1 = info;

      // 如果不需要刷新，直接返回成功（但不更新Cookie）
      if (!info.refresh) {
        this.emit('refreshSkip', { reason: 'Cookie不需要刷新', accountId: this.account.id });
        return { success: true, skipped: true, reason: '不需要刷新', steps: this.stepResults };
      }

      // 步骤2：生成 CorrespondPath
      this.currentStep = 2;
      const correspondPath = await this.step2_generateCorrespondPath(info.timestamp);
      this.stepResults.step2 = { correspondPath: correspondPath.substring(0, 20) + '...' };

      // 步骤3：获取 refresh_csrf
      this.currentStep = 3;
      const refreshCsrf = await this.step3_getRefreshCsrf(correspondPath);
      this.stepResults.step3 = { refreshCsrf: refreshCsrf.substring(0, 10) + '...' };

      // 步骤4：刷新Cookie
      this.currentStep = 4;
      const oldRefreshToken = this.account.refreshToken; // 必须保存旧的
      const refreshResult = await this.step4_refreshCookie(refreshCsrf);
      this.stepResults.step4 = { newRefreshToken: refreshResult.newRefreshToken.substring(0, 10) + '...' };

      // 步骤5：确认更新（使用旧refreshToken + 新csrf）
      this.currentStep = 5;
      const newCsrf = refreshResult.newCookies['bili_jct'] || this.account.csrf;
      const newCookieStr = this._buildCookieStr(refreshResult.newCookies);
      await this.step5_confirmRefresh(newCsrf, oldRefreshToken, newCookieStr);
      this.stepResults.step5 = { confirmed: true };

      // 步骤6：SSO跨域登录（简化：访问B站首页触发SSO）
      this.currentStep = 6;
      await this.step6_ssoLogin(newCookieStr);
      this.stepResults.step6 = { sso: true };

      // 更新账号凭证
      this.account.updateCredentials(refreshResult.newCookies, refreshResult.newRefreshToken);
      this.account.lastCheck = new Date().toISOString();

      this.emit('refreshSuccess', {
        accountId: this.account.id,
        uid: this.account.uid,
        newCookieExpire: this.account.cookieExpire,
        steps: this.stepResults,
      });

      return {
        success: true,
        skipped: false,
        newCookies: refreshResult.newCookies,
        newRefreshToken: refreshResult.newRefreshToken,
        steps: this.stepResults,
      };
    } catch (e) {
      this.emit('refreshFailed', {
        accountId: this.account.id,
        uid: this.account.uid,
        step: this.currentStep,
        error: e.message,
        steps: this.stepResults,
      });

      // 刷新失败的状态转换
      if (this.currentStep >= 4) {
        // 刷新接口调用了但失败，可能Cookie已部分失效
        this.account.transitionTo(ACCOUNT_STATUS.REFRESH_FAILED, `步骤${this.currentStep}失败: ${e.message}`);
      }

      return {
        success: false,
        error: e.message,
        step: this.currentStep,
        steps: this.stepResults,
      };
    }
  }

  // ============================================================
  // 各步骤独立方法（可单独调用/测试）
  // ============================================================

  /** 步骤1：检查是否需要刷新 */
  async step1_checkNeedRefresh() {
    this.emit('stepStart', { step: 1, name: 'checkCookieInfo' });
    const result = await this.api.checkCookieInfo(this.account.cookieStr);
    this.emit('stepComplete', { step: 1, name: 'checkCookieInfo', result });
    return result;
  }

  /** 步骤2：生成 CorrespondPath */
  async step2_generateCorrespondPath(timestamp) {
    this.emit('stepStart', { step: 2, name: 'generateCorrespondPath' });
    const result = this.api.generateCorrespondPath(timestamp);
    this.emit('stepComplete', { step: 2, name: 'generateCorrespondPath' });
    return result;
  }

  /** 步骤3：获取 refresh_csrf */
  async step3_getRefreshCsrf(correspondPath) {
    this.emit('stepStart', { step: 3, name: 'getRefreshCsrf' });
    const result = await this.api.getRefreshCsrf(correspondPath, this.account.cookieStr);
    this.emit('stepComplete', { step: 3, name: 'getRefreshCsrf' });
    return result;
  }

  /** 步骤4：刷新Cookie */
  async step4_refreshCookie(refreshCsrf) {
    this.emit('stepStart', { step: 4, name: 'refreshCookie' });
    const result = await this.api.refreshCookie({
      csrf: this.account.csrf,
      refreshCsrf,
      refreshToken: this.account.refreshToken,
      cookieStr: this.account.cookieStr,
    });
    this.emit('stepComplete', { step: 4, name: 'refreshCookie' });
    return result;
  }

  /** 步骤5：确认更新 */
  async step5_confirmRefresh(newCsrf, oldRefreshToken, newCookieStr) {
    this.emit('stepStart', { step: 5, name: 'confirmRefresh' });
    const result = await this.api.confirmRefresh({
      csrf: newCsrf,
      oldRefreshToken,
      cookieStr: newCookieStr,
    });
    this.emit('stepComplete', { step: 5, name: 'confirmRefresh', result });
    return result;
  }

  /** 步骤6：SSO跨域登录（简化实现） */
  async step6_ssoLogin(newCookieStr) {
    this.emit('stepStart', { step: 6, name: 'ssoLogin' });
    try {
      // 访问B站首页触发SSO cookie设置
      await this.api._request('https://www.bilibili.com', {
        method: 'GET',
        cookie: newCookieStr,
      });
      this.emit('stepComplete', { step: 6, name: 'ssoLogin', result: true });
      return true;
    } catch (e) {
      // SSO步骤失败不影响主流程
      this.emit('stepComplete', { step: 6, name: 'ssoLogin', result: false, warning: e.message });
      return false;
    }
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /** 从Cookie对象构建Cookie字符串 */
  _buildCookieStr(cookieObj) {
    if (!cookieObj || Object.keys(cookieObj).length === 0) {
      return this.account.cookieStr;
    }
    // 合并新旧Cookie（新的覆盖旧的）
    const merged = { ...this._parseCookieStr(this.account.cookieStr), ...cookieObj };
    return Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** 解析Cookie字符串为对象 */
  _parseCookieStr(cookieStr) {
    const obj = {};
    if (!cookieStr) return obj;
    cookieStr.split(';').forEach(pair => {
      const [name, ...valueParts] = pair.trim().split('=');
      if (name) obj[name.trim()] = valueParts.join('=').trim();
    });
    return obj;
  }
}

export default CookieRefresher;
