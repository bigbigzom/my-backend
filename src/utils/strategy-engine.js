/**
 * 核心引流策略引擎 v2.2
 *
 * 核心诉求：主号发布关键引流信息 → 次级号楼中楼跟随+点赞 → 推上评论区最热置顶
 *
 * v2.2 重大升级：
 * 1. 分阶段热度增长曲线：主号发布 → 次级号错峰加入（阶段1/2/3随机时间点），模拟真实热度爬升
 * 2. 对话式楼中楼：次级号提问 → 主号回复 → 围观/晒单（真实讨论场，比纯点赞吸引点击）
 * 3. 全局令牌桶速率：全局每分钟发布上限 + 单账号冷却，避免"团伙同时段刷"
 * 4. 智能选主号：健康度加权随机
 * 5. 引流词变体化 + 语义重排（反文案指纹）
 * 6. 人设差异化：次级号按人设生成不同语气
 * 7. 失败分级处理：-352风控→冷却换号 / -101未登录→标记 / -102封禁→标记banned / 网络→重试
 */
import AccountManager, { PERSONAS } from '../accounts/account-manager.js';
import { generateDialogue } from './content-rewriter.js';
import taskQueue from './task-queue.js';
import { addReply, replyAction, getVideoInfo } from './bili-api.js';
// ============================================================
// 全局令牌桶（跨账号全局发布速率控制）
// ============================================================
class TokenBucket {
  constructor(capacity, refillPerMinute) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillPerMinute / 60;  // 每秒补充
    this.lastRefill = Date.now();
  }
  tryTake(count = 1) {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }
  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
  getTokens() {
    this.refill();
    return Math.round(this.tokens);
  }
}
// 全局桶：默认每分钟最多 10 次操作（可配置）
let globalBucket = new TokenBucket(20, 10);
// 策略参数（可被前端 /api/settings 覆盖）
const strategyConfig = {
  globalRatePerMin: 10,        // 全局每分钟操作上限
  singleAccountCooldownMin: 5, // 单账号操作后冷却（分钟）
  newAccountGraceHours: 24,    // 新号冷静期（小时）
  // 热度曲线（阶段配置：每阶段操作数 + 延迟范围）
  heatStages: [
    { stage: 1, label: '铺垫期(0-5min)', actions: 1, delayMin: 30 * 1000, delayMax: 5 * 60 * 1000, likeMain: true },
    { stage: 2, label: '爬升期(5-30min)', actions: 2, delayMin: 6 * 60 * 1000, delayMax: 25 * 60 * 1000, likeMain: true },
    { stage: 3, label: '巩固期(30min-2h)', actions: 2, delayMin: 30 * 60 * 1000, delayMax: 2 * 60 * 60 * 1000, likeMain: true },
  ],
  maxSubPerVideo: 5,           // 单视频本系统评论上限
  maxCommentsPerVideo: 5,      // 单视频评论数上限（超限只点赞）
  likeMainChance: 0.8,         // 次级号点赞主评论概率
  useDialogue: true,           // 对话式楼中楼开关
  nurtureEnabled: true,        // 养号任务开关
  nurturePerDay: 1,            // 每账号每天养号次数
  // ===== v2.3 去关联：时间层 =====
  firstCommentDelayMin: 30 * 60 * 1000,  // 首评最小延迟（视频发布后，默认30分钟）
  firstCommentDelayMax: 3 * 60 * 60 * 1000, // 首评最大延迟（默认3小时）
  commentSpreadHours: 6,       // 多账号评论时间分散跨度（小时）
  enforceActiveHours: true,    // 强制账号活跃时段检查（非活跃时段延后）
  // ===== v2.3 去关联：行为层 =====
  shuffleActionOrder: true,    // 评论/点赞顺序乱序化（避免固定流程）
  browseBeforeLike: true,       // 点赞前先浏览评论区（模拟"看到→觉得好→点赞"）
  browseBeforeLikeMin: 3000,   // 点赞前浏览最小时长ms
  browseBeforeLikeMax: 15000,  // 点赞前浏览最大时长ms
  // ===== v2.3 去关联：内容层 =====
  weakRelevance: true,          // 评论文案与视频弱相关（不夸UP主）
  variantPerAccount: true,      // 不同账号用不同引流词变体
};
/**
 * 更新策略参数（前端配置）
 */
