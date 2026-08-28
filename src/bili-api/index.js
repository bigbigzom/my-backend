/**
 * bili-api 模块导出
 *
 * 面向对象B站API模块，基于HAR数据包分析实现。
 *
 * 架构：
 * BiliClient          - 基础客户端（请求封装、限流、WBI签名注入）
 *   ├─ WbiSigner      - WBI签名生成器
 *   ├─ CommentAPI     - 评论API（发布/回复/点赞/列表/检测）
 *   ├─ VideoAPI       - 视频API（信息/用户视频列表/BV-AV转换）
 *   ├─ UserAPI        - 用户API（信息/关注/粉丝）
 *   └─ BehaviorSimulator - 行为模拟器（养号/埋点上报）
 *
 * 使用示例：
 * import { BiliClient, CommentAPI, VideoAPI } from './bili-api/index.js';
 *
 * const client = new BiliClient({ cookieStr: '...', csrf: '...' });
 * const commentApi = new CommentAPI(client);
 * const result = await commentApi.add({ oid: '123', message: '测试' });
 */

export { BiliClient } from './BiliClient.js';
export { WbiSigner } from './WbiSigner.js';
export { CommentAPI, COMMENT_ACTION, COMMENT_MODE } from './CommentAPI.js';
export { VideoAPI } from './VideoAPI.js';
export { UserAPI } from './UserAPI.js';
export { BehaviorSimulator } from './BehaviorSimulator.js';

export default {
  BiliClient,
  WbiSigner,
  CommentAPI,
  VideoAPI,
  UserAPI,
  BehaviorSimulator,
};
