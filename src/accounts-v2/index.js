/**
 * accounts-v2 模块导出
 *
 * 面向对象账号系统 v2
 *
 * 架构：
 * Account              - 账号实体类（数据模型+状态+健康度）
 * BiliAuthAPI          - B站认证API抽象层（所有API集中管理）
 * CookieRefresher      - Cookie刷新引擎（完整6步流程）
 * AccountHealthMonitor - 健康度评分系统（5维度+预测+预警）
 * AccountManagerV2     - 账号管理器（CRUD+批量刷新+状态机+事件）
 * constants            - 常量配置（API端点/RSA公钥/状态枚举）
 *
 * 使用示例：
 * import { AccountManagerV2, Account, CookieRefresher } from './accounts-v2/index.js';
 *
 * const manager = AccountManagerV2.getInstance();
 * const account = manager.add({ phone: '138xxxx', remark: '主号' });
 * const result = await manager.refreshAccount(account.id);
 */

export { Account } from './Account.js';
export { BiliAuthAPI } from './BiliAuthAPI.js';
export { CookieRefresher } from './CookieRefresher.js';
export { AccountHealthMonitor } from './AccountHealthMonitor.js';
export { AccountManagerV2 } from './AccountManagerV2.js';
export * as Constants from './constants.js';
export { default } from './AccountManagerV2.js';
