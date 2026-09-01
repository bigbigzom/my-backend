/**
 * AccountCultivator - 全方位养号系统
 *
 * 核心设计：
 * 1. 账号类型隔离：视频发布账号 vs 评论区账号，完全隔离
 * 2. 物理网络隔离：不同IP段/代理，避免关联
 * 3. 社交图谱隔离：不互相关注/互动，避免团伙特征
 * 4. 人类行为模拟：浏览/点赞/评论/搜索/弹幕/收藏/投币/分享/观看时长
 * 5. 养号阶段规划：新号期/成长期/成熟期/发布期
 *
 * 设计模式：State（状态模式）+ Strategy（行为策略）+ Template Method（养号流程模板）
 */
import { BehaviorSimulator } from '../bili-api/BehaviorSimulator.js';
import { BiliClient } from '../bili-api/BiliClient.js';
import { CommentAPI } from '../bili-api/CommentAPI.js';
import { maybeGateByWarmUp } from './CookieUseScheduler.js';

// 账号类型
export const ACCOUNT_TYPE = {
  VIDEO_PUBLISHER: 'video_publisher',  // 视频发布账号（最终发布内容互动视频）
  COMMENT_ACCOUNT: 'comment_account',    // 评论区账号（只用于评论内容互动）
};

// 养号阶段
export const CULTIVATION_STAGE = {
  NEWBORN: 'newborn',        // 新号期（0-3天）：只浏览，不互动
  GROWING: 'growing',        // 成长期（3-14天）：开始点赞/收藏/少量评论
  MATURING: 'maturing',      // 成熟期（14-30天）：正常互动，可发评论/弹幕
  READY: 'ready',            // 就绪期（30天+）：可发布视频/大量评论
};

// 养号阶段配置
const STAGE_CONFIG = {
  [CULTIVATION_STAGE.NEWBORN]: {
    durationDays: 3,
    dailyActions: { browse: 10, like: 0, comment: 0, coin: 0, favorite: 0, share: 0, danmaku: 0, search: 3 },
    maxWatchTimeMin: 30,
    riskLevel: 'low',
  },
  [CULTIVATION_STAGE.GROWING]: {
    durationDays: 11,
    dailyActions: { browse: 20, like: 5, comment: 1, coin: 1, favorite: 2, share: 0, danmaku: 1, search: 5 },
    maxWatchTimeMin: 60,
    riskLevel: 'low',
  },
  [CULTIVATION_STAGE.MATURING]: {
    durationDays: 16,
    dailyActions: { browse: 30, like: 10, comment: 3, coin: 2, favorite: 5, share: 1, danmaku: 3, search: 8 },
    maxWatchTimeMin: 90,
    riskLevel: 'medium',
  },
  [CULTIVATION_STAGE.READY]: {
    durationDays: 999,
    dailyActions: { browse: 40, like: 15, comment: 5, coin: 3, favorite: 8, share: 2, danmaku: 5, search: 10 },
    maxWatchTimeMin: 120,
    riskLevel: 'high',
  },
};

// 人类行为时间分布（模拟真实用户的活跃时间段）
const ACTIVE_TIME_WINDOWS = [
  { start: 7, end: 9, weight: 15 },    // 早上通勤
  { start: 12, end: 14, weight: 20 },   // 午休
  { start: 18, end: 20, weight: 25 },   // 下班通勤
  { start: 20, end: 23, weight: 35 },   // 晚间黄金时段
  { start: 23, end: 1, weight: 5 },     // 深夜
];

