/**
 * CookieUseScheduler - Cookie 延迟使用调度器（v3.1 新增）
 *
 * 核心命题（见 docs/COOKIE-DELAY-BREAKTHROUGH.md）：
 * B站平台安全机制判据之一是「Cookie 的生成、激活、使用节奏是否符合真实用户时间分布」。
 * 本模块把「什么时候使用 Cookie、用什么强度使用」从"立即可用"改为"按时间爬坡"，实现：
 *
 * 1. 冷启动冷静期：新导入/新刷新的 Cookie 先进入只读温号期，按等级爬坡开放互动
 * 2. 温号等级：level0 只读 → level1 低风险写(点赞) → level2 高风险写(评论/投币/关注)
 * 3. 使用窗口错峰：每账号独立随机活跃窗口，避免多账号同时使用（集群信号）
 * 4. 错峰刷新：每账号独立随机化刷新时刻，替代"全体凌晨3点齐刷"（强关联信号）
 *
 * 设计：纯函数 + 账号字段驱动，不持有全局状态，便于测试与集成。
 */

// 温号等级
export const WARM_UP_LEVEL = {
  READ_ONLY: 0,   // 只读：浏览/观看/搜索
  LOW_RISK: 1,    // 低风险写：点赞
  FULL: 2,        // 高风险写：评论/投币/收藏/关注
};

// 默认温号时长（小时）：导入后经历 3 段爬坡
const DEFAULT_WARM_UP_HOURS = 72; // 共72小时
// 爬坡阈值：进度达到 untilRatio 时升级到对应等级
// 只读期 [0, 0.3) → 低风险期 [0.3, 0.6) → 全开放期 [0.6, 1.0]
const DEFAULT_RAMP_SEGMENTS = [
  { level: WARM_UP_LEVEL.LOW_RISK, untilRatio: 0.3 },  // 21.6h 后可点赞
  { level: WARM_UP_LEVEL.FULL, untilRatio: 0.6 },      // 43.2h 后全部开放
];

/**
 * 计算账号当前温号等级
 * @param {Object} account - Account 实例
 * @param {number} nowMs - 当前时间戳（可注入便于测试）
 * @returns {{ level: number, elapsedHours: number, totalHours: number, progress: number }}
 */
export function computeWarmUpLevel(account, nowMs = Date.now()) {
  const totalHours = (account.warmUpDurationHours || DEFAULT_WARM_UP_HOURS);
  const startedAt = account.warmUpStartedAt
    ? new Date(account.warmUpStartedAt).getTime()
    : (account.createdAt ? new Date(account.createdAt).getTime() : nowMs);
  const elapsedHours = (nowMs - startedAt) / (60 * 60 * 1000);

  // 手动关闭温号期（warmUpDisabled=true）或老账号无温号字段 → 直接全开放
  if (account.warmUpDisabled || (!account.warmUpStartedAt && !account.createdAt)) {
    return { level: WARM_UP_LEVEL.FULL, elapsedHours, totalHours, progress: 1 };
  }

  const progress = Math.min(1, Math.max(0, elapsedHours / totalHours));
  let level = WARM_UP_LEVEL.READ_ONLY;
  for (const seg of DEFAULT_RAMP_SEGMENTS) {
    if (progress >= seg.untilRatio) level = seg.level;
    else break;
  }
  return { level, elapsedHours, totalHours, progress };
}

/**
 * 判断账号当前是否允许某类操作
 * @param {Object} account
 * @param {string} opType - read / like / comment / coin / fav / follow
 * @param {Object} info - computeWarmUpLevel 的返回值（可复用，避免重复计算）
 * @returns {{ allowed: boolean, reason?: string, level?: number }}
 */
export function assertOperationAllowed(account, opType, info = null) {
  const wu = info || computeWarmUpLevel(account);
  // 映射操作所需的最低温号等级
  const required = {
    read: WARM_UP_LEVEL.READ_ONLY,
    like: WARM_UP_LEVEL.LOW_RISK,
    coin: WARM_UP_LEVEL.FULL,
    fav: WARM_UP_LEVEL.FULL,
    comment: WARM_UP_LEVEL.FULL,
    follow: WARM_UP_LEVEL.FULL,
    danmaku: WARM_UP_LEVEL.LOW_RISK,
    search: WARM_UP_LEVEL.READ_ONLY,
  }[opType] ?? WARM_UP_LEVEL.FULL;

  if (wu.level < required) {
    const hoursLeft = Math.max(0, wu.totalHours - wu.elapsedHours);
    return {
      allowed: false,
      reason: `账号处于温号期(${levelName(wu.level)})，${opType}操作需等待约${hoursLeft.toFixed(1)}小时后开放`,
      level: wu.level,
      required,
    };
  }
  return { allowed: true, level: wu.level, required };
}

/**
 * 温号等级名称
 */
export function levelName(level) {
  return {
    [WARM_UP_LEVEL.READ_ONLY]: '只读期',
    [WARM_UP_LEVEL.LOW_RISK]: '低风险期',
    [WARM_UP_LEVEL.FULL]: '全开放期',
  }[level] || '未知';
}

// ============================================================
// 使用窗口错峰
// ============================================================

/**
 * 为账号生成（或读取已有）独立随机活跃窗口 [startHour, endHour]（本地时区小时）
 * - 同一账号窗口稳定（字段持久化）
 * - 不同账号窗口随机错开
 */
