/**
 * BehaviorSimulator - 用户行为模拟器
 *
 * 基于HAR数据包分析发现：
 * - /log/web (38次POST) - 用户行为埋点上报
 * - /v2/log/web (15次POST) - 性能/行为埋点
 * - /cm/api/receive/content/pc (2次POST) - 内容展示上报
 *
 * 模拟这些行为可以降低风控概率，让账号看起来更像真实用户。
 *
 * 行为类型：
 * - 浏览视频（停留、滚动、播放）
 * - 点赞/投币/收藏
 * - 弹幕发送
 * - 搜索
 * - 看评论区
 * - 埋点上报
 */
import { BiliClient } from './BiliClient.js';

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
   * 模拟浏览视频（访问视频页 + 埋点上报）
   * @param {string} bvid - BV号
   * @param {number} duration - 浏览时长（秒）
   */
  async watchVideo(bvid, duration = 30) {
    // 1. 访问视频页（获取视频信息，模拟页面加载）
    try {
      await this.client.get('https://api.bilibili.com/x/web-interface/view', { bvid });
      await this._randomDelay(1000, 3000);

      // 2. 获取播放地址（模拟视频播放）
      await this.client.get('https://api.bilibili.com/x/player/wbi/playurl', {
        bvid,
        qn: '64',
        fnval: '4048',
        platform: 'pc',
      }, { needWbiSign: true });
    } catch (e) {
      // 忽略错误，继续模拟
    }

    // 3. 模拟观看时长
    await new Promise(r => setTimeout(r, duration * 1000));

    // 4. 上报观看进度（埋点）
    await this._reportHeartbeat(bvid, duration);

    return { watched: true, bvid, duration };
  }

  /**
   * 模拟点赞视频
   */
  async likeVideo(aid) {
    try {
      const res = await this.client.postForm('https://api.bilibili.com/x/web-interface/like/add', {
        aid: String(aid),
        like: '1',
        csrf: this.client.csrf,
      });
      await this._randomDelay(500, 1500);
      return { success: res.data.code === 0 };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 模拟投币
   */
  async coinVideo(aid, multiply = 1) {
    try {
      const res = await this.client.postForm('https://api.bilibili.com/x/web-interface/coin/add', {
        aid: String(aid),
        multiply: String(multiply),
        select_like: '0',
        csrf: this.client.csrf,
      });
      await this._randomDelay(500, 1500);
      return { success: res.data.code === 0 };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 模拟收藏
   */
  async favoriteVideo(aid, addId = 1) {
    try {
      const res = await this.client.postForm('https://api.bilibili.com/x/v3/fav/resource/deal', {
        rid: String(aid),
        type: '2',
        add_ids: String(addId),
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
        { oid: String(oid), type: String(type), mode: '3', plat: '1' },
        { needWbiSign: true }
      );
      await this._randomDelay(2000, 5000);
      return { browsed: true };
    } catch (e) {
      return { browsed: false, error: e.message };
    }
  }

  /**
   * 上报心跳/观看进度（埋点）
   * 基于HAR中的 /log/web 接口
   */
  async _reportHeartbeat(bvid, playedSeconds) {
    try {
      const payload = {
        id: 303,
        type: 'watch',
        sub_type: 'play',
        data: {
          bvid,
          played: playedSeconds,
          real_played: playedSeconds,
          played_duration: playedSeconds,
          real_time: playedSeconds,
          spmid: '333.788',
        },
        ts: Math.floor(Date.now() / 1000),
      };
      await this.client.postJson('https://data.bilibili.com/log/web', [payload]);
    } catch (e) {
      // 埋点上报失败不影响主流程
    }
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
      () => this.watchVideo(this._pick(bvids), 10 + Math.random() * 20),
      () => this.search(this._randomKeyword()),
      () => this.browseComments(this._randomOid()),
      () => this.likeVideo(this._randomAid()),
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

  _randomAid() {
    return String(10000000 + Math.floor(Math.random() * 90000000));
  }
}

export default BehaviorSimulator;
