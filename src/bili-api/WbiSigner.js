/**
 * WbiSigner - B站WBI签名生成器（v3.1 现代化修复）
 *
 * B站部分API（如评论列表 /x/v2/reply/wbi/main）需要WBI签名。
 * WBI签名通过 img_key 和 sub_key 混合生成 mixinKey，然后对请求参数排序后MD5签名。
 *
 * 参考：bilibili-API-collect WBI签名文档（SocialSisterYi）
 *
 * v3.1 修复（对照官方算法）：
 * - 官方算法：值中 `!'()*` 五个字符被【过滤删除】，再用 urlencode 编码 key/value
 * - 旧实现错误1：把 `!'()*` 替换为 `%xx` 百分号编码（应删除）
 * - 旧实现错误2：签名 query 未做 URL 编码（含中文/% 的参数会导致签名与服务端不一致）
 * - 修复后：sign 生成的 query 与发送的 query 完全一致（先过滤→再 urlencode→再 md5）
 */
import crypto from 'crypto';

// WBI签名混淆表（固定）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51,
  30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
];

// 官方算法：值中需删除的字符集
const FILTER_CHARS = "!'()*";

/** encodeURIComponent 的 JS 原生实现（不额外转义 !'()*，故需先过滤） */
function encodeURIComponentSafe(value) {
  return encodeURIComponent(value);
}

export class WbiSigner {
  constructor() {
    this.imgKey = '';
    this.subKey = '';
    this.mixinKey = '';
    this.lastUpdate = 0;
    this.updateInterval = 60 * 60 * 1000; // 1小时更新一次
  }

  /**
   * 从导航接口获取 img_key 和 sub_key
   * @param {string} cookieStr - Cookie
   * @returns {Promise<boolean>} 是否成功
   */
  async updateKeys(cookieStr = '') {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com',
      };
      if (cookieStr) headers['Cookie'] = cookieStr;
      const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers });
      const data = await res.json();
      if (data.code === 0 && data.data?.wbi_img) {
        const imgUrl = data.data.wbi_img.img_url || '';
        const subUrl = data.data.wbi_img.sub_url || '';
        this.imgKey = imgUrl.split('/').pop().split('.')[0];
        this.subKey = subUrl.split('/').pop().split('.')[0];
        this.mixinKey = this._generateMixinKey(this.imgKey + this.subKey);
        this.lastUpdate = Date.now();
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[WbiSigner] 更新keys失败:', e.message);
      return false;
    }
  }

  /**
   * 生成 mixinKey
   */
  _generateMixinKey(orig) {
    return MIXIN_KEY_ENC_TAB.map(i => orig[i]).join('').slice(0, 32);
  }

  /**
   * 值规范化：转字符串 + 过滤 `!'()*`（官方算法）
   */
  _normalizeValue(value) {
    let s;
    if (typeof value === 'object') s = JSON.stringify(value);
    else s = String(value);
    return s.split('').filter(ch => !FILTER_CHARS.includes(ch)).join('');
  }

  /**
   * 构建签名 query：key/value 均做 urlencode（与发送请求一致）
   */
  _buildQuery(params) {
    return Object.entries(params)
      .map(([k, v]) => `${encodeURIComponentSafe(k)}=${encodeURIComponentSafe(v)}`)
      .join('&');
  }

  /**
   * 对参数进行WBI签名（官方算法，v3.1）
   * @param {Object} params - 请求参数
   * @returns {Object} 签名后的参数（含 w_rid, wts）
   */
  sign(params) {
    if (!this.mixinKey) {
      console.warn('[WbiSigner] mixinKey未初始化，返回原参数');
      return { ...params };
    }
    const wts = Math.floor(Date.now() / 1000);
    // 1. 合并 wts
    const merged = { ...params, wts };
    // 2. 按 key 排序
    const sorted = Object.keys(merged).sort().reduce((acc, key) => {
      acc[key] = this._normalizeValue(merged[key]);
      return acc;
    }, {});
    // 3. urlencode 序列化（先过滤特殊字符）
    const queryStr = this._buildQuery(sorted);
    // 4. md5(query + mixinKey)
    const w_rid = crypto.createHash('md5').update(queryStr + this.mixinKey).digest('hex');
    // 5. 返回原始参数 + 签名（不含已过滤的旧值，保持与发送一致）
    return { ...params, w_rid, wts };
  }

  /**
   * 签名并返回「与签名完全一致的发送用 query 字符串」（B8 修复）
   *
   * 问题背景：旧实现 sign() 返回的 params 携带原始值，调用方再用 encodeURIComponent
   * 重新拼 query，而 encodeURIComponent 不会过滤 `!'()*` 五个字符 —— 当参数值含这些
   * 字符时，发送的 query 与签名字符串不一致，导致 w_rid 校验失败（-352/-403）。
   *
   * 本方法直接返回签名时实际哈希过的 query 串（先过滤再 urlencode，key 升序），
   * 调用方必须原样把它作为 URL query 发送，保证「签名 == 发送」逐字节一致。
   *
   * @param {Object} params - 请求参数（原始值）
   * @returns {{signed:Object, query:string}} signed=签名后参数, query=需原样发送的query
   */
  signAndGetQuery(params) {
    if (!this.mixinKey) {
      console.warn('[WbiSigner] mixinKey未初始化，返回未签名query');
      const normalized = Object.keys(params).sort().reduce((acc, key) => {
        acc[key] = this._normalizeValue(params[key]);
        return acc;
      }, {});
      return { signed: { ...params }, query: this._buildQuery(normalized) };
    }
    const wts = Math.floor(Date.now() / 1000);
    // 1. 合并 wts → 2. 按 key 排序并规范化（过滤 !'()*）→ 3. urlencode 序列化
    const merged = { ...params, wts };
    const sorted = Object.keys(merged).sort().reduce((acc, key) => {
      acc[key] = this._normalizeValue(merged[key]);
      return acc;
    }, {});
    const queryStr = this._buildQuery(sorted);
    // 4. md5(query + mixinKey)
    const w_rid = crypto.createHash('md5').update(queryStr + this.mixinKey).digest('hex');
    // 5. 返回签名参数 + 与哈希完全一致的 query 串
    return { signed: { ...params, w_rid, wts }, query: queryStr };
  }

  /**
   * 确保keys已更新（过期则重新获取）
   */
  async ensureKeys(cookieStr = '') {
    if (!this.mixinKey || Date.now() - this.lastUpdate > this.updateInterval) {
      await this.updateKeys(cookieStr);
    }
    return this.mixinKey;
  }
}

export default WbiSigner;
