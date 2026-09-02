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
 *
 * v3.1 修复：原 `export {X} from` 不创建局部名，导致 default 导出对象
 * 引用未定义变量（"BiliClient is not defined"）。改为 import 后再导出。
 */
import { BiliClient } from './BiliClient.js';
import { WbiSigner } from './WbiSigner.js';
import { CommentAPI, COMMENT_ACTION, COMMENT_MODE } from './CommentAPI.js';
import { VideoAPI } from './VideoAPI.js';
import { UserAPI } from './UserAPI.js';
import { BehaviorSimulator } from './BehaviorSimulator.js';

export {
  BiliClient, WbiSigner,
  CommentAPI, COMMENT_ACTION, COMMENT_MODE,
  VideoAPI, UserAPI, BehaviorSimulator,
};

export default {
  BiliClient,
  WbiSigner,
  CommentAPI,
  VideoAPI,
  UserAPI,
  BehaviorSimulator,
};
