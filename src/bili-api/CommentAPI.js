/**
 * CommentAPI - B站评论API
 *
 * 基于HAR数据包分析实现：
 * - POST /x/v2/reply/add - 发布评论（含need_captcha检测）
 * - POST /x/v2/reply/action - 评论操作（点赞/踩/举报）
 * - GET /x/v2/reply/wbi/main - 获取评论列表（WBI签名，mode=3热度排序）
 * - GET /x/v2/reply/subject/description - 评论区描述（含UP主ID）
 *
 * 关键突破点：
 * - need_captcha字段可检测是否需要验证码
 * - statistics参数是平台安全机制统计参数，需模拟真实值
 * - action=1点赞可用于推热度
 * - mode=3按热度排序可检测评论是否上热门
 */
import { BiliClient } from './BiliClient.js';

// 评论操作类型
export const COMMENT_ACTION = {
  LIKE: 1,       // 点赞
  DISLIKE: 2,    // 踩
  REPORT: 3,     // 举报
  CANCEL_LIKE: 0, // 取消点赞（action=0或重复1）
};

// 评论排序模式
export const COMMENT_MODE = {
  DEFAULT: 0,     // 默认
  HOT: 2,         // 按热度
  TIME: 3,        // 按时间（HAR中mode=3）
};

/**
 * GAIA 平台安全机制参数（v3.1 新增，对齐 HAR 中 /x/v2/reply/add 的完整参数）
 *
 * HAR 实测评论/点赞请求均携带：
 * - dm_img_list / dm_img_str / dm_cover_img_str / dm_img_inter（浏览器渲染指纹）
 * - web_location / gaia_source（来源标记）
 * - b_wet（行为令牌，可选，由 ExGetAxe 下发）
 *
 * 说明：非敏感操作可使用与官方格式一致的"空模板"；真实 canvas 指纹无法在
 * 纯服务端生成，需由浏览器内核（Playwright/Puppeteer）动态注入。此模板用于
 * 让请求参数结构与官方客户端一致，降低被机器检测标记的概率。
 */
export function buildGaiaParams(webLocation = '1315875') {
  return {
    dm_img_list: '[]',
    dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
    dm_cover_img_str: '',
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
    web_location: String(webLocation),
    gaia_source: 'main_web',
  };
}

export class CommentAPI {
  /**
   * @param {BiliClient} client - B站客户端
   */
  constructor(client) {
    this.client = client;
  }

  // ============================================================
  // 发布评论
  // ============================================================

  /**
   * 发布评论
   * POST /x/v2/reply/add
   *
   * @param {Object} params
   * @param {string|number} params.oid - 视频ID（av号或BV号对应的oid）
   * @param {string} params.message - 评论内容
   * @param {number} params.type - 类型（1=视频，11=相簿，12=专栏，14=音频）
   * @param {number} params.root - 根评论rpid（回复时传）
   * @param {number} params.parent - 父评论rpid（楼中楼回复时传）
   * @param {Object} params.atNameToMid - @用户映射
   * @returns {Promise<Object>} { rpid, needCaptcha, successToast, reply }
   */
  async add({ oid, message, type = 1, root = 0, parent = 0, atNameToMid = {}, gaia = true }) {
    const data = {
      plat: 1,
      oid: String(oid),
      type: String(type),
      message,
      at_name_to_mid: JSON.stringify(atNameToMid),
      gaia_source: 'main_web',
      // 平台安全机制统计参数（HAR中发现）
      statistics: JSON.stringify({ appId: 100, platform: 5 }),
    };
    // v3.1：GAIA 平台安全机制参数（对齐 HAR，降低 -352 概率）
    if (gaia !== false) {
      Object.assign(data, buildGaiaParams());
    }
    if (root) data.root = String(root);
    if (parent) data.parent = String(parent);

    const res = await this.client.postForm('https://api.bilibili.com/x/v2/reply/add', data);

    return {
      rpid: res.data.data?.rpid || res.data.data?.rpid_str || '',
      needCaptcha: res.data.data?.need_captcha === true,
      successToast: res.data.data?.success_toast || '',
      successAction: res.data.data?.success_action || 0,
      reply: res.data.data?.reply || null,
      raw: res.data,
    };
  }

  /**
   * 发布楼中楼回复
   * @param {Object} params { oid, root, parent, message }
   */
  async reply({ oid, root, parent, message }) {
    return this.add({
      oid,
      message,
      root,
      parent: parent || root,
    });
  }

  // ============================================================
  // 评论操作（点赞/踩/举报）
  // ============================================================

  /**
   * 评论操作（点赞/踩/举报）
   * POST /x/v2/reply/action
   *
   * @param {Object} params
   * @param {string|number} params.oid - 视频ID
   * @param {string|number} params.rpid - 评论rpid
   * @param {number} params.action - 操作类型（COMMENT_ACTION）
   * @param {number} params.type - 类型（默认1）
   */
  async action({ oid, rpid, action = COMMENT_ACTION.LIKE, type = 1, gaia = true }) {
    const data = {
      oid: String(oid),
      type: String(type),
      rpid: String(rpid),
      action: String(action),
      statistics: JSON.stringify({ appId: 100, platform: 5 }),
    };
    // v3.1：GAIA 平台安全机制参数
    if (gaia !== false) {
      Object.assign(data, buildGaiaParams());
    }
    const res = await this.client.postForm('https://api.bilibili.com/x/v2/reply/action', data);
    return {
      success: res.data.code === 0,
      isFoldedReply: res.data.data?.is_folded_reply === true,
      raw: res.data,
    };
  }