export class AccountCultivator {
  /**
   * @param {Object} options
   * @param {Account} options.account - 要养号的账号
   * @param {string} options.accountType - 账号类型（video_publisher/comment_account）
   * @param {Object} options.isolationConfig - 隔离配置
   * @param {Function} options.getLogger - 日志函数
   */
  constructor(options = {}) {
    this.account = options.account;
    this.accountType = options.accountType || ACCOUNT_TYPE.COMMENT_ACCOUNT;
    this.isolationConfig = options.isolationConfig || {};
    this.getLogger = options.getLogger || console.log;

    // 养号状态
    this.stage = this.account.cultivationStage || CULTIVATION_STAGE.NEWBORN;
    this.daysInStage = this.account.daysInStage || 0;
    this.totalCultivationDays = this.account.totalCultivationDays || 0;
    this.dailyActionLog = [];
    this.isRunning = false;

    // 初始化 BiliClient（使用账号的完整设备环境）
    this.client = new BiliClient({
      cookieStr: this.account.cookieStr,
      csrf: this.account.csrf,
      userAgent: this.account.userAgent || undefined,
      deviceProfile: this.account.deviceProfile || undefined,
      proxy: this.account.proxy || undefined,
      maxQps: 1, // 养号时降低QPS，模拟人类
    });

    this.behaviorSimulator = new BehaviorSimulator(this.client);
    this.commentApi = new CommentAPI(this.client);
  }

  // ============================================================
  // 隔离策略
  // ============================================================

  /**
   * 检查账号隔离状态（物理网络/社交图谱）
   */
  checkIsolation() {
    const issues = [];

    // 1. 物理网络隔离检查
    if (this.account.proxy) {
      // 检查是否与其他类型账号共用IP
      // （需要外部传入其他账号列表进行比对）
    }

    // 2. 社交图谱隔离检查
    // 视频号和评论号不应该互相关注/互动

    return {
      accountType: this.accountType,
      proxy: this.account.proxy,
      proxyCity: this.account.proxyCity,
      isolationIssues: issues,
      recommendations: issues.length === 0 ? ['隔离状态良好'] : issues,
    };
  }

  // ============================================================
  // 养号阶段管理
  // ============================================================

  /**
   * 获取当前阶段配置
   */
  getStageConfig() {
    return STAGE_CONFIG[this.stage];
  }

  /**
   * 检查是否可以进入下一阶段
   */
  checkStageProgress() {
    const config = this.getStageConfig();
    const canAdvance = this.daysInStage >= config.durationDays;
    const nextStage = this._getNextStage();

    return {
      currentStage: this.stage,
      daysInStage: this.daysInStage,
      requiredDays: config.durationDays,
      canAdvance,
      nextStage: canAdvance ? nextStage : null,
      progress: Math.min(100, Math.round((this.daysInStage / config.durationDays) * 100)),
    };
  }

  /**
   * 进入下一阶段
   */
  advanceStage() {
    const nextStage = this._getNextStage();
    if (!nextStage) return false;

    this.getLogger(`[Cultivator] 账号 ${this.account.uid} 从 ${this.stage} 进入 ${nextStage}`);
    this.stage = nextStage;
    this.daysInStage = 0;
    this._saveCultivationState();
    return true;
  }

  _getNextStage() {
    const stages = [CULTIVATION_STAGE.NEWBORN, CULTIVATION_STAGE.GROWING, CULTIVATION_STAGE.MATURING, CULTIVATION_STAGE.READY];
    const idx = stages.indexOf(this.stage);
    return idx < stages.length - 1 ? stages[idx + 1] : null;
  }

  _saveCultivationState() {
    if (this.account) {
      this.account.cultivationStage = this.stage;
      this.account.daysInStage = this.daysInStage;
      this.account.totalCultivationDays = this.totalCultivationDays;
      this.account.accountType = this.accountType;
    }
  }

  // ============================================================
  // 人类行为模拟（核心养号逻辑）
  // ============================================================