export function updateStrategyConfig(updates = {}) {
  Object.assign(strategyConfig, updates);
  // 重建令牌桶
  if (updates.globalRatePerMin) {
    globalBucket = new TokenBucket(Math.max(1, updates.globalRatePerMin * 2), updates.globalRatePerMin);
  }
  return strategyConfig;
}
export function getStrategyConfig() {
  return { ...strategyConfig };
}
// ============================================================
// 工具
// ============================================================
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
/**
 * 错误码分级处理
 * 返回 { level: 'retry'|'cooldown'|'relogin'|'banned'|'proxy_blocked'|'ok', message }
 */
function classifyError(result) {
  if (!result) return { level: 'retry', message: '无结果' };
  if (result.success && result.data && result.data.code === 0) {
    return { level: 'ok', message: '成功' };
  }
  const code = result.data && result.data.code !== undefined ? result.data.code : result.code;
  switch (code) {
    case -352: return { level: 'cooldown', code, message: '触发风控/需验证码，冷却该账号' };
    case -102: case -103: return { level: 'banned', code, message: '账号被封禁' };
    case -101: return { level: 'relogin', code, message: '登录态失效，需重新登录' };
    case -403: case -412: case -111: return { level: 'proxy_blocked', code, message: '请求被拦截（可能IP被封）' };
    case -400: case -404: return { level: 'retry', code, message: '接口异常' };
    default: return { level: 'retry', code, message: (result.data && result.data.message) || result.error || '未知错误' };
  }
}
// ============================================================
// 策略执行
// ============================================================
/**
 * 执行主次账号联合策略
 * @param {Object} params {
 *   bv: 视频BV号,
 *   mainCopy: 主号引流文案（可含{action}占位）,
 *   mainAccountId: 指定主账号（可选，默认智能选）,
 *   subAccountIds: 指定次级账号（可选）,
 *   keyword: 评论关键词（用于对话剧本）,
 *   subCount: 次级号数量,
 *   onlyLike: 只点赞不评论（补发场景）,
 *   forceNow: 忽略延迟立即执行（测试/手动）
 * }
 * @returns {Object} { mainResult, scheduled: [任务], strategy: {...} }
 */
