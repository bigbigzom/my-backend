/**
 * CommentService（v6.0 彻底重构版）
 *
 * 评论操作服务，封装 BiliClient + CommentAPI。
 * 所有方法添加详细日志，参数与 CommentAPI 严格对齐。
 *
 * 修复历史问题：
 * - getCommentList 调用不存在的 commentApi.list() → 改为 getList()
 * - addReply 参数 rpid 未映射到 root → 修复
 * - checkCommentExists 调用不存在的 checkExists() → 改为 checkCommentExists(oid, rpid)
 * - _createClient 缺少 userAgent/deviceProfile → 补全
 */
import { BiliClient, CommentAPI, COMMENT_ACTION, COMMENT_MODE } from '../src/bili-api/index.js';

export class CommentService {
  constructor({ accountService }) {
    this.accountService = accountService;
  }

  /** 创建BiliClient（v6.0：补全userAgent和deviceProfile，降低风控） */
  _createClient(account) {
    return new BiliClient({
      cookieStr: account.cookieStr,
      csrf: account.csrf,
      proxy: account.proxy,
      userAgent: account.userAgent || undefined,
      deviceProfile: account.deviceProfile || account.deviceEnv || null,
    });
  }

  /**
   * 解析账号并绑定IP（注册IP优先→同地区回退→无则跳过）
   * @throws {Error} 账号不存在或IP不可用时抛出
   */
  async _resolveAccount(accountId) {
    const account = this.accountService.get(accountId);
    if (!account) {
      const err = new Error(`账号不存在: ${accountId}`);
      console.error(`[CommentService] ❌ ${err.message}`);
      throw err;
    }
    console.log(`[CommentService] 账号 uid=${account.uid} status=${account.status} isActive=${account.isActive} 开始解析IP...`);

    const result = await this.accountService.resolveProxy(accountId);
    if (result.skipped) {
      const err = new Error(`账号IP不可用: ${result.reason}`);
      console.error(`[CommentService] ❌ ${err.message}`);
      throw err;
    }
    console.log(`[CommentService] ✅ 账号 uid=${account.uid} 绑定IP: ${account.proxy || result.proxy}`);
    return account;
  }

  /** 发布评论（主账号策略） */
  async addComment({ accountId, oid, message, type = 1, mode = COMMENT_MODE.NORMAL }) {
    console.log(`[CommentService] 📝 发布评论 accountId=${accountId} oid=${oid} message=${message.substring(0, 30)}...`);
    const account = await this._resolveAccount(accountId);
    const client = this._createClient(account);
    const commentApi = new CommentAPI(client);
    const result = await commentApi.add({ oid, message, type, mode });
    console.log(`[CommentService] ${result.rpid ? '✅' : '❌'} 发布结果 rpid=${result.rpid || '无'} needCaptcha=${result.needCaptcha}`);
    return result;
  }

  /** 发布回复（楼中楼，子账号策略） */
  async addReply({ accountId, oid, rpid, message, type = 1 }) {
    console.log(`[CommentService] 💬 发布回复 accountId=${accountId} oid=${oid} rpid=${rpid}`);
    const account = await this._resolveAccount(accountId);
    const client = this._createClient(account);
    const commentApi = new CommentAPI(client);
    const result = await commentApi.reply({ oid, root: rpid, parent: rpid, message });
    console.log(`[CommentService] ${result.rpid ? '✅' : '❌'} 回复结果 rpid=${result.rpid || '无'}`);
    return result;
  }

  /** 评论操作（点赞/踩/举报等） */
  async replyAction({ accountId, oid, rpid, action }) {
    console.log(`[CommentService] ⚡ 评论操作 accountId=${accountId} oid=${oid} rpid=${rpid} action=${action}`);
    const account = await this._resolveAccount(accountId);
    const client = this._createClient(account);
    const commentApi = new CommentAPI(client);
    const result = await commentApi.action({ oid, rpid, action });
    console.log(`[CommentService] 操作完成`);
    return result;
  }

  /** 获取评论列表（v6.0修复：方法名getList，参数nextOffset） */
  async getCommentList({ accountId, oid, type = 1, next = 0, ps = 20 }) {
    console.log(`[CommentService] 📋 获取评论列表 accountId=${accountId} oid=${oid}`);
    const account = await this._resolveAccount(accountId);
    const client = this._createClient(account);
    const commentApi = new CommentAPI(client);
    return commentApi.getList({ oid, type, nextOffset: String(next || '') });
  }

  /** 检测评论是否存在（v6.0修复：方法名checkCommentExists，位置参数） */
  async checkCommentExists({ accountId, oid, rpid }) {
    console.log(`[CommentService] 🔍 检测评论 accountId=${accountId} oid=${oid} rpid=${rpid}`);
    const account = await this._resolveAccount(accountId);
    const client = this._createClient(account);
    const commentApi = new CommentAPI(client);
    return commentApi.checkCommentExists(oid, rpid);
  }

  /** 点赞评论 */
  async likeComment({ accountId, oid, rpid, type = 1 }) {
    return this.replyAction({ accountId, oid, rpid, action: COMMENT_ACTION.LIKE });
  }

  /**
   * 主次账号策略发布评论
   */
  async publishWithStrategy({ oid, mainMessage, subMessage, mainAccountId, subAccountId }) {
    console.log(`[CommentService] 🎯 主次账号策略发布 oid=${oid}`);
    const mainResult = await this.addComment({ accountId: mainAccountId, oid, message: mainMessage });
    if (!mainResult.rpid) {
      return { success: false, stage: 'main', error: mainResult.successToast || '主账号评论失败', needCaptcha: mainResult.needCaptcha };
    }

    if (subMessage && subAccountId) {
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
      const subResult = await this.addReply({
        accountId: subAccountId, oid, rpid: mainResult.rpid, message: subMessage,
      });
      return {
        success: !!subResult.rpid,
        stage: 'sub',
        mainRpid: mainResult.rpid,
        subResult,
        error: subResult.rpid ? null : '子账号回复失败',
      };
    }

    return { success: true, stage: 'main-only', mainRpid: mainResult.rpid };
  }
}

export default CommentService;