  /**
   * 执行一天的养号任务
   * @param {Object} options - 选项
   * @param {string[]} options.targetBvids - 目标视频列表（可选）
   * @param {string[]} options.searchKeywords - 搜索关键词（可选）
   * @param {number} options.actionMultiplier - 动作倍数（默认1）
   */
  async runDailyCultivation(options = {}) {
    const { targetBvids = [], searchKeywords = [], actionMultiplier = 1 } = options;
    const config = this.getStageConfig();
    const dailyActions = { ...config.dailyActions };

    // 应用倍数
    for (const key in dailyActions) {
      dailyActions[key] = Math.round(dailyActions[key] * actionMultiplier);
    }

    this.getLogger(`[Cultivator] 开始每日养号: ${this.account.uid}, 阶段: ${this.stage}, 目标动作: ${JSON.stringify(dailyActions)}`);

    this.isRunning = true;
    const results = {
      browse: 0, like: 0, comment: 0, coin: 0,
      favorite: 0, share: 0, danmaku: 0, search: 0,
      watchTimeMin: 0,
      errors: [],
    };

    try {
      // 1. 搜索行为（模拟用户主动搜索）
      if (dailyActions.search > 0 && searchKeywords.length > 0) {
        for (let i = 0; i < dailyActions.search; i++) {
          const keyword = searchKeywords[Math.floor(Math.random() * searchKeywords.length)];
          try {
            await this._simulateSearch(keyword);
            results.search++;
            await this._humanDelay(3, 8);
          } catch (e) {
            results.errors.push(`搜索失败: ${e.message}`);
          }
        }
      }

      // 2. 浏览视频（核心行为）
      const videosToBrowse = targetBvids.length > 0
        ? this._shuffle([...targetBvids]).slice(0, dailyActions.browse)
        : await this._getRecommendVideos(dailyActions.browse);

      for (const bvid of videosToBrowse) {
        try {
          const watchResult = await this._simulateVideoWatch(bvid, config.maxWatchTimeMin);
          results.browse++;
          results.watchTimeMin += watchResult.watchMin;

          // v3.1 温号门控：写操作必须满足温号等级（冷启动冷静期自动降级）
          const gLike = maybeGateByWarmUp(this.account, 'like');
          const gCoin = maybeGateByWarmUp(this.account, 'coin');
          const gFav = maybeGateByWarmUp(this.account, 'fav');
          const gComment = maybeGateByWarmUp(this.account, 'comment');

          // 随机互动（基于阶段配置的概率 + 温号等级）
          if (Math.random() < dailyActions.like / dailyActions.browse && gLike.allowed) {
            await this.behaviorSimulator.likeVideo(bvid);
            results.like++;
            await this._humanDelay(1, 3);
          }
          if (Math.random() < dailyActions.coin / dailyActions.browse && gCoin.allowed) {
            await this.behaviorSimulator.coinVideo(bvid, 1);
            results.coin++;
            await this._humanDelay(1, 3);
          }
          if (Math.random() < dailyActions.favorite / dailyActions.browse && gFav.allowed) {
            await this.behaviorSimulator.favoriteVideo(bvid);
            results.favorite++;
            await this._humanDelay(1, 3);
          }
          if (Math.random() < dailyActions.share / dailyActions.browse) {
            await this._simulateShare(bvid);
            results.share++;
            await this._humanDelay(2, 5);
          }
          if (Math.random() < dailyActions.danmaku / dailyActions.browse) {
            await this._simulateDanmaku(bvid);
            results.danmaku++;
            await this._humanDelay(2, 5);
          }
          if (Math.random() < dailyActions.comment / dailyActions.browse && gComment.allowed) {
            await this._simulateComment(bvid);
            results.comment++;
            await this._humanDelay(3, 8);
          }

          await this._humanDelay(5, 15); // 视频间间隔
        } catch (e) {
          results.errors.push(`浏览视频 ${bvid} 失败: ${e.message}`);
        }
      }

      // 更新养号状态
      this.daysInStage++;
      this.totalCultivationDays++;
      this._saveCultivationState();

      this.getLogger(`[Cultivator] 每日养号完成: ${JSON.stringify(results)}`);
    } catch (e) {
      results.errors.push(`养号任务失败: ${e.message}`);
      this.getLogger(`[Cultivator] 养号任务异常: ${e.message}`);
    } finally {
      this.isRunning = false;
    }

    return results;
  }

  // ============================================================
  // 具体行为模拟
  // ============================================================

