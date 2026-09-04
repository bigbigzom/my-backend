/**
 * ReportAPI - B站举报接口封装（v7.1 新增）
 *
 * 只封装B站举报相关API，不包含业务逻辑。
 * 被 ReportService 调用。
 *
 * 接口参考：
 * - 视频举报: POST /x/v2/report/add
 * - 账号举报: POST /x/v2/account/report
 * - 评论举报: POST /x/v2/reply/report
 * - 弹幕举报: POST /x/dm/report/add
 */

// 举报原因枚举（B站官方reason code）
export const REPORT_REASONS = {
  ILLEGAL: { code: 1, label: '违法违禁' },
  PORNOGRAPHY: { code: 2, label: '色情低俗' },
  GAMBLING_FRAUD: { code: 3, label: '赌博诈骗' },
  PERSONAL_ATTACK: { code: 4, label: '人身攻击' },
  PRIVACY: { code: 5, label: '侵犯隐私' },
  SPAM_AD: { code: 6, label: '垃圾广告' },
  FLAME: { code: 7, label: '引战' },
  SPOILER: { code: 8, label: '剧透' },
  POLITICAL: { code: 9, label: '政治敏感' },
  OTHER: { code: 10, label: '其他' },
};

export class ReportAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * 举报视频
   * @param {Object} params
   * @param {string|number} params.aid - 视频aid
   * @param {number} params.reason - 举报原因code (1-10)
   * @param {string} [params.desc] - 详细描述
   */
  async reportVideo({ aid, reason, desc = '' }) {
    const data = {
      aid: String(aid),
      reason: String(reason),
      ...(desc && { describe: desc }),
    };
    return this.client.postForm('https://api.bilibili.com/x/v2/report/add', data);
  }

  /**
   * 举报账号（用户）
   * @param {Object} params
   * @param {string|number} params.mid - 用户mid
   * @param {number} params.reason - 举报原因code
   * @param {string} [params.desc] - 详细描述
   */
  async reportUser({ mid, reason, desc = '' }) {
    const data = {
      mid: String(mid),
      reason: String(reason),
      ...(desc && { describe: desc }),
    };
    return this.client.postForm('https://api.bilibili.com/x/v2/account/report', data);
  }

  /**
   * 举报评论
   * @param {Object} params
   * @param {string|number} params.rpid - 评论rpid
   * @param {string|number} params.oid - 视频oid
   * @param {number} params.type - 类型(1=视频)
   * @param {number} params.reason - 举报原因code
   * @param {string} [params.desc] - 详细描述
   */
  async reportComment({ rpid, oid, type = 1, reason, desc = '' }) {
    const data = {
      rpid: String(rpid),
      oid: String(oid),
      type: String(type),
      reason: String(reason),
      ...(desc && { describe: desc }),
    };
    return this.client.postForm('https://api.bilibili.com/x/v2/reply/report', data);
  }

  /**
   * 举报弹幕
   * @param {Object} params
   * @param {string|number} params.dmid - 弹幕dmid
   * @param {string|number} params.cid - 视频cid
   * @param {number} params.reason - 举报原因code
   * @param {string} [params.desc] - 详细描述
   */
  async reportDanmaku({ dmid, cid, reason, desc = '' }) {
    const data = {
      dmid: String(dmid),
      cid: String(cid),
      reason: String(reason),
      ...(desc && { describe: desc }),
    };
    return this.client.postForm('https://api.bilibili.com/x/dm/report/add', data);
  }

  /** 获取所有举报原因列表 */
  static getReasonList() {
    return Object.entries(REPORT_REASONS).map(([key, val]) => ({
      key, code: val.code, label: val.label,
    }));
  }
}

export default ReportAPI;
