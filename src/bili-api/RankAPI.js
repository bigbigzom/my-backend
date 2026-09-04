/**
 * RankAPI - B站排行榜数据接口封装（v7.1 新增）
 *
 * 只封装B站排行榜相关API，不包含业务逻辑。
 * 被 RankAnalyticsService 调用。
 *
 * 接口参考：
 * - 排行榜: GET /x/web-interface/ranking/v2
 * - 视频详情: GET /x/web-interface/view
 * - UP主信息: GET /x/space/acc/info
 */

// B站分区ID映射
export const BILI_RID = {
  ALL: 0,
  ANIME: 1,        // 番剧
  GUOCHUANG: 168,  // 国创
  MUSIC: 3,        // 音乐
  DANCE: 129,      // 舞蹈
  GAME: 4,         // 游戏
  KNOWLEDGE: 36,   // 知识
  TECH: 188,       // 科技
  SPORTS: 234,     // 运动
  CAR: 223,        // 汽车
  LIFE: 160,       // 生活
  FOOD: 211,       // 美食
  ANIMAL: 217,     // 动物圈
  KICHIKU: 119,    // 鬼畜
  FASHION: 155,    // 时尚
  INFO: 202,       // 资讯
  ENTERTAINMENT: 5, // 娱乐
  CINEPHILE: 181,  // 影视
  DOCUMENTARY: 177, // 纪录片
  MOVIE: 23,       // 电影
  TV: 11,          // 电视剧
};

export class RankAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * 获取排行榜
   * @param {Object} params
   * @param {number} [params.rid=0] - 分区ID，0=全站
   * @param {string} [params.type='all'] - 类型: all/origin/rookie
   * @returns {Promise<Object>} 排行榜数据
   */
  async getRanking({ rid = 0, type = 'all' } = {}) {
    const res = await this.client.get(
      'https://api.bilibili.com/x/web-interface/ranking/v2',
      { rid: String(rid), type }
    );
    const list = res.data?.data?.list || [];
    return {
      list: list.map((v, i) => ({
        rank: i + 1,
        aid: v.aid,
        bvid: v.bvid,
        title: v.title,
        desc: v.desc,
        ownerMid: v.owner?.mid,
        ownerName: v.owner?.name,
        ownerFace: v.owner?.face,
        pic: v.pic,
        pubdate: v.pubdate,
        duration: v.duration,
        view: v.stat?.view || 0,
        danmaku: v.stat?.danmaku || 0,
        reply: v.stat?.reply || 0,
        favorite: v.stat?.favorite || 0,
        coin: v.stat?.coin || 0,
        share: v.stat?.share || 0,
        like: v.stat?.like || 0,
        score: v.score || 0,
        raw: v,
      })),
      note: res.data?.data?.note || '',
    };
  }

  /**
   * 获取视频详细信息（补全投币/点赞/收藏等）
   * @param {string} bvid - BV号
   */
  async getVideoDetail(bvid) {
    return this.client.get('https://api.bilibili.com/x/web-interface/view', { bvid });
  }

  /**
   * 获取UP主信息
   * @param {string|number} mid - 用户mid
   */
  async getUpperInfo(mid) {
    return this.client.get('https://api.bilibili.com/x/space/acc/info', { mid: String(mid) });
  }

  /**
   * 获取热门视频（综合热门）
   * @param {Object} params
   * @param {number} [params.pn=1] - 页码
   * @param {number} [params.ps=20] - 每页数量
   */
  async getPopular({ pn = 1, ps = 20 } = {}) {
    return this.client.get('https://api.bilibili.com/x/web-interface/popular', {
      pn: String(pn), ps: String(ps),
    });
  }

  /** 获取所有分区列表 */
  static getRegionList() {
    return Object.entries(BILI_RID).map(([key, rid]) => ({ key, rid }));
  }
}

export default RankAPI;
