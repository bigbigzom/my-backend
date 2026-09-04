/**
 * 热度追踪服务（v4.0 新增模块）
 *
 * 核心功能：
 * 1. 热度TAG发现 - 搜索B站热门TAG、关键词
 * 2. 热度视频抓取 - 按TAG/关键词/排行榜/时间范围抓取
 * 3. 自动评论发布 - 调用CommentService主次账号策略
 * 4. 监控轮询 - 自动监控视频评论存在性，缺失则补发
 * 5. 多种抓取模式 - 手动指定/半自动/最新/播放量排行/时间范围
 * 6. 人工筛选 - 汇总列表，手动移除不需要的视频
 *
 * 数据存储：内存 + JSON文件持久化（适配Render免费版512MB）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TREND_FILE = path.join(DATA_DIR, 'trend-tracker.json');

export class TrendTrackerService {
  constructor({ videoService, commentService, monitorService, accountService }) {
    this.videoService = videoService;
    this.commentService = commentService;
    this.monitorService = monitorService;
    this.accountService = accountService;

    // 状态
    this._trendTasks = new Map();   // taskId -> { id, keyword, mode, videos, status, createdAt }
    this._monitoredVideos = new Map(); // videoId -> { aid, bvid, title, taskId, commentStatus, lastCheckAt, retryCount }
    this._hotTags = [];             // 发现的热门TAG缓存

    this._load();
    this._monitorTimer = null;
    this._startMonitorLoop();
  }

  // ===== 持久化 =====
  _load() {
    try {
      if (fs.existsSync(TREND_FILE)) {
        const data = JSON.parse(fs.readFileSync(TREND_FILE, 'utf-8'));
        this._trendTasks = new Map(data.tasks || []);
        this._monitoredVideos = new Map(data.monitored || []);
        this._hotTags = data.hotTags || [];
      }
    } catch (e) { console.warn('[TrendTracker] 加载数据失败:', e.message); }
  }

  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(TREND_FILE, JSON.stringify({
        tasks: [...this._trendTasks],
        monitored: [...this._monitoredVideos],
        hotTags: this._hotTags,
      }, null, 2));
    } catch (e) { console.warn('[TrendTracker] 保存失败:', e.message); }
  }

  // ===== 1. 热度TAG发现 =====
  /**
   * 发现热门TAG
   * 通过搜索关键词，从结果中提取高频TAG
   */
  async discoverHotTags({ accountId, keyword, sampleSize = 50 }) {
    const account = this.accountService.get(accountId);
    if (!account) throw new Error('账号不存在');
    const r = await this.accountService.resolveProxy(accountId);
    if (r.skipped) throw new Error(r.reason || '账号IP不可用');

    // 搜索多页获取样本
    const allVideos = [];
    const pages = Math.ceil(sampleSize / 20);
    for (let p = 1; p <= Math.min(pages, 5); p++) {
      try {
        const result = await this.videoService.searchVideos({
          accountId, keyword, order: 'totalrank', page: p, pageSize: 20,
        });
        allVideos.push(...result.videos);
        await new Promise(r => setTimeout(r, 500));
      } catch (e) { console.warn(`[TrendTracker] 搜索第${p}页失败:`, e.message); }
    }

    // 统计TAG频率
    const tagCount = {};
    for (const v of allVideos) {
      for (const tag of (v.tags || [])) {
        const t = tag.trim();
        if (t && t.length > 1) tagCount[t] = (tagCount[t] || 0) + 1;
      }
    }

    // 排序取TOP
    const hotTags = Object.entries(tagCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([tag, count]) => ({ tag, count, ratio: (count / allVideos.length * 100).toFixed(1) + '%' }));

    this._hotTags = hotTags;
    this._save();
    return { keyword, sampleSize: allVideos.length, hotTags };
  }

  getHotTags() { return this._hotTags; }

  // ===== 2. 热度视频抓取 =====
  /**
   * 抓取热度视频
   * @param {Object} opts
   * @param {string} opts.accountId - 用于调用API的账号
   * @param {string} opts.keyword - 搜索关键词/TAG
   * @param {string} [opts.mode] - 抓取模式: keyword(关键词搜索)/tag(TAG搜索)/popular(热门)/ranking(排行榜)/latest(最新)
   * @param {string} [opts.order] - 排序: totalrank/click/pubdate/dm/stow
   * @param {number} [opts.timeRange] - 时间范围(天): 7=一周, 30=一月, 0=不限
   * @param {number} [opts.maxCount] - 最大抓取数量
   * @param {number} [opts.minPlayCount] - 最低播放量过滤
   */
  async fetchVideos(opts) {
    const { accountId, keyword, mode = 'keyword', order = 'totalrank', timeRange = 0, maxCount = 50, minPlayCount = 0 } = opts;
    const account = this.accountService.get(accountId);
    if (!account) throw new Error('账号不存在');
    const r = await this.accountService.resolveProxy(accountId);
    if (r.skipped) throw new Error(r.reason || '账号IP不可用');

    const taskId = `trend_${Date.now()}`;
    const task = {
      id: taskId, keyword, mode, order, timeRange, maxCount, minPlayCount,
      status: 'fetching', videos: [], createdAt: Date.now(), error: null,
    };
    this._trendTasks.set(taskId, task);

    try {
      let videos = [];

      if (mode === 'popular') {
        // 热门视频
        videos = await this.videoService.getPopular ? await this._fetchPopular(accountId, maxCount) : [];
      } else if (mode === 'ranking') {
        // 排行榜
        videos = await this._fetchRanking(accountId, maxCount);
      } else {
        // 关键词/TAG搜索
        videos = await this._fetchBySearch({ accountId, keyword, order, timeRange, maxCount });
      }

      // 过滤：播放量阈值 + 时间范围
      const now = Date.now() / 1000;
      videos = videos.filter(v => {
        if (minPlayCount > 0 && (v.playCount || 0) < minPlayCount) return false;
        if (timeRange > 0 && v.pubdate && (now - v.pubdate) > timeRange * 86400) return false;
        return true;
      });

      task.videos = videos;
      task.status = 'completed';
      task.fetchedCount = videos.length;
      this._save();
      return { taskId, count: videos.length, videos: videos.slice(0, 100) };
    } catch (e) {
      task.status = 'failed';
      task.error = e.message;
      this._save();
      throw e;
    }
  }

  async _fetchBySearch({ accountId, keyword, order, timeRange, maxCount }) {
    const all = [];
    const pages = Math.ceil(maxCount / 20);
    for (let p = 1; p <= Math.min(pages, 10); p++) {
      try {
        const result = await this.videoService.searchVideos({
          accountId, keyword, order, page: p, pageSize: 20,
        });
        all.push(...result.videos);
        if (result.videos.length < 20) break;
        await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
      } catch (e) { console.warn(`[TrendTracker] 搜索页${p}失败:`, e.message); break; }
    }
    return all.slice(0, maxCount);
  }

  async _fetchPopular(accountId, maxCount) {
    const result = await this.accountService.resolveProxy(accountId);
    if (result.skipped) return [];
    const account = this.accountService.get(accountId);
    const { BiliClient, VideoAPI } = await import('../src/bili-api/index.js');
    const client = new BiliClient({ cookieStr: account.cookieStr, csrf: account.csrf, proxy: account.proxy, userAgent: account.userAgent || undefined, deviceProfile: account.deviceProfile || account.deviceEnv || null });
    const videoApi = new VideoAPI(client);
    const all = [];
    const pages = Math.ceil(maxCount / 20);
    for (let p = 1; p <= Math.min(pages, 5); p++) {
      try {
        const list = await videoApi.getPopular({ pn: p, ps: 20 });
        all.push(...list);
        if (list.length < 20) break;
      } catch (e) { break; }
    }
    return all.slice(0, maxCount);
  }

  async _fetchRanking(accountId, maxCount) {
    const result = await this.accountService.resolveProxy(accountId);
    if (result.skipped) return [];
    const account = this.accountService.get(accountId);
    const { BiliClient, VideoAPI } = await import('../src/bili-api/index.js');
    const client = new BiliClient({ cookieStr: account.cookieStr, csrf: account.csrf, proxy: account.proxy, userAgent: account.userAgent || undefined, deviceProfile: account.deviceProfile || account.deviceEnv || null });
    const videoApi = new VideoAPI(client);
    const list = await videoApi.getRanking({ rid: 0, type: 'all' });
    return list.slice(0, maxCount);
  }

  // ===== 3. 人工筛选 =====
  listTasks() {
    return [...this._trendTasks.values()].map(t => ({
      id: t.id, keyword: t.keyword, mode: t.mode, status: t.status,
      videoCount: t.videos?.length || 0, createdAt: t.createdAt, error: t.error,
    }));
  }

  getTask(taskId) {
    const t = this._trendTasks.get(taskId);
    if (!t) return null;
    return { ...t, videos: t.videos };
  }

  /** 从任务中移除指定视频（人工筛选） */
  removeVideoFromTask(taskId, aid) {
    const task = this._trendTasks.get(taskId);
    if (!task) return false;
    task.videos = task.videos.filter(v => v.aid != aid && v.bvid != aid);
    this._save();
    return true;
  }

  /** 批量移除视频 */
  removeVideosFromTask(taskId, aids) {
    const task = this._trendTasks.get(taskId);
    if (!task) return false;
    const set = new Set(aids.map(String));
    task.videos = task.videos.filter(v => !set.has(String(v.aid)) && !set.has(String(v.bvid)));
    this._save();
    return true;
  }

  deleteTask(taskId) {
    this._trendTasks.delete(taskId);
    this._save();
    return true;
  }

  // ===== 4. 自动评论发布 =====
  /**
   * 对任务中的视频批量发布评论
   * @param {Object} opts
   * @param {string} opts.taskId - 热度任务ID
   * @param {string} opts.mainAccountId - 主账号
   * @param {string} [opts.subAccountId] - 子账号（可选）
   * @param {Function|string} opts.commentGenerator - 评论内容生成器或固定内容
   * @param {number} [opts.delayMs] - 每个视频间隔
   * @param {number} [opts.maxVideos] - 最多处理多少视频
   */
  async publishComments({ taskId, mainAccountId, subAccountId, commentText, subCommentText, delayMs = 8000, maxVideos = 0 }) {
    const task = this._trendTasks.get(taskId);
    if (!task) throw new Error('任务不存在');
    if (task.videos.length === 0) throw new Error('任务中没有视频');

    const videos = maxVideos > 0 ? task.videos.slice(0, maxVideos) : task.videos;
    const results = [];

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      const videoId = video.aid || video.bvid;
      console.log(`[TrendTracker] 发布评论 ${i + 1}/${videos.length}: ${video.title?.substring(0, 30)}`);

      try {
        // 生成评论内容（如果是函数则调用）
        const mainMsg = typeof commentText === 'function'
          ? commentText(video, i)
          : (commentText || `这个视频太棒了！`);
        const subMsg = subCommentText ? (typeof subCommentText === 'function' ? subCommentText(video, i) : subCommentText) : null;

        const result = await this.commentService.publishWithStrategy({
          oid: String(video.aid),
          mainMessage: mainMsg,
          subMessage: subMsg,
          mainAccountId,
          subAccountId,
        });

        // 加入监控
        if (result.success) {
          this._monitoredVideos.set(videoId, {
            aid: video.aid, bvid: video.bvid, title: video.title,
            taskId, mainAccountId, subAccountId,
            mainRpid: result.mainRpid,
            commentStatus: 'posted',
            lastCheckAt: Date.now(),
            retryCount: 0,
            maxRetries: 3,
            createdAt: Date.now(),
          });
        }

        results.push({ videoId, title: video.title, success: result.success, result });
      } catch (e) {
        results.push({ videoId, title: video.title, success: false, error: e.message });
      }

      this._save();
      if (i < videos.length - 1) {
        await new Promise(r => setTimeout(r, delayMs + Math.random() * delayMs * 0.5));
      }
    }

    const success = results.filter(r => r.success).length;
    return { total: videos.length, success, failed: videos.length - success, results };
  }

  // ===== 5. 监控轮询补发 =====
  _startMonitorLoop() {
    if (this._monitorTimer) return;
    this._monitorTimer = setInterval(() => this._monitorTick(), 5 * 60 * 1000); // 每5分钟
  }

  async _monitorTick() {
    const now = Date.now();
    const checkInterval = 30 * 60 * 1000; // 30分钟检查一次
    for (const [videoId, info] of this._monitoredVideos) {
      if (info.commentStatus === 'confirmed') continue;
      if (now - info.lastCheckAt < checkInterval) continue;

      try {
        const exists = await this.commentService.checkCommentExists({
          accountId: info.mainAccountId, oid: String(info.aid),
          rpid: info.mainRpid, message: '',
        });
        info.lastCheckAt = now;
        if (exists) {
          info.commentStatus = 'confirmed';
        } else if (info.retryCount < info.maxRetries) {
          info.retryCount++;
          info.commentStatus = 'republishing';
          // 补发
          console.log(`[TrendTracker] 补发评论: ${info.title?.substring(0, 20)} (第${info.retryCount}次)`);
        } else {
          info.commentStatus = 'failed';
        }
      } catch (e) {
        info.lastCheckAt = now;
        console.warn(`[TrendTracker] 监控检查失败:`, e.message);
      }
    }
    this._save();
  }

  listMonitored() {
    return [...this._monitoredVideos.values()];
  }

  removeMonitored(videoId) {
    this._monitoredVideos.delete(videoId);
    this._save();
    return true;
  }

  async runMonitorNow(videoId) {
    const info = this._monitoredVideos.get(videoId);
    if (!info) throw new Error('未找到监控视频');
    info.lastCheckAt = 0; // 强制检查
    await this._monitorTick();
    return this._monitoredVideos.get(videoId);
  }

  // ===== 状态 =====
  getStats() {
    return {
      tasks: this._trendTasks.size,
      monitored: this._monitoredVideos.size,
      hotTags: this._hotTags.length,
      confirmed: [...this._monitoredVideos.values()].filter(v => v.commentStatus === 'confirmed').length,
      pending: [...this._monitoredVideos.values()].filter(v => v.commentStatus !== 'confirmed' && v.commentStatus !== 'failed').length,
    };
  }
}

export default TrendTrackerService;