export async function executeStrategy(params = {}) {
  const { bv, mainCopy, keyword = '', subCount = 3, onlyLike = false, forceNow = false } = params;
  if (!bv) return { code: -1, message: '缺少BV号' };
  // 1. 获取视频信息（BV → oid）
  let oid = params.oid;
  if (!oid) {
    const info = await getVideoInfo(bv);
    const d = info.data && info.data.data ? info.data.data : (info.success && info.data.code === 0 ? info.data.data : null);
    if (!d || !d.aid) {
      return { code: -1, message: `获取视频信息失败: ${info.data && info.data.message || 'BV号无效'}`, raw: info.data };
    }
    oid = d.aid;
  }
  // 2. 选主号（指定 or 健康度加权随机）
  let mainAccount = params.mainAccountId ? AccountManager.getById(params.mainAccountId) : AccountManager.pickRandomMain({ newAccountGraceMs: strategyConfig.newAccountGraceHours * 3600 * 1000 });
  if (!mainAccount) return { code: -1, message: '无可用主账号（可能都在冷却/新号冷静期/被封禁）' };
  // 3. 选次级号
  let subAccounts;
  if (params.subAccountIds && params.subAccountIds.length) {
    subAccounts = params.subAccountIds.map(id => AccountManager.getById(id)).filter(Boolean);
  } else {
    subAccounts = AccountManager.pickSubAccounts(mainAccount.id, subCount, { newAccountGraceMs: strategyConfig.newAccountGraceHours * 3600 * 1000 });
  }
  if (subAccounts.length === 0) return { code: -1, message: '无可用次级账号' };
  // 4. 生成对话剧本
  const dialogue = generateDialogue({
    mainCopy,
    keyword,
    roles: onlyLike ? [] : ['questioner', 'supporter', 'experiencer', 'analyzer'].slice(0, subAccounts.length),
    variantStart: randomInt(0, 5),
  });
  // 4.5 去关联：单视频本系统评论上限检查（超限则只点赞不评论）
  const videoCommentCount = AccountManager.getVideoCommentCount(bv);
  const exceedLimit = videoCommentCount >= strategyConfig.maxCommentsPerVideo;
  if (exceedLimit && !onlyLike) {
    console.log(`[Strategy] 视频 ${bv} 本系统评论已达上限(${strategyConfig.maxCommentsPerVideo})，切换为只点赞模式`);
    onlyLike = true;
  }

  // 4.6 去关联：活跃时段检查（非活跃时段的账号延后执行）
  if (strategyConfig.enforceActiveHours && !forceNow) {
    const mainInActive = AccountManager.isInActiveWindow(mainAccount.id);
    if (!mainInActive) {
      // 主号不在活跃时段 → 延迟到下一个活跃时段
      const delayToActive = AccountManager.getNextActiveTime(mainAccount.id);
      if (delayToActive > 0) {
        console.log(`[Strategy] 主号 ${mainAccount.username} 不在活跃时段，延迟 ${Math.round(delayToActive/60000)} 分钟执行`);
        // 延迟任务
        const delayedJob = taskQueue.add('strategy_delayed', {
          ...params, mainAccountId: mainAccount.id, subAccountIds: subAccounts.map(s=>s.id),
        }, { delayMs: delayToActive, priority: 3, maxRetries: 1 });
        return { code: 0, message: `主号不在活跃时段，已延迟到活跃时段执行（约${Math.round(delayToActive/60000)}分钟后）`, data: { delayed: true, jobId: delayedJob.id } };
      }
    }
  }

  // 5. 令牌桶检查（全局速率）
  if (!globalBucket.tryTake(1)) {
    return { code: -1, message: `全局速率已满（每分钟${strategyConfig.globalRatePerMin}次），请稍后再试`, rateLimited: true };
  }
  // 6. 主号发布
  const mainText = onlyLike ? '' : dialogue.mainCopy;
  let mainResult = null;
  if (mainText) {
    const res = await addReply({
      bv, oid, account: mainAccount, message: mainText, useDmImg: true,
    });
    const cls = classifyError(res);
    if (cls.level === 'ok') {
      mainResult = {
        success: true, accountId: mainAccount.id, username: mainAccount.username,
        rpid: res.data && res.data.data && res.data.data.rpid,
        replyId: res.data && res.data.data && res.data.data.rpid,
      };
      AccountManager.recordPublish(mainAccount.id, bv);
      AccountManager.setCooldown(mainAccount.id, strategyConfig.singleAccountCooldownMin);
    } else {
      // 主号发布失败 → 分级处理
      handlePublishError(mainAccount.id, res, cls, { bv, oid });
      return { code: -1, message: `主账号发布失败: ${cls.message}`, errorClass: cls, raw: res.data };
    }
  }
  // 7. 次级号互动任务（分阶段延迟执行 + 顺序乱序化）
  const scheduled = [];
  if (!onlyLike && mainResult && mainResult.rpid) {
    // v2.3 去关联：每个次级号随机行为模式（避免固定"先回复后点赞"流程）
    const behaviorModes = ['reply_like', 'like_reply', 'reply_only', 'like_only', 'reply_like'];
    const allTasks = []; // 混合所有任务后统一调度

    for (let i = 0; i < subAccounts.length; i++) {
      const sub = subAccounts[i];
      const subText = dialogue.subReplies[i] ? dialogue.subReplies[i].text : dialogue.subReplies[i % dialogue.subReplies.length].text;
      const stage = i === 0 ? 1 : (i <= 2 ? 2 : 3);
      const stageCfg = strategyConfig.heatStages.find(s => s.stage === stage);
      const baseDelay = randomInt(stageCfg.delayMin, stageCfg.delayMax);
      // 随机行为模式（乱序化）
      const mode = strategyConfig.shuffleActionOrder ? pick(behaviorModes) : 'reply_like';

      if (mode.includes('reply')) {
        allTasks.push({
          handler: 'strategy_reply',
          data: { accountId: sub.id, username: sub.username, oid, root: mainResult.rpid, parent: mainResult.rpid, message: subText, bv, stage, persona: sub.persona },
          delayMs: mode === 'like_reply' ? baseDelay + randomInt(60000, 300000) : baseDelay, // 先点赞则回复延后
          priority: 5,
        });
      }
      if (mode.includes('like')) {
        allTasks.push({
          handler: 'strategy_like',
          data: { accountId: sub.id, username: sub.username, oid, rpid: mainResult.rpid, bv, stage, browseBeforeLike: strategyConfig.browseBeforeLike },
          delayMs: mode === 'like_reply' ? baseDelay : baseDelay + randomInt(30000, 180000), // 先回复则点赞延后
          priority: 4,
        });
      }
    }

    // 统一调度所有任务（按 delayMs 排序，任务间随机间隔）
    allTasks.sort((a, b) => a.delayMs - b.delayMs);
    for (const task of allTasks) {
      const job = taskQueue.add(task.handler, task.data, { delayMs: task.delayMs, priority: task.priority, maxRetries: 2 });
      scheduled.push({
        id: job.id,
        type: task.handler === 'strategy_reply' ? '楼中楼回复' : '点赞主评论',
        accountId: task.data.accountId,
        delaySec: Math.round((job.delayedAt - Date.now()) / 1000),
        stage: task.data.stage,
      });
    }
  } else if (mainResult && mainResult.rpid) {
    // 纯点赞模式（补发场景：主号已存在，次级号点赞顶热度）
    const likeTasks = subAccounts.map(sub => ({
      type: 'strategy_like', accountId: sub.id, username: sub.username, oid, rpid: mainResult.rpid, bv, stage: 2,
    }));
    const likeJob = taskQueue.addMany('strategy_like', likeTasks, { staggerMs: 60 * 1000, jitterMs: 30 * 1000, priority: 4, maxRetries: 2 });
    scheduled.push(...likeJob.map(t => ({ id: t.id, type: '点赞主评论', accountId: t.data.accountId, delaySec: Math.round((t.delayedAt - Date.now()) / 1000), stage: 2 })));
  }
  return {
    code: 0,
    message: '策略已执行（主号已发布，次级号分阶段互动中）',
    data: {
      bv, oid,
      mainAccount: { id: mainAccount.id, username: mainAccount.username, persona: mainAccount.persona },
      mainResult,
      mainText,
      subAccounts: subAccounts.map(s => ({ id: s.id, username: s.username, persona: s.persona })),
      scheduled,
      heatStages: strategyConfig.heatStages,
      rateTokens: globalBucket.getTokens(),
    },
  };
}
/**
 * 主号发布失败分级处理
 */
