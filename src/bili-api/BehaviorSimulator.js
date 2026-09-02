/**
 * BehaviorSimulator - 用户行为模拟器（v3.1 现代化修复）
 *
 * 基于HAR数据包分析还原的真实行为链：
 *   view取视频信息 → playurl拉流(WBI签名) → 播放入场上报 → 每15s真实心跳 →
 *   （浏览评论区）→ 互动（点赞/投币/收藏/评论）
 *
 * v3.1 修复（对照 HAR 与官方客户端行为）：
 * - 旧实现 `_reportHeartbeat` 模拟 payload 发到 /log/web（B站根本不收）
 * - 真实观看时长上报接口：POST /x/click-interface/web/heartbeat（HAR 已确认）
 * - 播放器每 15 秒上报一次心跳，播放进度需真实时间流逝，不能跳秒
 * - playurl 需补全 aid/cid/qn/fnval/gaia_source 等参数（WBI签名）
 * - 互动动作（点赞/投币/收藏）均携带 csrf 与正确参数
 */
import { BiliClient } from './BiliClient.js';

// 心跳上报间隔（官方播放器节奏）
const HEARTBEAT_INTERVAL_SEC = 15;

export class BehaviorSimulator {
  constructor(client) {
    this.client = client;
  }

  /**
   * 随机延迟（模拟人类操作间隔）
   */
  async _randomDelay(min = 500, max = 3000) {
    const delay = min + Math.random() * (max - min);
    await new Promise(r => setTimeout(r, delay));
  }

  /**
   * 获取视频信息（BV → aid/cid/duration）
   */
  async getVideoInfo(bvid) {
    const res = await this.client.get('https://api.bilibili.com/x/web-interface/view', { bvid });
    const d = res.data?.data;
    if (!d || !d.aid) throw new Error(`获取视频信息失败: ${bvid}`);
    return {
      aid: d.aid,
      cid: d.cid,
      bvid: d.bvid,
      duration: d.duration || 0,
      owner_mid: d.owner?.mid || '',
      title: d.title || '',
    };
  }

  /**
   * 获取播放地址（WBI 签名，参数对齐 HAR）
   */
  async getPlayurl(info) {
    return this.client.get('https://api.bilibili.com/x/player/wbi/playurl', {
      avid: info.aid,
      bvid: info.bvid,
      cid: info.cid,
      qn: '32',
      fnver: '0',
      fnval: '4048',
      fourk: '1',
      voice_balance: '1',
      gaia_source: 'pre-load',
      web_location: '1315873',
    }, { needWbiSign: true });
  }

  /**
   * 真实播放心跳上报（HAR 核心：x/click-interface/web/heartbeat）
   * @param {Object} info 视频信息
   * @param {number} playedTime 当前播放进度（秒）
   * @param {number} realPlayed 真实播放时长（秒）
   * @param {number} startTs 本次播放开始时间戳
   * @param {number} lastProgress 上一次上报进度（秒）
   */
  async reportHeartbeat(info, playedTime, realPlayed, startTs, lastProgress) {
    const body = {
      aid: String(info.aid),
      cid: String(info.cid),
      bvid: info.bvid,
      mid: String(this.client._mid || ''),
      type: '4',
      sub_type: '0',
      dt: '2',
      play_type: '1',
      realtime: String(playedTime),
      played_time: String(playedTime),
      real_played_time: String(realPlayed),
      video_duration: String(info.duration || 0),
      start_ts: String(startTs),
      last_play_progress_time: String(lastProgress),
      max_play_progress_time: String(playedTime),
      manual_played_time: '0',
      report_daily_status: '0',
      spmid: '333.788.replay',
      from_spmid: '333.1007.tianma.2-1-3.click',
      autoplay: '0',
    };
    return this.client.postForm('https://api.bilibili.com/x/click-interface/web/heartbeat', body);
  }

  /**
   * 播放统计上报（观看结束）
   */
  async reportStat(info, playedTime) {
    try {
      await this.client.postForm('https://api.bilibili.com/x/click-interface/web/stat', {
        aid: String(info.aid),
        cid: String(info.cid),
        played_time: String(playedTime),
        realtime: String(playedTime),
      });
    } catch (e) {
      // 统计上报失败不影响主流程
    }
  }

  /**
   * 模拟真实观看视频（完整心跳链）
   * @param {string} bvid - BV号
   * @param {Object} opts
   * @param {number} opts.watchRatio - 观看比例（0.6~0.95，默认随机）
   * @param {number} opts.minWatchSec - 最小时长
   */
  async watchVideo(bvid, opts = {}) {
    // 1. 获取视频信息
    const info = await this.getVideoInfo(bvid);
    await this._randomDelay(800, 2000);

    // 2. 拉取播放地址（WBI签名）
    try {
      await this.getPlayurl(info);
    } catch (e) {
      // 拉流失败不阻断（可能视频需大会员等）
    }
    await this._randomDelay(1000, 2500);

    // 3. 计算目标观看时长（真实用户不会看完）
    const ratio = opts.watchRatio != null
      ? opts.watchRatio
      : (0.6 + Math.random() * 0.35);
    let targetPlayed = Math.max(5, Math.round(info.duration * ratio));
    if (opts.minWatchSec && targetPlayed < opts.minWatchSec) targetPlayed = opts.minWatchSec;
    if (info.duration > 0 && targetPlayed > info.duration) targetPlayed = info.duration;

    // 4. 每15s真实心跳（进度真实流逝，播放中可停顿/快进）
    const startTs = Math.floor(Date.now() / 1000);
    let played = 0;
    const heartbeats = [];
    while (played < targetPlayed) {
      const step = Math.min(HEARTBEAT_INTERVAL_SEC, targetPlayed - played);
      played += step;
      try {
        const res = await this.reportHeartbeat(info, played, played, startTs, Math.max(0, played - step));
        heartbeats.push(played);
      } catch (e) {
        // 心跳失败继续（平台安全机制熔断在 BiliClient 层处理）
      }
      // 心跳之间等真实时间流逝（模拟真人观看节奏）
      await this._randomDelay(HEARTBEAT_INTERVAL_SEC * 900, HEARTBEAT_INTERVAL_SEC * 1050);
    }

    // 5. 观看结束统计上报
    await this.reportStat(info, played);
    await this._randomDelay(500, 1500);

    return { watched: true, bvid, duration: info.duration, played, heartbeats: heartbeats.length };
  }

