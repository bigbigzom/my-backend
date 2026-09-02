/**
 * UserAPI - B站用户API
 *
 * 职责：
 * - 获取用户信息（昵称、等级、关注数、粉丝数）
 * - 获取用户关系（关注/粉丝）
 * - 获取用户动态
 * - 关注/取关用户（独立运营策略用）
 */
import { BiliClient } from './BiliClient.js';

export class UserAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * 获取用户信息
   * GET /x/space/wbi/acc/info
   */
  async getInfo(mid) {
    const res = await this.client.get(
      'https://api.bilibili.com/x/space/wbi/acc/info',
      { mid: String(mid) },
      { needWbiSign: true }
    );
    const d = res.data.data || {};
    return {
      mid: d.mid,
      name: d.name,
      sex: d.sex,
      face: d.face,
      sign: d.sign,
      level: d.level,
      birthday: d.birthday,
      coins: d.coins,
      fansBadge: d.fans_badge,
      following: d.following,
      follower: d.follower,
      raw: d,
    };
  }

  /**
   * 获取当前登录用户信息（nav接口）
   */
  async getMyInfo() {
    const res = await this.client.get('https://api.bilibili.com/x/web-interface/nav');
    const d = res.data.data || {};
    return {
      isLogin: d.isLogin,
      mid: d.mid,
      uname: d.uname,
      face: d.face,
      level: d.level_info?.current_level,
      moral: d.moral,
      coins: d.money,
      raw: d,
    };
  }

  /**
   * 关注用户
   * POST /x/relation/modify
   * @param {string|number} mid - 目标用户mid
   * @param {number} act - 1=关注, 2=取消关注
   */
  async modifyRelation(mid, act = 1) {
    const data = {
      fid: String(mid),
      act: String(act),
      re_src: '11',
    };
    const res = await this.client.postForm('https://api.bilibili.com/x/relation/modify', data);
    return { success: res.data.code === 0, raw: res.data };
  }

  /** 关注用户 */
  async follow(mid) { return this.modifyRelation(mid, 1); }

  /** 取消关注 */
  async unfollow(mid) { return this.modifyRelation(mid, 2); }

  /**
   * 获取用户关注列表
   */
  async getFollowings(mid, pageSize = 50, page = 1) {
    const res = await this.client.get(
      'https://api.bilibili.com/x/relation/followings',
      { vmid: String(mid), ps: String(pageSize), pn: String(page), order: 'desc' }
    );
    return res.data.data?.list || [];
  }
}

export default UserAPI;
