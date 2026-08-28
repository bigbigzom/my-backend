/**
 * B站API请求封装（集成中国IP代理池）
 *
 * 核心功能：
 * - 每个账号可独立配置是否启用代理（account.useProxy）
 * - 全局代理开关（globalProxyEnabled）
 * - 使用 undici ProxyAgent 发送 HTTPS over HTTP 代理请求
 * - 代理失败自动标记并换代理重试
 * - 完全对齐HAR数据包的请求头、表单格式、WBI签名
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { getProxy, waitForProxy, markProxyFailed, getProxyPoolStats, acquireProxy, releaseProxy, markProxyBlocked } from './proxy-pool.js';
import { getOrCreateFingerprint } from './browser-fingerprint.js';

// ============================================================
// 全局配置
// ============================================================
const config = {
  globalProxyEnabled: true,  // 全局代理开关（可通过API动态修改）
  defaultTimeout: 15000,
  maxRetries: 2,
};

// ============================================================
// 请求头（v2.2：按账号指纹画像差异化，避免多账号请求特征一致）
// ============================================================
// 账号指纹缓存（避免频繁读文件）
const fpCache = new Map();
function getAccountFp(account) {
  if (!account) return null;
  const key = String(account.username || account.id || 'default');
  if (fpCache.has(key)) return fpCache.get(key);
  try {
    const fp = getOrCreateFingerprint(key);
    fpCache.set(key, fp);
    return fp;
  } catch (e) {
    return null;
  }
}
export function getBiliHeaders(account, bv) {
  const fp = getAccountFp(account);
  const chromeVersion = (fp && fp.chromeVersion) || 120;
  const platform = (fp && fp.os === 'mac') ? 'macOS' : 'Windows';
  // UA 按指纹画像（若无画像用合理默认）
  let ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  if (fp && fp.userAgent) ua = fp.userAgent;
  return {
    'User-Agent': ua,
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Origin': 'https://www.bilibili.com',
    'Referer': `https://www.bilibili.com/video/${bv || 'BV1xx411c7mZ'}/`,
    'sec-ch-ua': `"Not=A?Brand";v="99", "Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platform}"`,
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'Cookie': account?.cookie || '',
  };
}

// ============================================================
// 代理判断逻辑
// ============================================================
function shouldUseProxy(account) {
  // 全局开关关闭 → 不使用代理
  if (!config.globalProxyEnabled) return false;
  // 账号未配置 → 默认使用代理
  if (account && account.useProxy === false) return false;
  return true;
}

// ============================================================
// 核心请求方法（带代理重试）
// ============================================================
async function biliFetch({ url, method = 'GET', headers = {}, body = null, account = null, bv = null, useWbi = false }) {
  const useProxy = shouldUseProxy(account);
  let attempt = 0;
  let lastError = null;
  // v2.2 去关联：账号主用IP绑定
  const accountKey = account ? (account.username || account.phone || String(account.id || 'default')) : null;

  while (attempt <= config.maxRetries) {
    attempt++;
    let usedProxy = null;
    let dispatcher = null;
    let acquired = null;

    try {
      // 配置代理（v2.2：按账号获取，绑定主用IP + 防同IP共用）
      if (useProxy) {
        let proxy = null;
        if (account) {
          // 有账号 → 用账号主用IP绑定逻辑
          proxy = acquireProxy(accountKey, account.primaryProxy);
          if (!proxy) {
            console.log(`[BiliAPI] 无空闲代理，等待... (尝试 ${attempt})`);
            const start = Date.now();
            while (!proxy && Date.now() - start < 10000) {
              proxy = acquireProxy(accountKey, account.primaryProxy);
              if (!proxy) await new Promise(r => setTimeout(r, 800));
            }
          }
        } else {
          proxy = getProxy();
          if (!proxy) {
            proxy = await waitForProxy(10000);
          }
        }
        if (proxy) {
          usedProxy = proxy.proxy;
          acquired = usedProxy;
          dispatcher = new ProxyAgent(`http://${usedProxy}`);
          console.log(`[BiliAPI] 使用代理 ${usedProxy} (${proxy.speed}ms) → ${method} ${url.substring(0, 60)}`);
        } else {
          console.warn(`[BiliAPI] 无可用代理，直连请求 → ${method} ${url.substring(0, 60)}`);
        }
      }

      // 构建请求
      const fetchOptions = {
        method,
        headers: { ...getBiliHeaders(account, bv), ...headers },
        signal: AbortSignal.timeout(config.defaultTimeout),
      };
      if (dispatcher) fetchOptions.dispatcher = dispatcher;
      if (body) fetchOptions.body = body;

      // 发送请求
      const res = await undiciFetch(url, fetchOptions);
      const text = await res.text();

      // 尝试解析JSON（B站接口都是JSON）
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      // 释放代理占用（请求结束）
      if (acquired) releaseProxy(acquired);
      // 检测代理是否被B站拦截（海外IP限制、风控）
      if (useProxy && usedProxy) {
        if (data.code === -352 || data.code === -403 || 
            (data.message && (data.message.includes('海外') || data.message.includes('境外') || data.message.includes('风控')))) {
          console.warn(`[BiliAPI] 代理 ${usedProxy} 被B站拦截 (code=${data.code})，标记封禁`);
          markProxyBlocked(usedProxy);  // v2.2: 被B站封禁的IP立即剔除
          if (attempt <= config.maxRetries) continue;
        }
      }

      return { success: true, status: res.status, data, proxy: usedProxy };

    } catch (err) {
      lastError = err;
      if (acquired) releaseProxy(acquired);
      if (useProxy && usedProxy) {
        console.warn(`[BiliAPI] 代理 ${usedProxy} 请求异常: ${err.message}，标记失败并重试 (${attempt}/${config.maxRetries})`);
        markProxyFailed(usedProxy);
      } else {
        console.warn(`[BiliAPI] 请求异常: ${err.message} (${attempt}/${config.maxRetries})`);
      }
      if (attempt <= config.maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }
    }
  }

  return { success: false, error: lastError?.message, proxy: null };
}

// ============================================================
// 业务接口封装
// ============================================================

/** 获取评论列表（WBI签名接口，Base64响应） */
export async function getReplyList({ bv, oid, account, mode = 3, offset = '' }) {
  const params = new URLSearchParams({
    oid: String(oid),
    type: '1',
    mode: String(mode),
    pagination_str: JSON.stringify({ offset }),
    plat: '1',
    seek_rpid: '',
    web_location: '1315875',
  });
  // TODO: WBI签名（w_rid + wts）需要在调用前添加
  const url = `https://api.bilibili.com/x/v2/reply/wbi/main?${params.toString()}`;
  const result = await biliFetch({ url, method: 'GET', account, bv, useWbi: true });
  // Base64解码
  if (result.success && typeof result.data === 'string' && result.data.startsWith('ey')) {
    try {
      result.data = JSON.parse(Buffer.from(result.data, 'base64').toString('utf-8'));
    } catch (e) {
      console.warn('[BiliAPI] Base64解码失败:', e.message);
    }
  }
  return result;
}

