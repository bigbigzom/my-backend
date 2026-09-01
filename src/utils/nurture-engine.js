/**
 * 养号引擎 NurtureEngine
 * ============================================================
 * 独立运营策略核心模块：让评论账号有"日常生活轨迹"，
 * 稀释"只出现在目标UP主评论区"的集中信号。
 *
 * 功能：
 * 1. 随机浏览其他UP主视频（分区热门/推荐）
 * 2. 模拟观看时长（停留）
 * 3. 低频点赞/投币/收藏
 * 4. 发普通生活化评论（非内容互动）
 * 5. 关注少量无关UP主
 * 6. 每账号独立养号计划（频率/时段/行为偏好）
 * 7. 养号任务队列化 + 持久化
 *
 * 参考独立运营策略文档：C.行为层(10-14) / E.社交图谱(21) / F.账号基建(24)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AccountManager from '../accounts/account-manager.js';
import { getBiliHeaders } from './bili-api.js';
import { randomDelay, randomInt, pick, weightedPick } from './human-behavior.js';
import taskQueue from './task-queue.js';

// 本地通用请求函数（用原生 fetch，兼容 GET/POST）
async function apiRequest(url, options = {}) {
  const opts = { ...options };
  if (!opts.signal) opts.signal = AbortSignal.timeout(15000);
  const res = await fetch(url, opts);
  return await res.json();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NURTURE_DATA_FILE = path.join(__dirname, '../models/nurture-plans.json');
const NURTURE_HISTORY_FILE = path.join(__dirname, '../models/nurture-history.json');

// ============================================================
// 生活化评论库（非内容互动，模拟真实用户日常发言）
// ============================================================
const LIFE_COMMENT_POOL = [
  // 通用感慨
  '哈哈这个有意思', '看完了，挺不错的', 'UP主加油', '收藏了慢慢看',
  '第一次看这个UP的视频，质量不错', '弹幕笑死我了', '前面的别走',
  '这bgm是什么啊求', '画质好评', '终于更新了', '等了好久终于等到',
  // 生活化闲聊
  '下班回家刚好刷到', '吃饭的时候看刚刚好', '睡前刷到这个，晚安各位',
  '今天摸鱼又看了一遍', '室友问我在笑什么', '这个月第三次看了',
  '推荐算法你赢了', '大数据真懂我', '怎么才推给我',
  // 内容相关（弱相关，不夸UP主）
  '这个知识点讲得清楚', '学到了', '原来还可以这样', '长知识了',
  '之前一直没搞懂，现在明白了', '这个角度挺新颖的', '有点东西',
  // 互动型
  '有没有人和我一样看到最后', '前面的等等我', '1分20秒那里笑死',
  '建议改成：xxx', '这波操作666', '好家伙',
];

// 养号行为类型及权重（模拟真实用户行为分布）
const NURTURE_ACTIONS = [
  { type: 'watch', weight: 50, desc: '观看视频（停留）' },
  { type: 'like', weight: 25, desc: '点赞视频' },
  { type: 'comment', weight: 12, desc: '发普通评论' },
  { type: 'coin', weight: 5, desc: '投币' },
  { type: 'favorite', weight: 5, desc: '收藏' },
  { type: 'follow', weight: 3, desc: '关注UP主' },
];

// B站分区RID（用于随机获取其他UP主视频，避开目标UP主所在分区）
const BILI_REGIONS = [
  { rid: 1, name: '动画' }, { rid: 3, name: '音乐' }, { rid: 4, name: '游戏' },
  { rid: 5, name: '娱乐' }, { rid: 11, name: '电视剧' }, { rid: 13, name: '番剧' },
  { rid: 17, name: '单机游戏' }, { rid: 21, name: '日常' }, { rid: 23, name: '电影' },
  { rid: 36, name: '知识' }, { rid: 65, name: '网络游戏' }, { rid: 76, name: '美食制作' },
  { rid: 95, name: '数码' }, { rid: 122, name: '野生技能协会' }, { rid: 138, name: '搞笑' },
  { rid: 160, name: '生活记录' }, { rid: 168, name: '国创' }, { rid: 181, name: '影视' },
  { rid: 188, name: '圈' }, { rid: 211, name: '美食' }, { rid: 217, name: '动物圈' },
  { rid: 223, name: '汽车' }, { rid: 234, name: '运动' }, { rid: 250, name: '出行' },
];

// ============================================================
// 养号计划管理
// ============================================================
class NurtureEngine {
  constructor() {
    this.plans = this._loadPlans();
    this.history = this._loadHistory();
    this.running = false;
    this.timer = null;
  }

  _loadPlans() {
    try {
      if (fs.existsSync(NURTURE_DATA_FILE)) {
        return JSON.parse(fs.readFileSync(NURTURE_DATA_FILE, 'utf-8'));
      }
    } catch (e) { console.error('[Nurture] 加载养号计划失败:', e.message); }
    return {};
  }

  _savePlans() {
    try {
      fs.mkdirSync(path.dirname(NURTURE_DATA_FILE), { recursive: true });
      fs.writeFileSync(NURTURE_DATA_FILE, JSON.stringify(this.plans, null, 2));
    } catch (e) { console.error('[Nurture] 保存养号计划失败:', e.message); }
  }

  _loadHistory() {
    try {
      if (fs.existsSync(NURTURE_HISTORY_FILE)) {
        return JSON.parse(fs.readFileSync(NURTURE_HISTORY_FILE, 'utf-8'));
      }
    } catch (e) {}
    return [];
  }

  _saveHistory() {
    try {
      fs.mkdirSync(path.dirname(NURTURE_HISTORY_FILE), { recursive: true });
      // 只保留最近 500 条
      const trimmed = this.history.slice(-500);
      fs.writeFileSync(NURTURE_HISTORY_FILE, JSON.stringify(trimmed, null, 2));
    } catch (e) {}
  }

  /**
   * 为账号创建/获取养号计划
   * 每账号独立：活跃时段、行为偏好、每日频率
   */
  getOrCreatePlan(accountId) {
    if (this.plans[accountId]) return this.plans[accountId];

    // 随机化活跃时段（避免所有账号同时活跃）
    const activeStartHour = randomInt(7, 20); // 7点-20点开始活跃
    const activeEndHour = Math.min(24, activeStartHour + randomInt(3, 8)); // 活跃3-8小时
    // 随机化行为偏好（有的账号爱点赞，有的爱评论）
    const preference = {
      likeBias: Math.random() * 0.4,      // 点赞偏好偏移
      commentBias: Math.random() * 0.3,   // 评论偏好偏移
      coinBias: Math.random() * 0.15,     // 投币偏好偏移
      followBias: Math.random() * 0.1,    // 关注偏好偏移
    };
    // 每日养号频率（1-4次，模拟真实用户不会天天高频）
    const dailyFrequency = randomInt(1, 4);

    const plan = {
      accountId,
      createdAt: Date.now(),
      activeStartHour,
      activeEndHour,
      preference,
      dailyFrequency,
      totalNurtureActions: 0,
      lastNurtureAt: 0,
      enabled: true,
      // 已关注的UP主（避免重复关注）
      followedUps: [],
      // 已互动过的视频（避免重复）
      interactedVideos: [],
    };
    this.plans[accountId] = plan;
    this._savePlans();
    return plan;
  }

  /**
   * 判断账号当前是否在活跃时段
   */
  isInActiveWindow(accountId) {
    const plan = this.getOrCreatePlan(accountId);
    if (!plan.enabled) return false;
    const hour = new Date().getHours();
    return hour >= plan.activeStartHour && hour < plan.activeEndHour;
  }

  /**
   * 获取随机视频（从随机分区，避开目标UP主）
   * 返回 { bvid, aid, title, ownerMid, ownerName }
   */
  async fetchRandomVideo(excludeUpMids = []) {
    const region = pick(BILI_REGIONS);
    try {
      const url = `https://api.bilibili.com/x/web-interface/dynamic/region?rid=${region.rid}&pn=1&ps=20`;
      const data = await apiRequest(url, { headers: getBiliHeaders() });
      if (data && data.code === 0 && data.data && data.data.archives) {
        const videos = data.data.archives.filter(v =>
          v && v.bvid && !excludeUpMids.includes(v.owner && v.owner.mid)
        );
        if (videos.length > 0) {
          const v = pick(videos);
          return {
            bvid: v.bvid,
            aid: v.aid,
            title: v.title,
            ownerMid: v.owner && v.owner.mid,
            ownerName: v.owner && v.owner.name,
            region: region.name,
          };
        }
      }
    } catch (e) {
      console.error(`[Nurture] 获取分区${region.name}视频失败:`, e.message);
    }
    return null;
  }

  /**
   * 执行一次养号行为
   * @param {string} accountId - 账号ID
   * @param {object} options - { excludeUpMids, forceAction }
   */
  async performNurtureAction(accountId, options = {}) {
    const account = AccountManager.getById(accountId);
    if (!account) return { success: false, error: '账号不存在' };
    if (account.status !== 'normal') return { success: false, error: '账号状态异常' };

    const plan = this.getOrCreatePlan(accountId);

    // 选择行为类型（按权重 + 账号偏好）
    let actionType = options.forceAction;
    if (!actionType) {
      const weighted = NURTURE_ACTIONS.map(a => {
        let w = a.weight;
        if (a.type === 'like') w *= (1 + plan.preference.likeBias);
        if (a.type === 'comment') w *= (1 + plan.preference.commentBias);
        if (a.type === 'coin') w *= (1 + plan.preference.coinBias);
        if (a.type === 'follow') w *= (1 + plan.preference.followBias);
        return { ...a, weight: w };
      });
      actionType = weightedPick(weighted).type;
    }

    // 获取随机视频（watch/like/comment/coin/favorite 都需要视频）
    let video = null;
    if (['watch', 'like', 'comment', 'coin', 'favorite', 'follow'].includes(actionType)) {
      video = await this.fetchRandomVideo(options.excludeUpMids || []);
      if (!video) return { success: false, error: '无法获取随机视频', action: actionType };
    }

    let result = { success: false, action: actionType, video };
    try {
      switch (actionType) {
        case 'watch':
          result = await this._actionWatch(account, video, plan);
          break;
        case 'like':
          result = await this._actionLike(account, video, plan);
          break;
        case 'comment':
          result = await this._actionComment(account, video, plan);
          break;
        case 'coin':
          result = await this._actionCoin(account, video, plan);
          break;
        case 'favorite':
          result = await this._actionFavorite(account, video, plan);
          break;
        case 'follow':
          result = await this._actionFollow(account, video, plan);
          break;
      }
    } catch (e) {
      result.error = e.message;
    }

    // 记录历史
    this.history.push({
      accountId,
      action: actionType,
      video: video ? { bvid: video.bvid, title: video.title } : null,
      success: result.success,
      error: result.error || null,
      timestamp: Date.now(),
    });
    this._saveHistory();

    if (result.success) {
      plan.totalNurtureActions++;
      plan.lastNurtureAt = Date.now();
      if (video && !plan.interactedVideos.includes(video.bvid)) {
        plan.interactedVideos.push(video.bvid);
        if (plan.interactedVideos.length > 100) plan.interactedVideos = plan.interactedVideos.slice(-100);
      }
      this._savePlans();
    }

    return result;
  }

  // ============================================================
  // 具体养号行为实现
  // ============================================================

  /** 观看视频（模拟停留时长，不调用API，只是等待） */
  async _actionWatch(account, video, plan) {
    // 模拟观看 30秒-5分钟（真实用户不会秒退）
    const watchSeconds = randomInt(30, 300);
    console.log(`[Nurture] 账号${account.username} 观看视频 ${video.bvid} 预计${watchSeconds}秒`);
    // 实际不等待那么久（测试/效率考虑），但记录模拟时长
    // 生产环境可改为 await new Promise(r => setTimeout(r, watchSeconds * 1000));
    await new Promise(r => setTimeout(r, randomInt(500, 2000)));
    return { success: true, action: 'watch', video, watchSeconds, message: `模拟观看${watchSeconds}秒` };
  }

  /** 点赞视频 */
  async _actionLike(account, video, plan) {
    // 先模拟观看（点赞前先看）
    await new Promise(r => setTimeout(r, randomInt(1000, 3000)));
    try {
      const url = 'https://api.bilibili.com/x/web-interface/archive/like';
      const data = await apiRequest(url, {
        method: 'POST',
        headers: getBiliHeaders(account, { contentType: 'urlencoded' }),
        body: new URLSearchParams({ aid: video.aid, like: 1, csrf: account.csrf }).toString(),
      });
      if (data && (data.code === 0 || data.code === 65006)) {
        // 65006 = 已经赞过
        return { success: true, action: 'like', video, message: data.code === 65006 ? '已赞过' : '点赞成功' };
      }
      return { success: false, action: 'like', video, error: data ? data.message : '未知错误' };
    } catch (e) {
      return { success: false, action: 'like', video, error: e.message };
    }
  }

  /** 发普通生活化评论 */
  async _actionComment(account, video, plan) {
    // 先模拟观看+滚动评论区（点赞前先浏览的独立运营策略）
    await new Promise(r => setTimeout(r, randomInt(2000, 5000)));
    const comment = pick(LIFE_COMMENT_POOL);
    try {
      // 先获取视频oid
      const infoUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${video.bvid}`;
      const info = await apiRequest(infoUrl, { headers: getBiliHeaders(account) });
      if (!info || info.code !== 0 || !info.data) {
        return { success: false, action: 'comment', video, error: '获取视频信息失败' };
      }
      const oid = info.data.aid;
      const url = 'https://api.bilibili.com/x/v2/reply/add';
      const data = await apiRequest(url, {
        method: 'POST',
        headers: getBiliHeaders(account, { contentType: 'urlencoded' }),
        body: new URLSearchParams({
          type: 1, oid, message: comment,
          plat: 1, csrf: account.csrf,
        }).toString(),
      });
      if (data && data.code === 0) {
        return { success: true, action: 'comment', video, comment, message: '普通评论发布成功' };
      }
      return { success: false, action: 'comment', video, comment, error: data ? data.message : '未知错误' };
    } catch (e) {
      return { success: false, action: 'comment', video, error: e.message };
    }
  }

  /** 投币（低频，模拟真实用户） */
  async _actionCoin(account, video, plan) {
    await new Promise(r => setTimeout(r, randomInt(2000, 4000)));
    try {
      const url = 'https://api.bilibili.com/x/web-interface/coin/add';
      const data = await apiRequest(url, {
        method: 'POST',
        headers: getBiliHeaders(account, { contentType: 'urlencoded' }),
        body: new URLSearchParams({
          aid: video.aid, multiply: 1, select_like: 0,
          csrf: account.csrf,
        }).toString(),
      });
      if (data && (data.code === 0 || data.code === 34005)) {
        // 34005 = 硬币不足
        return { success: true, action: 'coin', video, message: data.code === 34005 ? '硬币不足（跳过）' : '投币成功' };
      }
      return { success: false, action: 'coin', video, error: data ? data.message : '未知错误' };
    } catch (e) {
      return { success: false, action: 'coin', video, error: e.message };
    }
  }

  /** 收藏视频 */
  async _actionFavorite(account, video, plan) {
    await new Promise(r => setTimeout(r, randomInt(1500, 3500)));
    try {
      // 需要先获取用户的默认收藏夹
      const favUrl = 'https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + (account.uid || '');
      const favData = await apiRequest(favUrl, { headers: getBiliHeaders(account) });
      let mediaId = null;
      if (favData && favData.code === 0 && favData.data && favData.data.list && favData.data.list.length > 0) {
        mediaId = favData.data.list[0].id;
      }
      if (!mediaId) return { success: false, action: 'favorite', video, error: '无收藏夹' };

      const url = 'https://api.bilibili.com/x/v3/fav/resource/deal';
      const data = await apiRequest(url, {
        method: 'POST',
        headers: getBiliHeaders(account, { contentType: 'urlencoded' }),
        body: new URLSearchParams({
          rid: video.aid, type: 2, add_media_ids: mediaId,
          csrf: account.csrf,
        }).toString(),
      });
      if (data && data.code === 0) {
        return { success: true, action: 'favorite', video, message: '收藏成功' };
      }
      return { success: false, action: 'favorite', video, error: data ? data.message : '未知错误' };
    } catch (e) {
      return { success: false, action: 'favorite', video, error: e.message };
    }
  }

  /** 关注UP主（低频，少量） */
  async _actionFollow(account, video, plan) {
    // 限制：每个账号最多关注 10 个UP主（避免关注过多异常）
    if (plan.followedUps.length >= 10) {
      return { success: true, action: 'follow', video, message: '已达关注上限（跳过）' };
    }
    if (!video.ownerMid || plan.followedUps.includes(video.ownerMid)) {
      return { success: true, action: 'follow', video, message: '已关注该UP（跳过）' };
    }
    await new Promise(r => setTimeout(r, randomInt(2000, 4000)));
    try {
      const url = 'https://api.bilibili.com/x/relation/modify';
      const data = await apiRequest(url, {
        method: 'POST',
        headers: getBiliHeaders(account, { contentType: 'urlencoded' }),
        body: new URLSearchParams({
          fid: video.ownerMid, act: 1, re_src: 11,
          csrf: account.csrf,
        }).toString(),
      });
      if (data && data.code === 0) {
        plan.followedUps.push(video.ownerMid);
        this._savePlans();
        return { success: true, action: 'follow', video, upName: video.ownerName, message: `关注 ${video.ownerName} 成功` };
      }
      return { success: false, action: 'follow', video, error: data ? data.message : '未知错误' };
    } catch (e) {
      return { success: false, action: 'follow', video, error: e.message };
    }
  }

  // ============================================================
  // 批量养号调度
  // ============================================================

  /**
   * 对所有启用的账号执行一轮养号（每个账号在活跃时段内随机执行1次）
   */
  async nurtureAllAccounts(options = {}) {
    const accounts = AccountManager.getAll().filter(a => a.status === 'normal');
    const results = [];
    for (const account of accounts) {
      const plan = this.getOrCreatePlan(account.id);
      if (!plan.enabled) continue;
      // 非活跃时段跳过（除非 force=true）
      if (!options.force && !this.isInActiveWindow(account.id)) continue;
      // 频率控制：距上次养号不足 N 小时则跳过
      const minIntervalHours = 24 / Math.max(1, plan.dailyFrequency);
      const hoursSinceLast = (Date.now() - plan.lastNurtureAt) / 3600000;
      if (!options.force && hoursSinceLast < minIntervalHours) continue;

      console.log(`[Nurture] 开始养号: ${account.username}`);
      const result = await this.performNurtureAction(account.id, options);
      results.push({ accountId: account.id, username: account.username, ...result });
      // 账号间随机间隔（避免同时操作）
      await new Promise(r => setTimeout(r, randomInt(3000, 10000)));
    }
    return results;
  }

  /**
   * 启动定时养号调度（每小时检查一次，在活跃时段内的账号执行养号）
   */
  startScheduler(intervalMs = 3600000) {
    if (this.running) return;
    this.running = true;
    console.log(`[Nurture] 养号调度已启动（间隔${intervalMs / 60000}分钟）`);
    this.timer = setInterval(async () => {
      try {
        await this.nurtureAllAccounts();
      } catch (e) {
        console.error('[Nurture] 调度异常:', e.message);
      }
    }, intervalMs);
  }

  stopScheduler() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    console.log('[Nurture] 养号调度已停止');
  }

  // ============================================================
  // 查询接口
  // ============================================================

  getPlan(accountId) { return this.plans[accountId] || null; }
  getAllPlans() { return Object.values(this.plans); }
  getHistory(limit = 50) { return this.history.slice(-limit).reverse(); }
  getStats() {
    const plans = Object.values(this.plans);
    return {
      totalAccounts: plans.length,
      enabledAccounts: plans.filter(p => p.enabled).length,
      totalActions: plans.reduce((s, p) => s + p.totalNurtureActions, 0),
      historyCount: this.history.length,
      running: this.running,
    };
  }

  updatePlan(accountId, updates) {
    const plan = this.plans[accountId];
    if (!plan) return null;
    Object.assign(plan, updates);
    this._savePlans();
    return plan;
  }

  removePlan(accountId) {
    delete this.plans[accountId];
    this._savePlans();
  }
}

const nurtureEngine = new NurtureEngine();
export default nurtureEngine;
export { NurtureEngine, LIFE_COMMENT_POOL, NURTURE_ACTIONS };