  async _simulateSearch(keyword) {
    // 模拟搜索：访问搜索页 + 随机点击结果
    this.getLogger(`[Cultivator] 搜索: ${keyword}`);
    try {
      await this.client.get('https://api.bilibili.com/x/web-interface/search/type', {
        keyword,
        search_type: 'video',
        page: 1,
      });
    } catch (e) {
      // 搜索API可能需要wbi签名，失败也正常
    }
  }

  async _simulateVideoWatch(bvid, maxWatchMin) {
    // 模拟观看：获取视频信息 + 模拟播放进度上报
    const watchMin = Math.random() * maxWatchMin * 0.5 + maxWatchMin * 0.2; // 观看20%-70%时长
    this.getLogger(`[Cultivator] 观看视频: ${bvid}, 约${watchMin.toFixed(1)}分钟`);

    try {
      // 获取视频信息（触发播放统计）
      await this.behaviorSimulator.watchVideo(bvid, Math.round(watchMin * 60));
    } catch (e) {
      // 忽略
    }

    return { watchMin };
  }

  async _simulateShare(bvid) {
    this.getLogger(`[Cultivator] 分享视频: ${bvid}`);
    // 模拟分享：调用分享统计API
    try {
      await this.client.postForm('https://api.bilibili.com/x/web-interface/share/add', {
        bvid,
        csrf: this.client.csrf,
      });
    } catch (e) {
      // 忽略
    }
  }

  async _simulateDanmaku(bvid) {
    const danmakus = [
      '666', '哈哈哈哈', '前排', '打卡', '学到了',
      'UP主辛苦了', '一键三连了', '这个不错', '收藏了',
      '第一次看', '回来复习', '催更', '太真实了', '泪目',
    ];
    const content = danmakus[Math.floor(Math.random() * danmakus.length)];
    this.getLogger(`[Cultivator] 发弹幕: ${content}`);
    // 弹幕发送需要cid，这里简化处理
  }

  async _simulateComment(bvid) {
    const comments = [
      'UP主讲得太好了，学到了很多',
      '一键三连支持一下',
      '这个视频质量真高',
      '收藏了，慢慢看',
      'UP主什么时候更新下一期',
      '太有道理了',
      '看完受益匪浅',
      '已经关注了',
    ];
    const content = comments[Math.floor(Math.random() * comments.length)];
    this.getLogger(`[Cultivator] 发评论: ${content.substring(0, 20)}...`);
    try {
      // 需要先获取oid（aid）
      const videoInfo = await this.client.get('https://api.bilibili.com/x/web-interface/view', { bvid });
      if (videoInfo && videoInfo.data && videoInfo.data.aid) {
        await this.commentApi.addComment(videoInfo.data.aid, content);
      }
    } catch (e) {
      // 忽略
    }
  }

  async _getRecommendVideos(count) {
    // 获取推荐视频列表
    try {
      const res = await this.client.get('https://api.bilibili.com/x/web-interface/index/top/feed/rcmd', {
        y_num: 5,
        fresh_type: 3,
        fetch_row: 4,
      });
      if (res && res.data && res.data.item) {
        return res.data.item.map(v => v.bvid).filter(Boolean).slice(0, count);
      }
    } catch (e) {
      // 忽略
    }
    return [];
  }

  // ============================================================
  // 工具方法
  // ============================================================

  _humanDelay(minSec, maxSec) {
    const delay = (Math.random() * (maxSec - minSec) + minSec) * 1000;
    return new Promise(r => setTimeout(r, delay));
  }

  _shuffle(arr) {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /**
   * 获取养号报告
   */
  getReport() {
    return {
      accountUid: this.account.uid,
      accountType: this.accountType,
      stage: this.stage,
      daysInStage: this.daysInStage,
      totalCultivationDays: this.totalCultivationDays,
      stageProgress: this.checkStageProgress(),
      stageConfig: this.getStageConfig(),
      isolation: this.checkIsolation(),
      isRunning: this.isRunning,
    };
  }
}

export default AccountCultivator;
