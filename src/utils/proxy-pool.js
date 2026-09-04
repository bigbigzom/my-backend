/**
 * 多地区IP代理池模块（v5.0 全球地区版）
 *
 * 支持8个地区：美国(US)、加拿大(CA)、德国(DE)、法国(FR)、英国(GB)、日本(JP)、香港(HK)、中国(CN)
 * - 验证目标：B站(api.bilibili.com) + 出口IP国家识别
 * - 50秒定时增量刷新，防止Render休眠
 * - 可用IP缓存30分钟，连续失败3次自动剔除
 * - 按地区筛选分配，账号绑定地区后IP失效同地区重分配
 *
 * 依赖：undici（ProxyAgent 支持 HTTPS over HTTP proxy）
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { CN_PROXY_SOURCES } from './proxy-sources.js'; // v1.5.3：共享代理源配置（20+ 中国IP源，与本地登录服务一致）

// ============================================================
// 配置
// ============================================================
const VALIDATE_CONCURRENCY = 50;       // 验证并发数（v5.4提升）
const PROXY_TIMEOUT_MS = 8000;          // 单个代理验证超时
const REFRESH_INTERVAL_MS = 50 * 1000;  // 刷新间隔50秒（防止Render休眠）
const MIN_READY_POOL_SIZE = 5;           // 可用池最低水位
const MAX_PROXIES_PER_SOURCE = 300;      // 每个源最多保留多少代理（v5.4提升）
const MAX_TOTAL_TO_VALIDATE = 2000;      // 每次刷新最多验证多少个（v5.4提升，多地区需要更多IP）
const PROXY_EXPIRE_MS = 30 * 60 * 1000;  // IP新鲜度阈值（超过则惰性重验证，不立即移除）

// 支持的地区（只有IP数量多的国家才计入）
export const SUPPORTED_REGIONS = {
  US: { name: '美国', code: 'US', languages: ['en-US', 'en'], timezone: 'America/New_York' },
  CA: { name: '加拿大', code: 'CA', languages: ['en-CA', 'en', 'fr-CA'], timezone: 'America/Toronto' },
  DE: { name: '德国', code: 'DE', languages: ['de-DE', 'de', 'en'], timezone: 'Europe/Berlin' },
  FR: { name: '法国', code: 'FR', languages: ['fr-FR', 'fr', 'en'], timezone: 'Europe/Paris' },
  GB: { name: '英国', code: 'GB', languages: ['en-GB', 'en'], timezone: 'Europe/London' },
  JP: { name: '日本', code: 'JP', languages: ['ja-JP', 'ja', 'en'], timezone: 'Asia/Tokyo' },
  HK: { name: '香港', code: 'HK', languages: ['zh-HK', 'zh-TW', 'zh', 'en'], timezone: 'Asia/Hong_Kong' },
  CN: { name: '中国', code: 'CN', languages: ['zh-CN', 'zh', 'en'], timezone: 'Asia/Shanghai' },
  RU: { name: '俄罗斯', code: 'RU', languages: ['ru-RU', 'ru', 'en'], timezone: 'Europe/Moscow' },
};
const SUPPORTED_COUNTRY_CODES = new Set(Object.keys(SUPPORTED_REGIONS));
// 国家代码到地区的映射（处理特殊情况）
function countryCodeToRegion(cc) {
  if (!cc) return null;
  const upper = String(cc).toUpperCase();
  if (SUPPORTED_COUNTRY_CODES.has(upper)) return upper;
  // 英国可能返回 UK
  if (upper === 'UK') return 'GB';
  return null;
}

// B站验证目标（适配：验证代理能否正常访问B站API）
const BILI_VALIDATE_URL = 'https://api.bilibili.com/x/web-interface/nav';
const BILI_REFERER = 'https://www.bilibili.com/';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

// ============================================================
// 状态
// ============================================================
let readyPool = [];        // 已验证可用的代理池 [{proxy, speed, ip, lastChecked, failCount, city, timezone, inUseBy}]
let validateQueue = [];    // 待验证队列
let isValidating = false;
let isRefreshing = false;
let lastRefreshAt = 0;
let refreshTimer = null;
let totalValidatedThisRound = 0;
// IP 占用表（防止多账号同一时刻共用同一IP = 团伙信号）
// proxyAddr -> accountKey
const proxyOccupancy = new Map();

// ============================================================
// 工具函数
// ============================================================
function extractProxies(text) {
  const proxies = new Set();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const matches = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})/g);
    if (matches) matches.forEach((m) => proxies.add(m));
  }
  return [...proxies];
}

// ============================================================
// 抓取阶段
// ============================================================
async function fetchSourcePage(src, page) {
  const url = src.getUrl(page);
  // 第一轮：直连
  try {
    const found = await _fetchAndParse(url, src, null);
    if (found.length > 0) {
      console.log(`[ProxyPool] ${src.name} 直连抓取到 ${found.length} 个代理`);
      return found;
    }
  } catch (err) {
    console.warn(`[ProxyPool] ${src.name} 直连失败: ${err.message}，尝试代理链式访问...`);
  }
  // 第二轮：用已有代理IP链式访问（优先CN→US→RU→其他）
  const regionOrder = ['CN', 'US', 'RU', 'GB', 'DE', 'FR', 'JP', 'HK', 'CA'];
  for (const region of regionOrder) {
    const proxy = getProxy(region);
    if (!proxy) continue;
    try {
      const found = await _fetchAndParse(url, src, proxy.proxy);
      if (found.length > 0) {
        console.log(`[ProxyPool] ${src.name} 经${region}代理 ${proxy.proxy} 抓取到 ${found.length} 个代理`);
        return found;
      }
    } catch (err) {
      console.warn(`[ProxyPool] ${src.name} 经${region}代理失败: ${err.message}`);
    }
  }
  console.warn(`[ProxyPool] ${src.name} 所有方式均失败，跳过`);
  return [];
}

/** 内部：抓取并解析代理源页面，支持可选代理 */
async function _fetchAndParse(url, src, proxyAddr) {
  const opts = { headers: DEFAULT_HEADERS, signal: AbortSignal.timeout(15000) };
  if (proxyAddr) {
    const p = proxyAddr.includes('://') ? proxyAddr : 'http://' + proxyAddr;
    opts.dispatcher = new ProxyAgent(p);
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let found = [];
  if (src.isJson) {
    const json = await res.json();
    if (json.data && Array.isArray(json.data)) {
      found = json.data.map((item) => `${item.ip}:${item.port}`).filter(Boolean);
    }
  } else {
    const text = await res.text();
    found = extractProxies(text);
  }
  return found.slice(0, MAX_PROXIES_PER_SOURCE);
}

async function fetchAllSources() {
  const allProxies = new Set();
  const tasks = [];
  for (const src of CN_PROXY_SOURCES) {
    for (let page = 1; page <= src.pages; page++) {
      tasks.push(fetchSourcePage(src, page));
    }
  }
  const results = await Promise.all(tasks);
  for (const proxies of results) {
    for (const p of proxies) allProxies.add(p);
  }
  const readySet = new Set(readyPool.map((p) => p.proxy));
  const fresh = [...allProxies].filter((p) => !readySet.has(p));
  console.log(`[ProxyPool] 抓取完成：共 ${allProxies.size} 个，去重后新增 ${fresh.length} 个待验证`);
  return fresh;
}

// ============================================================
// 验证阶段（适配B站）
// ============================================================
/**
 * 验证单个代理：①出口IP在中国 ②能访问B站API
 * 适配改造：验证目标从 azz.ee 改为 B站 nav 接口
 */
async function validateProxy(proxyAddr) {
  const startTime = Date.now();
  let proxyAgent = null;
  try {
    proxyAgent = new ProxyAgent(`http://${proxyAddr}`);

    // 第一步：检查出口IP国家 + 城市/时区（用于指纹地理一致性）
    const ipRes = await undiciFetch('http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,timezone,query', {
      dispatcher: proxyAgent,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    if (!ipRes.ok) return null;
    const ipData = await ipRes.json();
    if (ipData.status !== 'success') return null;
    const region = countryCodeToRegion(ipData.countryCode);
    if (!region) return null; // 只保留支持的8个地区

    // 第二步：确认能访问B站API（适配改造）
    const biliRes = await undiciFetch(BILI_VALIDATE_URL, {
      dispatcher: proxyAgent,
      headers: {
        ...DEFAULT_HEADERS,
        'Referer': BILI_REFERER,
        'Origin': 'https://www.bilibili.com',
      },
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    if (!biliRes.ok) return null;
    // B站nav接口返回code=0表示正常（未登录也返回code=-101但HTTP 200）
    const biliData = await biliRes.json();
    if (biliData.code !== 0 && biliData.code !== -101) return null;

    const elapsed = Date.now() - startTime;
    return {
      proxy: proxyAddr,
      speed: elapsed,
      ip: ipData.query,
      city: ipData.city || ipData.regionName || '',
      country: ipData.country || '',
      countryCode: ipData.countryCode || '',
      region,
      timezone: ipData.timezone || SUPPORTED_REGIONS[region]?.timezone || '',
      lastChecked: Date.now(),
      failCount: 0,
      inUseBy: null,
    };
  } catch {
    return null;
  }
}

async function validationLoop() {
  if (isValidating) return;
  isValidating = true;
  const maxWorkers = VALIDATE_CONCURRENCY;
  async function worker() {
    while (validateQueue.length > 0 && totalValidatedThisRound < MAX_TOTAL_TO_VALIDATE) {
      const proxy = validateQueue.shift();
      if (!proxy) break;
      totalValidatedThisRound++;
      const result = await validateProxy(proxy);
      if (result) {
        const existing = readyPool.find((p) => p.proxy === result.proxy);
        if (existing) {
          // v5.2 增量刷新：更新验证时间和速度，但保留原地区/城市信息（不覆盖）
          existing.speed = result.speed;
          existing.lastChecked = Date.now();
          existing.failCount = 0;
          // 只在地区缺失时补充
          if (!existing.region && result.region) existing.region = result.region;
          if (!existing.city && result.city) existing.city = result.city;
          if (!existing.timezone && result.timezone) existing.timezone = result.timezone;
        } else {
          readyPool.push(result);
          readyPool.sort((a, b) => a.speed - b.speed);
        }
        console.log(`[ProxyPool] ✅ 新可用代理: ${result.proxy} (${result.speed}ms)，可用池: ${readyPool.length}`);
      }
    }
  }
  const workers = [];
  for (let i = 0; i < maxWorkers; i++) workers.push(worker());
  await Promise.all(workers);
  isValidating = false;
  console.log(`[ProxyPool] 本轮验证完成，验证 ${totalValidatedThisRound} 个，可用 ${readyPool.length} 个`);
}

// ============================================================
// 刷新（增量）
// ============================================================
function cleanupExpired() {
  // v5.2 增量刷新：不主动清理过期IP，改为惰性验证（使用时才检测有效性）
  // 只清理连续失败>=3次的IP（在markProxyFailed中处理）
  const now = Date.now();
  const before = readyPool.length;
  // 超过2倍过期时间且从未被使用过的才清理（防止内存无限增长）
  readyPool = readyPool.filter((p) => now - p.lastChecked < PROXY_EXPIRE_MS * 2 || p.inUseBy);
  if (readyPool.length < before) {
    console.log(`[ProxyPool] 清理超长期未验证IP: ${before} -> ${readyPool.length}`);
  }
}

export async function refreshProxyPool() {
  if (isRefreshing) {
    console.log('[ProxyPool] 已有刷新任务在进行，跳过');
    return;
  }
  isRefreshing = true;
  totalValidatedThisRound = 0;
  const startTime = Date.now();
  console.log('[ProxyPool] ========== 开始增量刷新 ==========');
  try {
    cleanupExpired();
    const freshProxies = await fetchAllSources();
    validateQueue = freshProxies.slice(0, MAX_TOTAL_TO_VALIDATE);
    await validationLoop();
    lastRefreshAt = Date.now();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ProxyPool] 刷新完成：可用 ${readyPool.length} 个，耗时 ${elapsed}s`);
    if (readyPool.length > 0) {
      console.log(`[ProxyPool] 最快代理: ${readyPool[0].proxy} (${readyPool[0].speed}ms)`);
    }
  } catch (err) {
    console.error('[ProxyPool] 刷新失败:', err.message);
  } finally {
    isRefreshing = false;
  }
}

// ============================================================
// 对外接口
// ============================================================
/** 获取一个可用代理（优先选速度快的，从前30%最快中随机选）
 * v5.2 惰性验证：过期IP不立即移除，使用时标记待重新验证
 * @param {string} [region] - 可选地区过滤
 */
export function getProxy(region = null) {
  let pool = readyPool;
  if (region) pool = readyPool.filter(p => p.region === region);
  if (pool.length === 0) return null;
  // 优先选未过期的，过期的放后面
  const now = Date.now();
  const fresh = pool.filter(p => now - p.lastChecked < PROXY_EXPIRE_MS);
  const stale = pool.filter(p => now - p.lastChecked >= PROXY_EXPIRE_MS);
  const selectFrom = fresh.length > 0 ? fresh : stale;
  const topCount = Math.max(1, Math.floor(selectFrom.length * 0.3));
  const idx = Math.floor(Math.random() * topCount);
  const p = selectFrom[idx];
  // 惰性验证：如果过期了，加入待验证队列
  if (stale.includes(p) && !validateQueue.includes(p.proxy)) {
    validateQueue.push(p.proxy);
    if (!isValidating) validationLoop();
  }
  return p;
}

/**
 * 查询指定代理是否仍在可用池（只读，不产生占用）——用于账号注册IP粘性检查
 * @param {String} proxyAddr - "host:port"
 * @returns {Object|null} 代理对象（含 city/ip/speed）
 */
export function isProxyReady(proxyAddr) {
  if (!proxyAddr) return null;
  return readyPool.find(x => x.proxy === proxyAddr) || null;
}
// ============================================================
// v2.2 新增：IP占用 + 主用IP绑定（独立运营策略）
// ============================================================
/**
 * 占用代理（防止多账号同时复用同一IP = 团伙信号）
 * @param {String} accountKey 账号标识
 * @param {String|null} preferredProxy 账号主用IP（优先返回）
 * @param {Object} opts { excludeProxies: [], excludeIps: [] } 排除指定代理/IP（独立运营：评论者IP与发布者IP分离）
 * @returns {Object|null} 代理对象（已标记占用）
 */
export function acquireProxy(accountKey, preferredProxy = null, opts = {}) {
  if (!accountKey) accountKey = 'unknown';
  const excludeProxies = new Set(opts.excludeProxies || []);
  const excludeIps = new Set(opts.excludeIps || []);
  const region = opts.region || null;
  const isExcluded = (p) => excludeProxies.has(p.proxy) || excludeIps.has(p.ip) || (region && p.region !== region);

  // 1. 优先返回账号主用IP（独立运营：账号绑定固定常用IP，模拟真实用户固定所在地）
  if (preferredProxy && !isExcluded({ proxy: preferredProxy })) {
    const p = readyPool.find(x => x.proxy === preferredProxy && !x.inUseBy);
    if (p) {
      p.inUseBy = accountKey;
      proxyOccupancy.set(p.proxy, accountKey);
      return p;
    }
    console.log(`[ProxyPool] 账号 ${accountKey} 主用IP ${preferredProxy} 不可用，回退随机IP`);
  }
  // 2. 随机选一个未被占用且不在排除列表的代理（从最快的前40%中选）
  const free = readyPool.filter(x => !x.inUseBy && !isExcluded(x));
  if (free.length === 0) {
    // 排除列表导致无可用 → 降级：不排除但仍避免占用
    const fallback = readyPool.filter(x => !x.inUseBy);
    if (fallback.length === 0) return null;
    const topCount = Math.max(1, Math.floor(fallback.length * 0.4));
    const p = fallback[Math.floor(Math.random() * topCount)];
    p.inUseBy = accountKey;
    proxyOccupancy.set(p.proxy, accountKey);
    console.log(`[ProxyPool] ⚠️ 账号 ${accountKey} 排除列表后无可用IP，降级使用 ${p.proxy}`);
    return p;
  }
  const topCount = Math.max(1, Math.floor(free.length * 0.4));
  const idx = Math.floor(Math.random() * topCount);
  const p = free[idx];
  p.inUseBy = accountKey;
  proxyOccupancy.set(p.proxy, accountKey);
  return p;
}
/**
 * 释放代理占用
 */
export function releaseProxy(proxyAddr) {
  if (!proxyAddr) return;
  const p = readyPool.find(x => x.proxy === proxyAddr);
  if (p) p.inUseBy = null;
  proxyOccupancy.delete(proxyAddr);
}
function accountKeyOf(account) {
  return account.username || account.phone || account.account || String(account.id || '');
}
/**
 * 获取账号可用代理（配合账号主用IP绑定 + IP池分离）
 * @param {Object} account 账号对象（含 primaryProxy, ipRole）
 * @param {Object} opts { excludePublisherIps: [] } 排除发布者IP（独立运营：评论者IP与发布者IP分离）
 */
export function getProxyForAccount(account, opts = {}) {
  if (!account) return getProxy();
  const excludeProxies = [];
  const excludeIps = [];
  // v5.0 地区绑定：账号注册时的地区决定IP地区
  const region = account.region || opts.region || null;
  // v2.3 独立运营：评论者账号排除发布者账号的主用IP
  if (opts.excludePublisherIps) {
    for (const ip of opts.excludePublisherIps) {
      if (ip.includes(':')) excludeProxies.push(ip);
      else excludeIps.push(ip);
    }
  }
  const proxy = acquireProxy(accountKeyOf(account), account.primaryProxy, { excludeProxies, excludeIps, region });
  // v5.0：如果该地区无可用IP，返回null（账号保持静默，不跨地区分配）
  return proxy;
}
/**
 * 标记代理被B站账号受限（立即剔除）
 */
export function markProxyBlocked(proxyAddr) {
  const before = readyPool.length;
  readyPool = readyPool.filter(x => x.proxy !== proxyAddr);
  proxyOccupancy.delete(proxyAddr);
  if (readyPool.length < before) {
    console.log(`[ProxyPool] 🚫 代理 ${proxyAddr} 被B站账号受限，已剔除（剩余 ${readyPool.length}）`);
  }
}
/**
 * 获取占用统计（前端展示）
 */
export function getOccupancyStats() {
  return {
    occupiedCount: proxyOccupancy.size,
    occupied: [...proxyOccupancy.entries()].map(([proxy, acct]) => ({ proxy, account: acct })),
  };
}

/** 等待可用代理（最多等待 timeoutMs）
 * @param {number} timeoutMs
 * @param {string} [region] - 可选地区过滤
 */
export async function waitForProxy(timeoutMs = 15000, region = null) {
  if (getProxy(region)) return getProxy(region);
  console.log(`[ProxyPool] ${region ? region+'地区' : ''}可用池为空，等待验证...`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = getProxy(region);
    if (p) return p;
    if (!isValidating && validateQueue.length > 0) validationLoop();
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** 标记代理失败（连续失败3次则剔除） */
export function markProxyFailed(proxyAddr) {
  const p = readyPool.find((x) => x.proxy === proxyAddr);
  if (!p) return;
  p.failCount = (p.failCount || 0) + 1;
  if (p.failCount >= 3) {
    readyPool = readyPool.filter((x) => x.proxy !== proxyAddr);
    console.log(`[ProxyPool] 代理 ${proxyAddr} 连续失败3次，已剔除（剩余 ${readyPool.length}）`);
  }
}

/**
 * 获取所有可用IP列表（v5.0：多地区，供本地登录服务远程拉取）
 * 返回精简字段，最小化传输量
 * @param {number} limit - 最多返回多少个（默认全部，按速度排序）
 * @param {string} [region] - 可选地区过滤
 */
export function getAvailableProxies(limit = 0, region = null) {
  let pool = readyPool.filter(p => !p.inUseBy);
  if (region) pool = pool.filter(p => p.region === region);
  const list = pool
    .sort((a, b) => a.speed - b.speed)
    .map(p => ({
      proxy: p.proxy,
      ip: p.ip,
      city: p.city || '',
      country: p.country || '',
      countryCode: p.countryCode || '',
      region: p.region || '',
      speed: p.speed,
      timezone: p.timezone || '',
      lastChecked: p.lastChecked,
    }));
  return limit > 0 ? list.slice(0, limit) : list;
}

/** 获取代理池统计信息（含按地区统计） */
export function getProxyPoolStats() {
  const byRegion = {};
  for (const p of readyPool) {
    const r = p.region || 'OTHER';
    if (!byRegion[r]) byRegion[r] = 0;
    byRegion[r]++;
  }
  return {
    readyCount: readyPool.length,
    queueCount: validateQueue.length,
    isValidating,
    isRefreshing,
    lastRefreshAt: new Date(lastRefreshAt).toISOString(),
    avgSpeed:
      readyPool.length > 0
        ? Math.round(readyPool.reduce((a, b) => a + b.speed, 0) / readyPool.length)
        : 0,
    fastest: readyPool[0]
      ? { proxy: readyPool[0].proxy, speed: readyPool[0].speed, ip: readyPool[0].ip, region: readyPool[0].region }
      : null,
    top5: readyPool.slice(0, 5).map((p) => ({
      proxy: p.proxy, speed: p.speed, ip: p.ip, region: p.region,
    })),
    byRegion,
    supportedRegions: Object.keys(SUPPORTED_REGIONS),
  };
}

/** 启动定时刷新（默认50秒，防止Render休眠） */
export function startProxyPool(intervalMs = REFRESH_INTERVAL_MS) {
  refreshProxyPool();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshProxyPool, intervalMs);
  console.log(`[ProxyPool] 定时刷新已启动，间隔 ${intervalMs / 1000} 秒`);
}

/** 停止定时刷新 */
export function stopProxyPool() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    console.log('[ProxyPool] 定时刷新已停止');
  }
}
