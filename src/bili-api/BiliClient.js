/**
 * BiliClient - B站API基础客户端
 *
 * 职责：
 * - 统一HTTP请求封装（Cookie、UA、Referer、CSRF）
 * - 请求限流（单账号QPS控制，降低异常判定概率）
 * - 统一错误处理和重试
 * - WBI签名自动注入
 * - 响应解析
 *
 * 设计模式：Facade（外观模式）+ Rate Limiter
 */
import { WbiSigner } from './WbiSigner.js';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class BiliClient {
  /**
   * @param {Object} options
   * @param {string} options.cookieStr - Cookie字符串
   * @param {string} options.csrf - CSRF token (bili_jct)
   * @param {string} options.userAgent - UA
   * @param {string} options.proxy - 代理地址
   * @param {number} options.maxQps - 最大QPS（默认2）
   * @param {number} options.retryCount - 重试次数（默认2）
   */
  constructor(options = {}) {
    this.cookieStr = options.cookieStr || '';
    this.csrf = options.csrf || '';
    this.userAgent = options.userAgent || DEFAULT_UA;
    this.proxy = options.proxy || null;
    this.maxQps = options.maxQps || 2;
    this.retryCount = options.retryCount || 2;
    // 完整设备环境（本地登录时采集，确保后端操作时使用与登录时完全相同的设备环境，降低平台安全机制）
    this.deviceProfile = options.deviceProfile || null;
    if (this.deviceProfile && this.deviceProfile.userAgent) {
      this.userAgent = this.deviceProfile.userAgent;
    }

    // 限流
    this._requestTimes = [];
    this._wbiSigner = new WbiSigner();

    // 统计
    this.stats = { total: 0, success: 0, failed: 0, lastRequest: null };
  }

  /**
   * 更新凭证
   */
  setCredentials(cookieStr, csrf) {
    this.cookieStr = cookieStr;
    this.csrf = csrf;
  }

  /**
   * 限流等待
   */
  async _rateLimit() {
    const now = Date.now();
    // 清理1秒前的记录
    this._requestTimes = this._requestTimes.filter(t => now - t < 1000);
    if (this._requestTimes.length >= this.maxQps) {
      const wait = 1000 - (now - this._requestTimes[0]) + 50;
      await new Promise(r => setTimeout(r, wait));
    }
    this._requestTimes.push(Date.now());
  }

  /**
   * 构建请求头
   */
  _buildHeaders(extra = {}) {
    const dp = this.deviceProfile || {};
    // 使用设备环境中的真实信息构建请求头（与登录时完全一致）
    const acceptLanguage = dp.languages && dp.languages.length > 0
      ? dp.languages.map((l, i) => i === 0 ? l : `${l};q=${(0.9 - i * 0.1).toFixed(1)}`).join(',')
      : (dp.language || 'zh-CN,zh;q=0.9,en;q=0.8');

    const headers = {
      'User-Agent': this.userAgent,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': acceptLanguage,
      'Referer': 'https://www.bilibili.com',
      'Origin': 'https://www.bilibili.com',
      // 设备相关头（模拟真实浏览器）
      'sec-ch-ua': this._buildSecChUa(),
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': `"${dp.platform || 'Windows'}"`,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      ...extra,
    };
    if (this.cookieStr) headers['Cookie'] = this.cookieStr;
    return headers;
  }

  /**
   * 从 User-Agent 构建 sec-ch-ua 头
   */
  _buildSecChUa() {
    const ua = this.userAgent;
    const chromeMatch = ua.match(/Chrome\/(\d+)/);
    const major = chromeMatch ? chromeMatch[1] : '120';
    return `"Not_A Brand";v="8", "Chromium";v="${major}", "Google Chrome";v="${major}"`;
  }

  /**
   * 设置完整设备环境（本地登录时采集）
   */
  setDeviceProfile(deviceProfile) {
    this.deviceProfile = deviceProfile;
    if (deviceProfile && deviceProfile.userAgent) {
      this.userAgent = deviceProfile.userAgent;
    }
  }

  /**
   * 执行GET请求
   * @param {string} url - URL
   * @param {Object} params - 查询参数
   * @param {Object} options - 选项（needWbiSign等）
   */
  async get(url, params = {}, options = {}) {
    return this._request('GET', url, { params, ...options });
  }

  /**
   * 执行POST请求（表单格式）
   * @param {string} url - URL
   * @param {Object} data - 表单数据
   * @param {Object} options - 选项
   */
  async postForm(url, data = {}, options = {}) {
    // 自动注入csrf
    if (this.csrf && !data.csrf) data.csrf = this.csrf;
    const body = new URLSearchParams(data).toString();
    return this._request('POST', url, {
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      ...options,
    });
  }

  /**
   * 执行POST请求（JSON格式）
   */
  async postJson(url, data = {}, options = {}) {
    if (this.csrf && !data.csrf) data.csrf = this.csrf;
    return this._request('POST', url, {
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  }

  /**
   * 核心请求方法
   */
  async _request(method, url, options = {}) {
    const { params = {}, body = null, headers = {}, needWbiSign = false, timeout = 15000 } = options;

    // 限流
    await this._rateLimit();

    // WBI签名
    let finalParams = { ...params };
    if (needWbiSign) {
      await this._wbiSigner.ensureKeys(this.cookieStr);
      finalParams = this._wbiSigner.sign(finalParams);
    }

    // 构建URL
    let fullUrl = url;
    if (Object.keys(finalParams).length > 0) {
      const queryStr = Object.entries(finalParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v)}`)
        .join('&');
      fullUrl += (url.includes('?') ? '&' : '?') + queryStr;
    }

    // 重试循环
    let lastError = null;
    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const res = await fetch(fullUrl, {
          method,
          headers: this._buildHeaders(headers),
          body: method === 'GET' ? undefined : body,
          signal: controller.signal,
        });
        clearTimeout(timer);

        this.stats.total++;
        this.stats.lastRequest = new Date().toISOString();

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }

        if (res.ok && (data.code === 0 || data.code === undefined)) {
          this.stats.success++;
          return { ok: true, status: res.status, data, raw: text };
        }

        // 业务错误
        lastError = new Error(`API错误 code=${data.code}: ${data.message || res.statusText}`);
        lastError.code = data.code;
        lastError.data = data;

        // 特定错误不重试
        if (data.code === -101 /* 未登录 */ || data.code === -352 /* 平台安全机制 */ || data.code === 12001 /* 评论被删 */) {
          this.stats.failed++;
          throw lastError;
        }

        // 重试
        if (attempt < this.retryCount) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        this.stats.failed++;
        throw lastError;

      } catch (e) {
        lastError = e;
        if (attempt < this.retryCount && e.name !== 'AbortError') {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        this.stats.failed++;
        throw e;
      }
    }
    throw lastError;
  }
}

export default BiliClient;
