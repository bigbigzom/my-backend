/**
 * BiliAuthAPI - B站认证API抽象层
 *
 * 所有B站认证相关API集中管理，API变更只需修改此文件。
 *
 * 职责：
 * - 封装所有认证相关HTTP请求
 * - 处理请求头、Cookie、CSRF
 * - 解析响应，统一返回格式
 * - RSA加密生成 CorrespondPath
 *
 * 不职责：
 * - 不管理账号状态（由 Account 负责）
 * - 不执行刷新流程编排（由 CookieRefresher 负责）
 * - 不存储数据（由 AccountManagerV2 负责）
 *
 * 设计模式：Facade（外观模式）+ 单一职责
 */
import crypto from 'crypto';
import {
  BILI_API, BILI_RSA_PUBLIC_KEY, BILI_HEADERS,
  COOKIE_FIELDS, TIMEOUTS,
} from './constants.js';

export class BiliAuthAPI {
  /**
   * @param {Object} options - 配置
   * @param {string} options.userAgent - User-Agent
   * @param {string} options.proxy - 代理地址（可选）
   * @param {number} options.timeout - 请求超时（毫秒）
   */
  constructor(options = {}) {
    this.userAgent = options.userAgent || BILI_HEADERS.USER_AGENT;
    this.proxy = options.proxy || null;
    this.timeout = options.timeout || TIMEOUTS.API_REQUEST;
  }

  // ============================================================
  // 内部工具方法
  // ============================================================

  /**
   * 构建标准请求头
   * @param {string} cookieStr - Cookie字符串
   * @param {string} referer - Referer
   */
  _buildHeaders(cookieStr = '', referer = BILI_HEADERS.REFERER) {
    const headers = {
      'User-Agent': this.userAgent,
      'Accept': BILI_HEADERS.ACCEPT,
      'Accept-Language': BILI_HEADERS.ACCEPT_LANGUAGE,
      'Referer': referer,
      'Origin': BILI_HEADERS.ORIGIN,
    };
    if (cookieStr) headers['Cookie'] = cookieStr;
    return headers;
  }

