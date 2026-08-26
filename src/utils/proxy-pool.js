/**
 * 中国IP代理池模块（适配B站评论靶场）
 *
 * 基于 fansky-shop 项目的代理池改造：
 * - 验证目标从爱赞助(azz.ee)改为B站(api.bilibili.com)
 * - 50秒定时增量刷新，防止Render休眠
 * - 动态验证：出口IP在中国 + 能访问B站API
 * - 可用IP缓存30分钟，连续失败3次自动剔除
 *
 * 依赖：undici（ProxyAgent 支持 HTTPS over HTTP proxy）
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';

// ============================================================
// 代理源配置（Render 海外环境下可靠的中国IP源）
// ============================================================
const CN_PROXY_SOURCES = [
  // ===== GitHub raw 源（Render 上最可靠，量大）=====
  {
    name: 'MuRongPIG/Proxy-Master',
    getUrl: () => 'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
    pages: 1,
  },
  {
    name: 'officialputuid/KangProxy',
    getUrl: () => 'https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/http/http.txt',
    pages: 1,
  },
  {
    name: 'monosans/proxy-list',
    getUrl: () => 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    pages: 1,
  },
  {
    name: 'TheSpeedX/PROXY-List',
    getUrl: () => 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    pages: 1,
  },
  {
    name: 'ShiftyTR/Proxy-List',
    getUrl: () => 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
    pages: 1,
  },
  {
    name: 'prxchk/proxy-list',
    getUrl: () => 'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
    pages: 1,
  },
  {
    name: 'vakhov/fresh-proxy-list',
    getUrl: () => 'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt',
    pages: 1,
  },
  // ===== API 源（可按 country=CN 筛选）=====
  {
    name: 'proxyscrape(CN)',
    getUrl: () => 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=CN&ssl=all&anonymity=all',
    pages: 1,
  },
  {
    name: 'geonode(CN)',
    getUrl: () => 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&country=CN&protocols=http',
    pages: 1,
    isJson: true,
  },
  // ===== 中文纯文本源（备选）=====
  {
    name: '66免费代理',
    getUrl: () => 'http://www.66ip.cn/mo.php?tqsl=100',
    pages: 1,
  },
];

// ============================================================
// 配置
// ============================================================
const VALIDATE_CONCURRENCY = 30;       // 验证并发数
const PROXY_TIMEOUT_MS = 8000;          // 单个代理验证超时
const REFRESH_INTERVAL_MS = 50 * 1000;  // 刷新间隔50秒（防止Render休眠）
const MIN_READY_POOL_SIZE = 5;           // 可用池最低水位
const MAX_PROXIES_PER_SOURCE = 200;      // 每个源最多保留多少代理
const MAX_TOTAL_TO_VALIDATE = 1000;      // 每次刷新最多验证多少个
const PROXY_EXPIRE_MS = 30 * 60 * 1000;  // 可用IP过期时间30分钟

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
let readyPool = [];        // 已验证可用的代理池 [{proxy, speed, ip, lastChecked, failCount}]
let validateQueue = [];    // 待验证队列
let isValidating = false;
let isRefreshing = false;
let lastRefreshAt = 0;
let refreshTimer = null;
let totalValidatedThisRound = 0;

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
  try {
    const url = src.getUrl(page);
    const res = await fetch(url, {
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`[ProxyPool] ${src.name} 返回 ${res.status}`);
      return [];
    }
    let found = [];
    if (src.isJson) {
      try {
        const json = await res.json();
        if (json.data && Array.isArray(json.data)) {
          found = json.data.map((item) => `${item.ip}:${item.port}`).filter(Boolean);
        }
      } catch (e) {
        console.warn(`[ProxyPool] ${src.name} JSON 解析失败: ${e.message}`);
      }
    } else {
      const text = await res.text();
      found = extractProxies(text);
    }
    found = found.slice(0, MAX_PROXIES_PER_SOURCE);
    console.log(`[ProxyPool] ${src.name} 抓取到 ${found.length} 个代理`);
    return found;
  } catch (err) {
    console.warn(`[ProxyPool] ${src.name} 抓取失败: ${err.message}`);
    return [];
  }
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

    // 第一步：检查出口IP国家
    const ipRes = await undiciFetch('http://ip-api.com/json/?fields=status,country,countryCode,query', {
      dispatcher: proxyAgent,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    if (!ipRes.ok) return null;
    const ipData = await ipRes.json();
    if (ipData.status !== 'success') return null;
    const isChina = ipData.countryCode === 'CN' || ipData.country === 'China';
    if (!isChina) return null;

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
      lastChecked: Date.now(),
      failCount: 0,
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
          existing.speed = result.speed;
          existing.lastChecked = Date.now();
          existing.failCount = 0;
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
  const now = Date.now();
  const before = readyPool.length;
  readyPool = readyPool.filter((p) => now - p.lastChecked < PROXY_EXPIRE_MS);
  if (readyPool.length < before) {
    console.log(`[ProxyPool] 清理过期代理: ${before} -> ${readyPool.length}`);
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
/** 获取一个可用代理（优先选速度快的，从前30%最快中随机选） */
export function getProxy() {
  if (readyPool.length === 0) return null;
  const topCount = Math.max(1, Math.floor(readyPool.length * 0.3));
  const idx = Math.floor(Math.random() * topCount);
  return readyPool[idx];
}

/** 等待可用代理（最多等待 timeoutMs） */
export async function waitForProxy(timeoutMs = 15000) {
  if (readyPool.length > 0) return getProxy();
  console.log('[ProxyPool] 可用池为空，等待验证...');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (readyPool.length > 0) return getProxy();
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

/** 获取代理池统计信息 */
export function getProxyPoolStats() {
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
      ? { proxy: readyPool[0].proxy, speed: readyPool[0].speed, ip: readyPool[0].ip }
      : null,
    top5: readyPool.slice(0, 5).map((p) => ({
      proxy: p.proxy,
      speed: p.speed,
      ip: p.ip,
    })),
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
