/**
 * 评论服务（v4.0 OOP重构）
 *
 * 封装 BiliClient + CommentAPI，提供评论操作接口。
 * 支持主次账号策略发布。
 */
import { BiliClient, CommentAPI, COMMENT_ACTION, COMMENT_MODE } from '../src/bili-api/index.js';

export class CommentService {
  constructor({ accountService }) {
    this.accountService = accountService;
  }

  _createClient(account) {
    return new BiliClient({
      cookieStr: account.cookieStr,
      csrf: account.csrf,
      proxy: account.proxy,
    });
  }

  /** 发布评论（主账号策略） */
  async addComment({ accountId, oid, message, type = 1, mode = COMMENT_MODE.NORMAL }) {
    const account = this.accountService.get(accountId);
    if (!account) throw new Error('账号不存在');
    const client = this._createClient(account);
    const commentApi = new CommentAPI(client);
    return commentApi.add({ oid, message, type, mode });
  }

  /** 发布回复（子账号策略） */
  async addReply({ accountId, oid, rpid, message, type = 1 }) {
    const account = this.accountService.get(accountId);
    if (!account) throw new Error('账号不存在');
    const client = this._createClient(account);
    const commentApi = new CommentAPI(client);
    return commentApi.reply({ oid, rpid, message, type });
  }

  /** 评论操作（点赞/举报等） */
  async replyAction({ accountId, oid, rpid, action }) {
    const account = this.accountService.get(accountId);
    if (!account) throw new Error('账号不存在');
    const client = this._createClient(account);
    const commentApi = new CommentAPI(client);
    return commentApi.action({ oid, rpid, action });
  }

  /** 获取评论列表 */
  async getCommentList({ accountId, oid, type = 1, next = 0, ps = 20 }) {
    const account = this.accountService.get(accountId);
    if (!account) throw new Error('账号不存在');
    const client = this._createClient(account);
    const commentApi = new CommentAPI(client);
    return commentApi.list({ oid, type, next, ps });
  }

  /** 检测评论是否存在 */
  async checkCommentExists({ accountId, oid, rpid, message }) {
    const account = this.accountService.get(accountId);
    if (!account) throw new Error('账号不存在');
    const client = this._createClient(account);
    const commentApi = new CommentAPI(client);
    return commentApi.checkExists({ oid, rpid, message });
  }

  /** 点赞评论 */
  async likeComment({ accountId, oid, rpid, type = 1 }) {
    return this.replyAction({ accountId, oid, rpid, action: COMMENT_ACTION.LIKE });
  }

  /**
   * 主次账号策略发布评论
   * @param {Object} opts
   * @param {string} opts.oid - 视频AV号
   * @param {string} opts.mainMessage - 主账号评论内容
   * @param {string} opts.subMessage - 子账号回复内容
   * @param {string} opts.mainAccountId - 主账号ID
   * @param {string} [opts.subAccountId] - 子账号ID（可选，自动选择）
   */
  async publishWithStrategy({ oid, mainMessage, subMessage, mainAccountId, subAccountId }) {
    // 主账号发评论
    const mainResult = await this.addComment({ accountId: mainAccountId, oid, message: mainMessage });
    if (!mainResult.success || !mainResult.rpid) {
      return { success: false, stage: 'main', error: mainResult.message || '主账号评论失败' };
    }

    // 子账号回复
    if (subMessage && subAccountId) {
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
      const subResult = await this.addReply({
        accountId: subAccountId, oid, rpid: mainResult.rpid, message: subMessage,
      });
      return {
        success: subResult.success,
        stage: 'sub',
        mainRpid: mainResult.rpid,
        subResult,
        error: subResult.success ? null : (subResult.message || '子账号回复失败'),
      };
    }

    return { success: true, stage: 'main-only', mainRpid: mainResult.rpid };
  }
}

export default CommentService;
