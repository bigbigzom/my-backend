/**
 * VideoService（v6.0 重构版）
 *
 * 封装 VideoAPI，提供视频信息查询、用户视频列表、搜索等功能。
 * 修复：方法名与VideoAPI对齐，补全userAgent/deviceProfile，添加日志。
 */
import { BiliClient, VideoAPI } from '../src/bili-api/index.js';

export class VideoService {
  constructor({ accountService }) {
    this.accountService = accountService;
  }

  _createClient(account) {
    return new BiliClient({
      cookieStr: account.cookieStr,
      csrf: account.csrf,
      proxy: account.proxy,
      userAgent: account.userAgent || undefined,
      deviceProfile: account.deviceProfile || account.deviceEnv || null,
    });
  }

  async _resolveAccount(accountId) {
    const account = this.accountService.get(accountId);
    if (!account) throw new Error(`账号不存在: ${accountId}`);
    const result = await this.accountService.resolveProxy(accountId);
    if (result.skipped) throw new Error(result.reason || '账号IP不可用');
    console.log(`[VideoService] 账号 uid=${account.uid} 绑定IP: ${account.proxy}`);
    return account;
  }

  /** 获取视频信息（v6.0修复：VideoAPI.getInfo接收bvid位置参数） */
  async getInfo({ accountId, bvid, aid }) {
    const account = await this._resolveAccount(accountId);
    const client = this._createClient(account);
    const videoApi = new VideoAPI(client);
    return videoApi.getInfo(bvid);
  }

  /** 获取UP主视频列表（v6.0修复：方法名getUserVideos） */
  async getUpperVideos({ accountId, mid, pn = 1, ps = 30, order = 'pubdate' }) {
    const account = await this._resolveAccount(accountId);
    const client = this._createClient(account);
    const videoApi = new VideoAPI(client);
    return videoApi.getUserVideos(mid, ps, Math.ceil(pn));
  }

  /** 搜索视频 */
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
  bvToAv(bvid) { return VideoAPI.bvToAv(bvid); }
}

export default VideoService;