export function ensureActiveWindow(account) {
  if (account.activeWindowStart != null && account.activeWindowEnd != null) {
    return { start: account.activeWindowStart, end: account.activeWindowEnd };
  }
  // 在 6 个候选时段中随机选一个（白天/晚上分布，避免全部集中）
  const WINDOWS = [
    { start: 7, end: 10 },   // 早
    { start: 10, end: 13 },  // 上午
    { start: 13, end: 16 },  // 午
    { start: 16, end: 19 },  // 午后
    { start: 19, end: 22 },  // 晚
    { start: 21, end: 24 },  // 深夜前
  ];
  const w = WINDOWS[Math.floor(Math.random() * WINDOWS.length)];
  account.activeWindowStart = w.start;
  account.activeWindowEnd = w.end;
  return { start: w.start, end: w.end };
}

/**
 * 判断当前是否处于账号活跃窗口
 * @returns {{ active: boolean, nextActiveInMs: number }}
 */
export function isInActiveWindow(account, now = new Date()) {
  const w = ensureActiveWindow(account);
  const hour = now.getHours() + now.getMinutes() / 60;
  let active = false;
  if (w.start <= w.end) {
    active = hour >= w.start && hour < w.end;
  } else {
    // 跨午夜窗口（如 23-1）
    active = hour >= w.start || hour < w.end;
  }
  // 计算距离下一个窗口的毫秒数
  let nextActiveInMs = 0;
  if (!active) {
    const msNow = now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
    const msStart = w.start * 3600000;
    let diff = msStart - msNow;
    if (diff <= 0) diff += 24 * 3600000;
    nextActiveInMs = diff;
  }
  return { active, nextActiveInMs, window: w };
}

/**
 * 窗口内任务时刻加 jitter（±30min），避免账号间同步发请求
 */
export function jitterWithinWindow(account, baseDelayMs = 0) {
  const jitter = Math.floor(Math.random() * 60 * 60000) - 30 * 60000; // ±30min
  return Math.max(0, baseDelayMs + jitter);
}

// ============================================================
// 错峰刷新
// ============================================================

/**
 * 为账号生成（或读取已有）随机化下次刷新时刻
 * - 在账号活跃窗口内随机取一个时刻
 * - 距离上次刷新至少 12 小时（REFRESH_COOLDOWN 之上再加随机余量）
 */
export function ensureNextRefreshTime(account) {
  if (account.nextRefreshAt && new Date(account.nextRefreshAt).getTime() > Date.now()) {
    return account.nextRefreshAt;
  }
  const w = ensureActiveWindow(account);
  const now = new Date();
  // 在窗口内随机分钟
  const minutes = Math.floor(Math.random() * (w.end - w.start) * 60);
  const target = new Date(now);
  target.setHours(w.start, minutes, 0, 0);
  if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
  // 若距上次刷新不足最小间隔，顺延
  const minGap = 12 * 3600000;
  if (account.lastRefresh) {
    const since = Date.now() - new Date(account.lastRefresh).getTime();
    if (since < minGap) target.setTime(Date.now() + minGap - since + Math.floor(Math.random() * 3600000));
  }
  account.nextRefreshAt = target.toISOString();
  return account.nextRefreshAt;
}

/**
 * 判断账号是否到了错峰刷新时刻
 */
export function shouldRefreshNow(account, now = new Date()) {
  const next = ensureNextRefreshTime(account);
  return now.getTime() >= new Date(next).getTime();
}

/**
 * Cookie 刷新完成后：重置下次刷新时刻 + 进入 30~60 分钟短冷静期
 */
export function onRefreshCompleted(account) {
  account.nextRefreshAt = null;
  // 刷新后短冷静：重新开始 30-60 分钟只读
  account.warmUpStartedAt = new Date().toISOString();
  account.warmUpDurationHours = 1; // 1小时短温号（覆盖默认72h）
  account.lastRefresh = new Date().toISOString();
}

// ============================================================
// 汇总：账号使用策略（供外部一次性获取）
// ============================================================

/**
 * 温号门控（兼容旧版账号对象）
 * - v2 Account 实例（有 warmUpStartedAt）且未关闭温号 → 严格按温号等级放行
 * - 旧版 plain object / 无温号字段 / warmUpDisabled → 默认放行（不破坏存量）
 */
export function maybeGateByWarmUp(account, opType) {
  if (!account) return { allowed: true, reason: '' };
  if (account.warmUpStartedAt == null || account.warmUpDisabled) {
    return { allowed: true, reason: '账号未开启温号期' };
  }
  return assertOperationAllowed(account, opType);
}

/**
 * 获取账号的完整使用策略摘要
 */
export function getAccountUsagePolicy(account, nowMs = Date.now()) {
  const wu = computeWarmUpLevel(account, nowMs);
  const window = isInActiveWindow(account, new Date(nowMs));
  const policy = {
    warmUp: wu,
    levelName: levelName(wu.level),
    activeWindow: window,
    canRead: assertOperationAllowed(account, 'read', wu).allowed,
    canLike: assertOperationAllowed(account, 'like', wu).allowed,
    canComment: assertOperationAllowed(account, 'comment', wu).allowed,
    canCoin: assertOperationAllowed(account, 'coin', wu).allowed,
    canFav: assertOperationAllowed(account, 'fav', wu).allowed,
    canFollow: assertOperationAllowed(account, 'follow', wu).allowed,
  };
  return policy;
}

export default {
  WARM_UP_LEVEL, levelName,
  computeWarmUpLevel, assertOperationAllowed, maybeGateByWarmUp,
  ensureActiveWindow, isInActiveWindow, jitterWithinWindow,
  ensureNextRefreshTime, shouldRefreshNow, onRefreshCompleted,
  getAccountUsagePolicy,
};
