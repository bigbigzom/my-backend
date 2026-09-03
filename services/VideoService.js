/**
 * 视频服务（v4.0 OOP重构）
 *
 * 封装 VideoAPI，提供视频信息查询、用户视频列表、搜索等功能。
 */
import { BiliClient, VideoAPI } from '../src/bili-api/index.js';

export class VideoService {
  constructor({ accountService }) {
    this.accountService = accountService;
  }

  _createClient(account) {
    return new BiliClient({ cookieStr: account.cookieStr, csrf: account.csrf, proxy: account.proxy });
  }

  async _resolveAccount(accountId) {
    const account = this.accountService.get(accountId);
    if (!account) throw new Error('账号不存在');
    const result = await this.accountService.resolveProxy(accountId);
    if (result.skipped) throw new Error(result.reason || '账号IP不可用，已跳过');
    return account;
  }

  /** 获取视频信息 */
  async getInfo({ accountId, bvid, aid }) {
    const account = await this._resolveAccount(accountId);
    const client = this._createClient(account);
    const videoApi = new VideoAPI(client);
    return videoApi.getInfo({ bvid, aid });
  }

  /** 获取UP主视频列表 */
  async getUpperVideos({ accountId, mid, pn = 1, ps = 30, order = 'pubdate' }) {
    const account = await this._resolveAccount(accountId);
    const client = this._createClient(account);
    const videoApi = new VideoAPI(client);
    return videoApi.getUpperVideos({ mid, pn, ps, order });
  }

  /**
   * 搜索视频（热度追踪核心功能）
   * 调用B站搜索API：/x/web-interface/search/type
   */
  async searchVideos({ accountId, keyword, order = 'totalrank', page = 1, pageSize = 20, duration = 0 }) {
    const account = await this._resolveAccount(accountId);
    const client = this._createClient(account);
    const videoApi = new VideoAPI(client);
    return videoApi.search({ keyword, order, page, pageSize, duration });
  }

  /** 获取视频TAG列表 */
  async getVideoTags({ accountId, aid, bvid }) {
    const account = await this._resolveAccount(accountId);
    const client = this._createClient(account);
    const videoApi = new VideoAPI(client);
    return videoApi.getTags({ aid, bvid });
  }

  /** BV转AV */
  bvToAv(bvid) {
    return VideoAPI.bvToAv(bvid);
  }
}

export default VideoService;