  /**
   * 执行HTTP请求
   * @param {string} url - 请求URL
   * @param {Object} options - fetch选项
   */
  async _request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { ...this._buildHeaders(options.cookie), ...(options.headers || {}) },
      });
      clearTimeout(timer);

      // 提取 set-cookie（用于刷新后获取新Cookie）
      const setCookies = res.headers.get('set-cookie') || '';
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      return {
        ok: res.ok,
        status: res.status,
        data,
        setCookies,
        headers: Object.fromEntries(res.headers),
      };
    } catch (e) {
      clearTimeout(timer);
      throw new Error(`请求失败 ${url}: ${e.message}`);
    }
  }

  /**
   * 从 set-cookie 字符串解析新Cookie
   * @param {string} setCookieStr - set-cookie 响应头
   */
  _parseSetCookies(setCookieStr) {
    const cookies = {};
    if (!setCookieStr) return cookies;
    setCookieStr.split(',').forEach(pair => {
      const match = pair.trim().match(/^([^=]+)=([^;]+)/);
      if (match) cookies[match[1].trim()] = match[2].trim();
    });
    return cookies;
  }

  // ============================================================
  // RSA 加密（生成 CorrespondPath）
  // ============================================================

  /**
   * 生成 CorrespondPath（RSA-OAEP加密时间戳）
   * @param {number} timestamp - 毫秒时间戳
   * @returns {string} 小写Base16加密结果
   */
  generateCorrespondPath(timestamp) {
    const plaintext = `refresh_${timestamp}`;
    const encrypted = crypto.publicEncrypt(
      {
        key: BILI_RSA_PUBLIC_KEY,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(plaintext)
    );
    return encrypted.toString('hex').toLowerCase();
  }

  // ============================================================
  // 公开 API 方法
  // ============================================================

  /**
   * 1. 检查Cookie是否需要刷新
   * GET /x/passport-login/web/cookie/info
   * @param {string} cookieStr - 当前Cookie
   * @returns {Object} { refresh: boolean, timestamp: number }
   */
  async checkCookieInfo(cookieStr) {
    const res = await this._request(BILI_API.COOKIE_INFO, {
      method: 'GET',
      cookie: cookieStr,
    });
    if (res.data.code === 0) {
      return {
        refresh: res.data.data.refresh === true,
        timestamp: res.data.data.timestamp || Date.now(),
      };
    }
    throw new Error(`检查Cookie状态失败: ${res.data.message || res.status}`);
  }

  /**
   * 2. 获取 refresh_csrf 实时刷新口令
   * GET https://www.bilibili.com/correspond/1/{correspondPath}
   * @param {string} correspondPath - RSA加密后的路径
   * @param {string} cookieStr - 当前Cookie
   * @returns {string} refresh_csrf
   */
  async getRefreshCsrf(correspondPath, cookieStr) {
    const url = `${BILI_API.CORRESPOND}${correspondPath}`;
    const res = await this._request(url, {
      method: 'GET',
      cookie: cookieStr,
      headers: { 'Accept': 'text/html' },
    });
    // 从HTML中提取 <div id="1-name">xxx</div>
    const match = res.data.raw ? res.data.raw.match(/<div[^>]*id="1-name"[^>]*>([^<]+)<\/div>/) : null;
    if (match) return match[1].trim();
    throw new Error('未能从响应中提取 refresh_csrf');
  }

  /**
   * 3. 刷新Cookie获取新会话
   * POST /x/passport-login/web/cookie/refresh
   * @param {Object} params - { csrf, refreshCsrf, refreshToken, cookieStr }
   * @returns {Object} { newCookies, newRefreshToken }
   */
  async refreshCookie({ csrf, refreshCsrf, refreshToken, cookieStr }) {
    const body = new URLSearchParams({
      csrf,
      refresh_csrf: refreshCsrf,
      source: 'main_web',
      refresh_token: refreshToken,
    });
    const res = await this._request(BILI_API.COOKIE_REFRESH, {
      method: 'POST',
      cookie: cookieStr,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.data.code === 0) {
      const newCookies = this._parseSetCookies(res.setCookies);
      return {
        newCookies,
        newRefreshToken: res.data.data.refresh_token || '',
        status: res.data.data.status,
      };
    }
    throw new Error(`刷新Cookie失败: ${res.data.message || res.status}`);
  }

  /**
   * 4. 确认更新使旧会话失效
   * POST /x/passport-login/web/confirm/refresh
   * @param {Object} params - { csrf(新的), oldRefreshToken, cookieStr(新的) }
   * @returns {boolean} 是否成功
   */
  async confirmRefresh({ csrf, oldRefreshToken, cookieStr }) {
    const body = new URLSearchParams({
      csrf,
      refresh_token: oldRefreshToken,
    });
    const res = await this._request(BILI_API.CONFIRM_REFRESH, {
      method: 'POST',
      cookie: cookieStr,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.data.code === 0) return true;
    throw new Error(`确认刷新失败: ${res.data.message || res.status}`);
  }

  /**
   * 5. 验证登录态
   * GET /x/web-interface/nav
   * @param {string} cookieStr - Cookie
   * @returns {Object} { isLogin, uid, uname, ... }
   */
  async verifyLogin(cookieStr) {
    const res = await this._request(BILI_API.NAV, {
      method: 'GET',
      cookie: cookieStr,
    });
    if (res.data.code === 0) {
      return {
        isLogin: res.data.data.isLogin === true,
        uid: res.data.data.mid || '',
        uname: res.data.data.uname || '',
        face: res.data.data.face || '',
        level: res.data.data.level_info?.current_level || 0,
      };
    }
    return { isLogin: false, error: res.data.message };
  }

  /**
   * 6. 发送短信验证码
   * POST /x/passport-login/web/sms/send
   * @param {Object} params - { phone, cid(国家码), token }
   */
  async sendSmsCode({ phone, cid = '86', token = '' }) {
    const body = new URLSearchParams({ tel: phone, cid, source: 'main_web' });
    if (token) body.append('token', token);
    const res = await this._request(BILI_API.SEND_SMS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.data.code === 0) return { success: true, captchaKey: res.data.data?.captcha_key || '' };
    throw new Error(`发送验证码失败: ${res.data.message || res.status}`);
  }

  /**
   * 7. 短信验证码登录
   * POST /x/passport-login/web/login/sms
   * @param {Object} params - { phone, code, cid }
   * @returns {Object} { cookies, refreshToken }
   */
  async smsLogin({ phone, code, cid = '86' }) {
    const body = new URLSearchParams({
      tel: phone, cid, code, source: 'main_web', keep: true,
    });
    const res = await this._request(BILI_API.SMS_LOGIN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.data.code === 0) {
      const newCookies = this._parseSetCookies(res.setCookies);
      return {
        cookies: newCookies,
        refreshToken: res.data.data?.refresh_token || '',
        uid: res.data.data?.mid || '',
      };
    }
    throw new Error(`短信登录失败: ${res.data.message || res.status}`);
  }
}

export default BiliAuthAPI;