  /** 点赞评论 */
  async like(oid, rpid) {
    return this.action({ oid, rpid, action: COMMENT_ACTION.LIKE });
  }

  // ============================================================
  // 获取评论列表
  // ============================================================

  /**
   * 获取评论列表
   * GET /x/v2/reply/wbi/main（需要WBI签名）
   *
   * @param {Object} params
   * @param {string|number} params.oid - 视频ID
   * @param {number} params.mode - 排序模式（COMMENT_MODE）
   * @param {string} params.nextOffset - 下一页偏移
   * @param {number} params.type - 类型
   * @returns {Promise<Object>} { replies, cursor, hasMore, topReplies }
   */
  async getList({ oid, mode = COMMENT_MODE.TIME, nextOffset = '', type = 1 }) {
    const params = {
      oid: String(oid),
      type: String(type),
      mode: String(mode),
      pagination_str: JSON.stringify({ offset: nextOffset }),
      plat: '1',
      seek_rpid: '',
      web_location: '1315875',
    };
    const res = await this.client.get(
      'https://api.bilibili.com/x/v2/reply/wbi/main',
      params,
      { needWbiSign: true }
    );

    const data = res.data.data || {};
    return {
      replies: data.replies || [],
      topReplies: data.top_replies || [],
      cursor: data.cursor || {},
      hasMore: data.cursor?.is_end === false,
      nextOffset: data.cursor?.pagination_reply?.next_offset || '',
      raw: data,
    };
  }

  /**
   * 获取热门评论（mode=2）
   */
  async getHotList(oid, type = 1) {
    return this.getList({ oid, mode: COMMENT_MODE.HOT, type });
  }

  // ============================================================
  // 评论区描述（含UP主ID）
  // ============================================================

  /**
   * 获取评论区描述
   * GET /x/v2/reply/subject/description
   *
   * @param {string|number} oid - 视频ID
   * @param {number} type - 类型
   * @returns {Promise<Object>} { count, upMid, inputText, supportFilterTags }
   */
  async getSubjectDescription(oid, type = 1) {
    const params = {
      oid: String(oid),
      type: String(type),
      web_location: '333.788',
    };
    const res = await this.client.get(
      'https://api.bilibili.com/x/v2/reply/subject/description',
      params
    );
    const base = res.data.data?.base || {};
    return {
      count: base.count || 0,
      upMid: base.up_mid || '',
      inputText: base.input || '',
      supportFilterTags: base.support_filter_tags || [],
      raw: res.data.data,
    };
  }

  // ============================================================
  // 评论存在性检测（监控用）
  // ============================================================

  /**
   * 检测评论是否存在（通过rpid搜索）
   * @param {string|number} oid - 视频ID
   * @param {string|number} rpid - 评论rpid
   * @returns {Promise<Object>} { exists, comment, isTop, likeCount }
   */
  async checkCommentExists(oid, rpid) {
    try {
      // 先获取热门评论
      const hot = await this.getHotList(oid);
      const allReplies = [...(hot.topReplies || []), ...(hot.replies || [])];

      // 查找目标评论
      const found = allReplies.find(r => String(r.rpid) === String(rpid) || String(r.rpid_str) === String(rpid));

      if (found) {
        return {
          exists: true,
          comment: found,
          isTop: hot.topReplies?.some(r => String(r.rpid) === String(rpid)),
          likeCount: found.like || 0,
          replyCount: found.rcount || 0,
        };
      }

      // 如果热门列表没找到，翻页查找（最多翻3页）
      let nextOffset = hot.nextOffset;
      for (let page = 0; page < 3 && nextOffset; page++) {
        const list = await this.getList({ oid, nextOffset });
        const found2 = list.replies?.find(r => String(r.rpid) === String(rpid));
        if (found2) {
          return { exists: true, comment: found2, isTop: false, likeCount: found2.like || 0 };
        }
        nextOffset = list.nextOffset;
        if (!list.hasMore) break;
      }

      return { exists: false, comment: null, isTop: false, likeCount: 0 };
    } catch (e) {
      // API错误可能是因为评论被删导致接口异常
      if (e.code === 12001 || e.message?.includes('评论')) {
        return { exists: false, comment: null, error: e.message };
      }
      throw e;
    }
  }

  /**
   * 检测用户在某视频下的所有评论
   * @param {string|number} oid - 视频ID
   * @param {string|number} mid - 用户mid
   * @returns {Promise<Array>} 评论列表
   */
  async findUserComments(oid, mid, maxPages = 5) {
    const userComments = [];
    let nextOffset = '';

    for (let page = 0; page < maxPages; page++) {
      const list = await this.getList({ oid, nextOffset });
      const found = (list.replies || []).filter(r => String(r.mid) === String(mid));
      userComments.push(...found);

      // 也检查楼中楼
      for (const r of list.replies || []) {
        if (r.replies) {
          const subFound = r.replies.filter(sr => String(sr.mid) === String(mid));
          userComments.push(...subFound);
        }
      }

      nextOffset = list.nextOffset;
      if (!list.hasMore) break;
    }

    return userComments;
  }
}

export default CommentAPI;
