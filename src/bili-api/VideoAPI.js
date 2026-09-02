/**
 * VideoAPI - B站视频API
 *
 * 职责：
 * - 获取视频信息（标题、UP主、发布时间）
 * - 获取用户所有视频（用于监控轮询）
 * - BV号/AV号转换
 * - 视频播放量、弹幕数等统计
 *
 * 关键突破点：
 * - 获取用户所有视频列表，用于"监控某账号下所有视频的评论"
 * - 获取UP主mid，用于独立运营策略
 */
import { BiliClient } from './BiliClient.js';

// BV号转AV号的对照表（X=10进制）
const BV_TABLE = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF';
const BV_TR = {};
for (let i = 0; i < BV_TABLE.length; i++) BV_TR[BV_TABLE[i]] = i;
const BV_S = [11, 10, 3, 8, 4, 6];
const BV_XOR = 177451812;
const BV_ADD = 8728348608;

export class VideoAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * BV号转AV号
   */
  static bvToAv(bv) {
    bv = bv.replace('BV', '');
    let r = 0;
    for (let i = 0; i < 6; i++) {
      r += BV_TR[bv[BV_S[i]]] * Math.pow(58, i);
    }
    return (r - BV_ADD) ^ BV_XOR;
  }

  /**
   * AV号转BV号
   */
  static avToBv(av) {
    av = (av ^ BV_XOR) + BV_ADD;
    const r = 'BV1  4 1 7  '.split('');
    for (let i = 0; i < 6; i++) {
      r[BV_S[i]] = BV_TABLE[Math.floor(av / Math.pow(58, i)) % 58];
    }
    return r.join('');
  }

  /**
   * 获取视频信息
   * GET /x/web-interface/view
   * @param {string} bvid - BV号
   */
  async getInfo(bvid) {
    const res = await this.client.get('https://api.bilibili.com/x/web-interface/view', { bvid });
    const d = res.data.data || {};
    return {
      aid: d.aid,
      bvid: d.bvid,
      title: d.title,
      desc: d.desc,
      ownerMid: d.owner?.mid,
      ownerName: d.owner?.name,
      pubdate: d.pubdate,
      duration: d.duration,
      viewCount: d.stat?.view,
      danmakuCount: d.stat?.danmaku,
      replyCount: d.stat?.reply,
      likeCount: d.stat?.like,
      coinCount: d.stat?.coin,
      favoriteCount: d.stat?.favorite,
      shareCount: d.stat?.share,
      raw: d,
    };
  }

  /**
   * 获取用户所有视频（用于监控轮询）
   * GET /x/space/wbi/arc/search
   * @param {string|number} mid - 用户mid
   * @param {number} pageSize - 每页数量
   * @param {number} maxPages - 最大页数
   */
  async getUserVideos(mid, pageSize = 30, maxPages = 3) {
    const allVideos = [];
    for (let page = 1; page <= maxPages; page++) {
      const params = {
        mid: String(mid),
        ps: String(pageSize),
        pn: String(page),
        order: 'pubdate',
        platform: 'web',
        web_location: '1550101',
      };
      try {
        const res = await this.client.get(
          'https://api.bilibili.com/x/space/wbi/arc/search',
          params,
          { needWbiSign: true }
        );
        const list = res.data.data?.list?.vlist || [];
        allVideos.push(...list);
        const pageInfo = res.data.data?.page || {};
        if (page * pageSize >= (pageInfo.count || 0)) break;
      } catch (e) {
        // WBI签名可能失败，尝试无签名
        try {
          const res = await this.client.get(
            'https://api.bilibili.com/x/space/arc/search',
            { mid: String(mid), ps: String(pageSize), pn: String(page) }
          );
          const list = res.data.data?.list?.vlist || [];
          allVideos.push(...list);
        } catch (e2) {
          break;
        }
      }
    }
    return allVideos.map(v => ({
      aid: v.aid,
      bvid: v.bvid,
      title: v.title,
      description: v.description,
      pubdate: v.created,
      length: v.length,
      playCount: v.play,
      commentCount: v.comment,
      isUnifiedVideo: v.is_unified_video,
      raw: v,
    }));
  }

  /**
   * 获取用户最新视频
   */
  async getLatestVideo(mid) {
    const videos = await this.getUserVideos(mid, 1, 1);
    return videos[0] || null;
  }

  /**
   * 搜索视频（热度追踪核心）
   * GET /x/web-interface/search/type
   * @param {Object} opts
   * @param {string} opts.keyword - 关键词
   * @param {string} [opts.order] - 排序: totalrank(综合)/click(播放)/pubdate(最新)/dm(弹幕)/stow(收藏)
   * @param {number} [opts.page] - 页码
   * @param {number} [opts.pageSize] - 每页数量
   * @param {number} [opts.duration] - 时长: 0全部/1<10min/2 10-30min/3 30-60min/4 >60min
   */
  async search({ keyword, order = 'totalrank', page = 1, pageSize = 20, duration = 0 }) {
    const data = await this.client.get('https://api.bilibili.com/x/web-interface/search/type', {
      search_type: 'video', keyword, order, page, page_size: pageSize, duration,
    });
    if (data.code !== 0) throw new Error(`搜索失败: ${data.message}`);
    const result = data.data || {};
    return {
      total: result.numResults || 0,
      page: result.page || page,
      pageSize: result.pageSize || pageSize,
      videos: (result.result || []).map(v => ({
        aid: v.aid, bvid: v.bvid, title: (v.title || '').replace(/<[^>]+>/g, ''),
        description: (v.description || '').replace(/<[^>]+>/g, ''),
        author: v.author, mid: v.mid,
        playCount: v.play, danmaku: v.video_review, commentCount: v.review,
        pubdate: v.pubdate, duration: v.duration,
        tags: v.tag ? v.tag.split(',') : [],
        pic: v.pic,
        raw: v,
      })),
    };
  }

  /**
   * 获取热门视频（综合热门）
   * GET /x/web-interface/popular
   */
  async getPopular({ pn = 1, ps = 20 } = {}) {
    const data = await this.client.get('https://api.bilibili.com/x/web-interface/popular', { pn, ps });
    if (data.code !== 0) throw new Error(`获取热门失败: ${data.message}`);
    return (data.data?.list || []).map(v => ({
      aid: v.aid, bvid: v.bvid, title: v.title, desc: v.desc,
      owner: v.owner?.name, mid: v.owner?.mid,
      stat: v.stat, pubdate: v.pubdate, tags: (v.tname || '').split(','),
      pic: v.pic, raw: v,
    }));
  }

  /**
   * 获取排行榜
   * GET /x/web-interface/ranking/v2
   * @param {number} rid - 分区ID，0=全部分区
   * @param {string} type - all/origin/rookie
   */
  async getRanking({ rid = 0, type = 'all' } = {}) {
    const data = await this.client.get('https://api.bilibili.com/x/web-interface/ranking/v2', { rid, type });
    if (data.code !== 0) throw new Error(`获取排行失败: ${data.message}`);
    return (data.data?.list || []).map(v => ({
      aid: v.aid, bvid: v.bvid, title: v.title, desc: v.desc,
      owner: v.owner?.name, mid: v.owner?.mid,
      stat: v.stat, pubdate: v.pubdate, tags: (v.tname || '').split(','),
      pic: v.pic, raw: v,
    }));
  }

  /**
   * 获取视频TAG
   * GET /x/tag/archive/tags
   */
  async getTags({ aid, bvid }) {
    const params = bvid ? { bvid } : { aid };
    const data = await this.client.get('https://api.bilibili.com/x/tag/archive/tags', params);
    if (data.code !== 0) throw new Error(`获取TAG失败: ${data.message}`);
    return (data.data || []).map(t => ({
      tagId: t.tag_id, tagName: t.tag_name, count: t.count, type: t.type,
    }));
  }
}

export default VideoAPI;
