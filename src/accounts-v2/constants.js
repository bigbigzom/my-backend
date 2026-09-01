/**
 * 账号系统 v2 - 常量配置
 *
 * 所有B站API端点、加密密钥、状态枚举、超时配置集中管理。
 * API变更只需修改此文件，不需要改动业务逻辑。
 *
 * 设计原则：
 * - API端点集中：B站接口调整只需改这里
 * - 状态枚举化：避免魔法字符串
 * - 超时可配置：不同环境不同阈值
 */

// ============================================================
// B站 API 端点（认证相关）
// ============================================================
export const BILI_API = {
  // 登录态验证
  NAV: 'https://api.bilibili.com/x/web-interface/nav',

  // Cookie 刷新流程（6步）
  COOKIE_INFO: 'https://passport.bilibili.com/x/passport-login/web/cookie/info',
  CORRESPOND: 'https://www.bilibili.com/correspond/1/',
  COOKIE_REFRESH: 'https://passport.bilibili.com/x/passport-login/web/cookie/refresh',
  CONFIRM_REFRESH: 'https://passport.bilibili.com/x/passport-login/web/confirm/refresh',

  // 短信登录
  SEND_SMS: 'https://passport.bilibili.com/x/passport-login/web/sms/send',
  SMS_LOGIN: 'https://passport.bilibili.com/x/passport-login/web/login/sms',

  // 登录页
  LOGIN_PAGE: 'https://passport.bilibili.com/login',
};

// ============================================================
// B站 RSA 公钥（用于生成 CorrespondPath）
// 来源：bilibili-API-collect 官方文档
// ============================================================
export const BILI_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;

// ============================================================
// Cookie 字段名（完整列表，不能只存 SESSDATA）
// ============================================================
export const COOKIE_FIELDS = {
  // 核心登录态
  SESSDATA: 'SESSDATA',           // 主会话凭证（JWT，含uid/exp/sign）
  BILI_JCT: 'bili_jct',           // CSRF Token（写操作必需）
  DEDE_USER_ID: 'DedeUserID',     // 用户ID明文
  DEDE_USER_ID_CKMD5: 'DedeUserID__ckMd5', // 信任设备标记（免验证码关键）
  SID: 'sid',                      // 会话ID

  // 刷新令牌
  REFRESH_TOKEN: 'refresh_token',  // Cookie中的refresh_token（可能不存在）
  // 注意：真正的刷新令牌在 localStorage 的 ac_time_value 中

  // 设备指纹
  BUVID3: 'buvid3',                // 浏览器设备指纹
  BUVID4: 'buvid4',                // 扩展设备指纹
  UUID: '_uuid',                   // 设备UUID

  // 其他
  AC_TIME_VALUE: 'ac_time_value',  // localStorage中的刷新令牌（关键！）
};

// ============================================================
// 账号状态枚举（状态机）
// ============================================================
export const ACCOUNT_STATUS = {
  NEW: 'new',                    // 新建，未登录
  LOGGING_IN: 'logging_in',      // 正在登录
  ACTIVE: 'active',              // 正常活跃
  NEEDS_REFRESH: 'needs_refresh', // 需要刷新Cookie
  REFRESHING: 'refreshing',      // 正在刷新
  REFRESH_FAILED: 'refresh_failed', // 刷新失败
  NEEDS_RELOGIN: 'needs_relogin', // 需要重新登录
  RISK_DETECTED: 'risk_detected', // 检测到平台安全机制
  COOLED_DOWN: 'cooled_down',    // 平台安全机制冷却中
  BANNED: 'banned',              // 已账号受限
  TERMINATED: 'terminated',      // 已终止（需换号）
};

// ============================================================
// 预警级别枚举
// ============================================================
export const ALERT_LEVEL = {
  NORMAL: 'normal',       // 正常（健康度>80，剩余>14天）
  ATTENTION: 'attention', // 关注（健康度60-80，剩余7-14天）
  WARNING: 'warning',     // 预警（健康度40-60，剩余3-7天）
  CRITICAL: 'critical',   // 紧急（健康度<40，剩余<3天）
  EXPIRED: 'expired',     // 已失效
};

// ============================================================
// 健康度评分权重（5维度，总和100）
// ============================================================
export const HEALTH_WEIGHTS = {
  SESSDATA_AGE: 30,       // SESSDATA年龄
  LAST_ACTIVE: 20,        // 最后活跃时间
  OPERATION_FREQUENCY: 20, // 操作频率
  RISK_EVENTS: 20,        // 安全事件
  REFRESH_TOKEN: 10,      // refresh_token有效性
};

// ============================================================
// 超时与间隔配置（毫秒）
// ============================================================
export const TIMEOUTS = {
  API_REQUEST: 15000,          // API请求超时
  LOGIN_WAIT: 5 * 60 * 1000,  // 登录等待超时（5分钟）
  REFRESH_STEP: 10000,         // 刷新单步超时
  PROXY_WAIT: 30000,           // 代理等待超时
};

export const INTERVALS = {
  HEALTH_CHECK: 6 * 60 * 60 * 1000,  // 健康度检查间隔（6小时）
  LOGIN_BETWEEN: { min: 5 * 60 * 1000, max: 15 * 60 * 1000 }, // 账号间登录间隔（5-15分钟）
  REFRESH_COOLDOWN: 1 * 60 * 60 * 1000, // 刷新冷却（1小时内不重复刷新）
};

// ============================================================
// Cookie 有效期阈值（毫秒）
// ============================================================
export const COOKIE_TTL = {
  DEFAULT: 30 * 24 * 60 * 60 * 1000,  // 默认30天
  SHORT: 72 * 60 * 60 * 1000,          // 平台安全机制缩短至72小时
  INACTIVE_EXPIRE: 7 * 24 * 60 * 60 * 1000, // 7天未活跃过期
  REFRESH_THRESHOLD: 7 * 24 * 60 * 60 * 1000, // 剩余<7天建议刷新
};

// ============================================================
// HTTP 请求头（B站标准）
// ============================================================
export const BILI_HEADERS = {
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  REFERER: 'https://www.bilibili.com',
  ORIGIN: 'https://www.bilibili.com',
  ACCEPT: 'application/json, text/plain, */*',
  ACCEPT_LANGUAGE: 'zh-CN,zh;q=0.9,en;q=0.8',
};

export default {
  BILI_API, BILI_RSA_PUBLIC_KEY, COOKIE_FIELDS,
  ACCOUNT_STATUS, ALERT_LEVEL, HEALTH_WEIGHTS,
  TIMEOUTS, INTERVALS, COOKIE_TTL, BILI_HEADERS,
};
