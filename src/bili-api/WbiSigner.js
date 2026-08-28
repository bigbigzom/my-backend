/**
 * WbiSigner - B站WBI签名生成器
 *
 * B站部分API（如评论列表 /x/v2/reply/wbi/main）需要WBI签名。
 * WBI签名通过 img_key 和 sub_key 混合生成 mixinKey，然后对请求参数排序后MD5签名。
 *
 * 参考：bilibili-API-collect WBI签名文档
 */
import crypto from 'crypto';

// WBI签名混淆表（固定）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51,
  30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
];

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
   * 对参数进行WBI签名
   * @param {Object} params - 请求参数
   * @returns {Object} 签名后的参数（含 w_rid, wts）
   */
  sign(params) {
    if (!this.mixinKey) {
      console.warn('[WbiSigner] mixinKey未初始化，返回原参数');
      return { ...params };
    }
    const wts = Math.floor(Date.now() / 1000);
    const query = { ...params, wts };
    // 按key排序
    const sorted = Object.keys(query).sort().reduce((acc, key) => {
      acc[key] = this._encodeValue(query[key]);
      return acc;
    }, {});
    const queryStr = Object.entries(sorted)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const w_rid = crypto.createHash('md5').update(queryStr + this.mixinKey).digest('hex');
    return { ...params, w_rid, wts };
  }

  /**
   * 编码参数值（过滤特殊字符）
   */
  _encodeValue(value) {
    if (typeof value === 'object') value = JSON.stringify(value);
    return String(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16));
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