  /**
   * 模拟点赞视频
   */
  async likeVideo(aid, bvid = '') {
    try {
      const data = { like: '1', csrf: this.client.csrf };
      if (bvid) data.bvid = bvid; else data.aid = String(aid);
      const res = await this.client.postForm('https://api.bilibili.com/x/web-interface/like', data);
      await this._randomDelay(500, 1500);
      return { success: res.data.code === 0 };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 模拟投币
   */
  async coinVideo(aid, bvid = '', multiply = 1) {
    try {
      const data = { multiply: String(multiply), select_like: '0', csrf: this.client.csrf };
      if (bvid) data.bvid = bvid; else data.aid = String(aid);
      const res = await this.client.postForm('https://api.bilibili.com/x/web-interface/coin/add', data);
      await this._randomDelay(500, 1500);
      return { success: res.data.code === 0 };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 模拟收藏
   */
  async favoriteVideo(aid, addId = 0) {
    try {
      const res = await this.client.postForm('https://api.bilibili.com/x/v3/fav/resource/deal', {
        rid: String(aid),
        type: '2',
        add_media_ids: String(addId),
        csrf: this.client.csrf,
      });
      await this._randomDelay(500, 1500);
      return { success: res.data.code === 0 };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 模拟搜索
   */
  async search(keyword) {
    try {
      await this.client.get('https://api.bilibili.com/x/web-interface/search/type', {
        search_type: 'video',
        keyword,
        page: '1',
      });
      await this._randomDelay(1000, 3000);
      return { searched: true, keyword };
    } catch (e) {
      return { searched: false, error: e.message };
    }
  }

  /**
   * 模拟浏览评论区
   */
  async browseComments(oid, type = 1) {
    try {
      await this.client.get(
        'https://api.bilibili.com/x/v2/reply/wbi/main',
        { oid: String(oid), type: String(type), mode: '3', plat: '1', web_location: '1315875' },
        { needWbiSign: true }
      );
      await this._randomDelay(2000, 5000);
      return { browsed: true };
    } catch (e) {
      return { browsed: false, error: e.message };
    }
  }

  /**
   * 完整观看 + 互动会话（养号核心单元）
   * 行为链：观看 →（概率互动）→ 浏览评论区
   * @param {string} bvid
   * @param {Object} opts { like: bool, coin: bool, fav: bool, browseComments: bool, watchRatio }
   */
  async watchAndInteract(bvid, opts = {}) {
    const info = await this.getVideoInfo(bvid);
    const watch = await this.watchVideo(bvid, { watchRatio: opts.watchRatio });
    const result = { ...watch, interactions: [] };

    // 互动概率（写操作必须在观看之后，符合真实行为链）
    if (opts.like) {
      const r = await this.likeVideo(info.aid, info.bvid);
      result.interactions.push({ type: 'like', ...r });
      await this._randomDelay(2000, 6000);
    }
    if (opts.coin) {
      const r = await this.coinVideo(info.aid, info.bvid, 1);
      result.interactions.push({ type: 'coin', ...r });
      await this._randomDelay(3000, 8000);
    }
    if (opts.fav) {
      const r = await this.favoriteVideo(info.aid);
      result.interactions.push({ type: 'fav', ...r });
      await this._randomDelay(2000, 5000);
    }
    if (opts.browseComments !== false) {
      const r = await this.browseComments(info.aid);
      result.interactions.push({ type: 'browse_comments', ...r });
    }
    return result;
  }

  /**
   * 执行一次完整的养号行为（随机组合）
   * @param {Object} options
   * @param {Array<string>} options.bvids - 可浏览的视频BV号列表
   * @param {number} options.minActions - 最少操作数
   * @param {number} options.maxActions - 最多操作数
   */
  async nurtureSession({ bvids = [], minActions = 2, maxActions = 5 } = {}) {
    const actions = [];
    const actionCount = Math.floor(minActions + Math.random() * (maxActions - minActions + 1));
    const availableActions = [
      () => this.watchVideo(this._pick(bvids), { minWatchSec: 15 }),
      () => this.search(this._randomKeyword()),
      () => this.watchAndInteract(this._pick(bvids), { like: true, coin: false, fav: false }),
      () => this.browseComments(this._randomOid()),
    ];
    for (let i = 0; i < actionCount; i++) {
      const action = availableActions[Math.floor(Math.random() * availableActions.length)];
      try {
        const result = await action();
        actions.push(result);
      } catch (e) {
        actions.push({ error: e.message });
      }
      await this._randomDelay(3000, 8000); // 操作间随机间隔
    }
    return { actions, count: actions.length };
  }

  _pick(arr) {
    return arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : 'BV1xx411c7mD';
  }

  _randomKeyword() {
    const keywords = ['搞笑', '美食', '游戏', '科技', '音乐', '舞蹈', '影视', '知识', '生活', '动物'];
    return keywords[Math.floor(Math.random() * keywords.length)];
  }

  _randomOid() {
    return String(100000000 + Math.floor(Math.random() * 900000000));
  }
}

export default BehaviorSimulator;