/** 发布评论（含dm_img轨迹参数） */
export async function addReply({ bv, oid, account, message, root = 0, parent = 0, csrf, useDmImg = true }) {
  // 构建dm_img轨迹参数（模拟鼠标移动）
  let url = 'https://api.bilibili.com/x/v2/reply/add';
  if (useDmImg) {
    const dmImgList = generateDmImgTrack();
    const dmParams = new URLSearchParams({
      dm_img_list: JSON.stringify(dmImgList),
      dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
      dm_cover_img_str: 'QU5HTEUgKE1pY3Jvc29mdCwgTWljcm9zb2Z0IEJhc2ljIFJlbmRlciBEcml2ZXIgKDB4MDAwMDAwOEMpIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEpR29vZ2xlIEluYy4gKE1pY3Jvc29mdA',
    });
    url += `?${dmParams.toString()}`;
  }

  const body = new URLSearchParams({
    plat: '1',
    oid: String(oid),
    type: '1',
    message,
    at_name_to_mid: '{}',
    gaia_source: 'main_web',
    csrf: csrf || account?.csrf || '',
    statistics: JSON.stringify({ appId: 100, platform: 5 }),
    ...(root ? { root: String(root), parent: String(parent) } : {}),
  }).toString();

  return await biliFetch({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    account,
    bv,
  });
}