function handlePublishError(accountId, res, cls, { bv, oid }) {
  const code = cls.code;
  if (cls.level === 'cooldown') {
    AccountManager.recordRiskEvent(accountId, { code, message: cls.message, op: 'strategy_publish' });
    AccountManager.setCooldownByLevel(accountId, 1);  // 30min
  } else if (cls.level === 'banned') {
    AccountManager.recordRiskEvent(accountId, { code, message: cls.message, op: 'strategy_publish' });
    AccountManager.update(accountId, { status: 'banned' });
  } else if (cls.level === 'relogin') {
    AccountManager.recordRiskEvent(accountId, { code, message: cls.message, op: 'strategy_publish' });
    AccountManager.update(accountId, { status: 'expired' });
  } else if (cls.level === 'proxy_blocked') {
    AccountManager.recordRiskEvent(accountId, { code, message: cls.message, op: 'strategy_publish' });
    AccountManager.recordRiskSignal(accountId, 'same_ip', '代理被B站拦截');
  } else {
    AccountManager.recordRiskEvent(accountId, { code, message: cls.message, op: 'strategy_publish' });
    AccountManager.setCooldownByLevel(accountId, 1);
  }
}
// ============================================================
// 任务处理器注册（task-queue）
// ============================================================
// 注册：楼中楼回复任务
taskQueue.register('strategy_reply', async (data) => {
  const account = AccountManager.getById(data.accountId);
  if (!account) throw new Error(`账号不存在: ${data.accountId}`);
  if (account.status !== 'normal') throw new Error(`账号状态异常: ${account.status}`);
  // 令牌桶控制
  if (!globalBucket.tryTake(1)) throw new Error('全局速率限制，稍后重试');
  const res = await addReply({
    bv: data.bv, oid: data.oid, account,
    message: data.message, root: data.root, parent: data.parent, useDmImg: true,
  });
  const cls = classifyError(res);
  if (cls.level !== 'ok') {
    // 分级处理
    if (cls.level === 'cooldown') { AccountManager.setCooldownByLevel(account.id, 1); AccountManager.recordRiskEvent(account.id, { code: cls.code, message: cls.message, op: 'strategy_reply' }); }
    if (cls.level === 'banned') AccountManager.update(account.id, { status: 'banned' });
    if (cls.level === 'relogin') AccountManager.update(account.id, { status: 'expired' });
    throw new Error(cls.message);
  }
  AccountManager.recordPublish(account.id, data.bv);
  AccountManager.setCooldown(account.id, strategyConfig.singleAccountCooldownMin);
  return { rpid: res.data && res.data.data && res.data.data.rpid, username: account.username };
});
// 注册：点赞任务
taskQueue.register('strategy_like', async (data) => {
  const account = AccountManager.getById(data.accountId);
  if (!account) throw new Error(`账号不存在: ${data.accountId}`);
  if (account.status !== 'normal') throw new Error(`账号状态异常: ${account.status}`);
  if (!globalBucket.tryTake(1)) throw new Error('全局速率限制，稍后重试');
  // v2.3 去关联：点赞前先"浏览"评论区（模拟"看到→觉得好→点赞"的自然行为）
  if (data.browseBeforeLike !== false) {
    const browseMs = randomInt(strategyConfig.browseBeforeLikeMin || 3000, strategyConfig.browseBeforeLikeMax || 15000);
    console.log(`[Strategy] 账号 ${account.username} 点赞前浏览评论区 ${browseMs}ms`);
    await new Promise(r => setTimeout(r, browseMs));
  }
  const res = await replyAction({ oid: data.oid, rpid: data.rpid, action: 1, account });
  const cls = classifyError(res);
  if (cls.level !== 'ok') {
    if (cls.level === 'banned') AccountManager.update(account.id, { status: 'banned' });
    if (cls.level === 'relogin') AccountManager.update(account.id, { status: 'expired' });
    // 点赞失败不重试（低危），仅记录
    AccountManager.recordRiskEvent(account.id, { code: cls.code, message: cls.message, op: 'strategy_like' });
    return { skipped: true, message: cls.message };
  }
  return { liked: true, rpid: data.rpid, username: account.username };
});
// 注册：养号任务（日常活跃，稀释"只在该UP主评论"的集中信号）
taskQueue.register('nurture_task', async (data) => {
  const account = AccountManager.getById(data.accountId);
  if (!account || account.status !== 'normal') return { skipped: true };
  // 用账号自己的代理发普通评论（非引流）—— 简化：仅记录日志，实际可在浏览器中执行
  console.log(`[Nurture] 账号 ${account.username} 执行养号任务（目标: 其他UP主视频）`);
  return { ok: true };
});

// 注册：延迟策略任务（活跃时段到达后重新执行）
taskQueue.register('strategy_delayed', async (data) => {
  console.log(`[Strategy] 延迟策略任务触发，重新执行 executeStrategy`);
  return await executeStrategy({ ...data, forceNow: true });
});
export { strategyConfig };
export default { executeStrategy, updateStrategyConfig, getStrategyConfig };