/** 评论操作（点赞/点踩） */
export async function replyAction({ oid, rpid, action = 1, account, csrf }) {
  const body = new URLSearchParams({
    oid: String(oid),
    type: '1',
    rpid: String(rpid),
    action: String(action),
    csrf: csrf || account?.csrf || '',
    statistics: JSON.stringify({ appId: 100, platform: 5 }),
  }).toString();

  return await biliFetch({
    url: 'https://api.bilibili.com/x/v2/reply/action',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    account,
  });
}

/** 获取视频信息（BV转aid/oid） */
// 通用API调试转发（供前端API调试台真实请求B站任意接口）
export async function debugProxy({ path, method = 'GET', params = {}, account, body }) {
  // path 应为 B站API 相对路径，如 /x/v2/reply/wbi/main
  let url = 'https://api.bilibili.com' + path;
  const isPost = method.toUpperCase() === 'POST';
  let reqBody = null;
  if (isPost) {
    // POST: 参数作为表单体（B站接口惯例）
    reqBody = new URLSearchParams({ ...params, csrf: account?.csrf || '' }).toString();
  } else {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  return await biliFetch({
    url,
    method,
    headers: isPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
    body: reqBody,
    account,
  });
}
// 验证账号登录态（调B站nav接口）
export async function checkLogin(account) {
  const result = await biliFetch({
    url: 'https://api.bilibili.com/x/web-interface/nav',
    method: 'GET',
    account,
  });
  return result;
}
export async function getVideoInfo(bv) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bv}`;
  return await biliFetch({ url, method: 'GET', bv });
}

/** 获取UP主视频列表 */
export async function getUpperVideos(mid, page = 1, ps = 30, order = 'pubdate') {
  const params = new URLSearchParams({
    mid: String(mid),
    ps: String(ps),
    pn: String(page),
    order,
    platform: 'web',
    web_location: '1550101',
    order_avoided: 'true',
  });
  const url = `https://api.bilibili.com/x/space/wbi/arc/search?${params.toString()}`;
  return await biliFetch({ url, method: 'GET', useWbi: true });
}

// ============================================================
// 工具函数
// ============================================================

/** 生成模拟鼠标轨迹（dm_img_list） */
function generateDmImgTrack(count = 15) {
  const track = [];
  let x = Math.floor(Math.random() * 500 + 1000);
  let y = Math.floor(Math.random() * 500 - 2000);
  let timestamp = Math.floor(Math.random() * 5000 + 5000);
  for (let i = 0; i < count; i++) {
    x += Math.floor(Math.random() * 200 - 50);
    y += Math.floor(Math.random() * 200 - 50);
    timestamp += Math.floor(Math.random() * 500 + 100);
    track.push({
      x, y,
      z: Math.floor(Math.random() * 1000),
      timestamp,
      k: Math.floor(Math.random() * 150 + 50),
      type: i === 0 ? 1 : 0,
    });
  }
  return track;
}

// ============================================================
// 配置管理
// ============================================================
export function setGlobalProxy(enabled) {
  config.globalProxyEnabled = enabled;
  console.log(`[BiliAPI] 全局代理开关: ${enabled ? '开启' : '关闭'}`);
}

export function getGlobalProxy() {
  return config.globalProxyEnabled;
}

export { getProxyPoolStats, refreshProxyPool, startProxyPool, stopProxyPool } from './proxy-pool.js';
