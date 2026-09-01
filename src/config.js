/**
 * B站内容互动管理平台 - 后端配置模块 v2.2
 *
 * 所有配置通过环境变量驱动（Render 部署时设置）。
 * 与前端 config.js 的 BACKEND_URL 配合，实现 GitHub Pages → Render 联通。
 *
 * 环境变量说明（Render → Environment → Add Environment Variable）：
 * ---------------------------------------------------------------
 * | PORT               | 端口，Render 自动注入（默认 3000）          |
 * | FRONTEND_URL       | ★ 前端域名白名单（CORS），如 https://xxx.github.io |
 * | CORS_ORIGIN        | 兼容旧命名，等价于 FRONTEND_URL（二选一）     |
 * | NODE_ENV           | production / development                     |
 * | RATE_LIMIT         | 通用接口限流（次/分钟，默认 120）             |
 * | ORDER_LIMIT        | 发布评论限流（次/分钟，默认 20）              |
 * | ADMIN_TOKEN        | ★ 调试转发接口鉴权令牌（防公开滥用）          |
 * | GLOBAL_RATE_PER_MIN| 策略全局发布速率（次/分钟，默认 10）          |
 * | MONITOR_INTERVAL   | 监控轮询扫描间隔（秒，默认 5）                |
 * ---------------------------------------------------------------
 */
export const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  env: process.env.NODE_ENV || 'development',
  // 前端域名白名单（CORS 用）：兼容 FRONTEND_URL / CORS_ORIGIN 两种命名
  frontendUrls: (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  // 管理员令牌（调试转发接口鉴权）
  adminToken: process.env.ADMIN_TOKEN || '',
  // 限流配置
  rateLimit: {
    general: parseInt(process.env.RATE_LIMIT, 10) || 120,
    publish: parseInt(process.env.ORDER_LIMIT, 10) || 20,
  },
  // 策略默认参数（前端可覆盖）
  strategy: {
    globalRatePerMin: parseInt(process.env.GLOBAL_RATE_PER_MIN, 10) || 10,
    singleAccountCooldownMin: parseInt(process.env.ACCOUNT_COOLDOWN_MIN, 10) || 5,
    newAccountGraceHours: parseInt(process.env.NEW_ACCOUNT_GRACE_HOURS, 10) || 24,
    monitorScanInterval: parseInt(process.env.MONITOR_INTERVAL, 10) || 5,  // 秒
  },
  // 功能开关（环境变量控制）
  features: {
    proxyPool: process.env.USE_PROXY_POOL !== 'false',
    browserLogin: process.env.ENABLE_BROWSER_LOGIN === 'true' || process.env.NODE_ENV !== 'production',
    loadAccounts: process.env.DISABLE_ACCOUNT_LOAD !== 'true',
  },
  // 信任设备目录（本地登录用，Puppeteer userDataDir）
  trustedDevicesDir: process.env.TRUSTED_DEVICES_DIR || 'backend/.trusted-devices',
};
/**
 * 获取 CORS 允许源列表
 */
export function getAllowedOrigins() {
  return config.frontendUrls.length > 0 ? config.frontendUrls : null;
}
/**
 * 校验配置完整性
 */
export function validateConfig() {
  const errors = [];
  const warnings = [];
  if (!config.frontendUrls.length) {
    warnings.push('未配置 FRONTEND_URL，CORS 将允许所有源。生产环境请在 Render 设置 FRONTEND_URL=https://你的github.io');
  }
  if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL && !process.env.CORS_ORIGIN) {
    warnings.push('生产环境建议配置 FRONTEND_URL 白名单，防止任意网站调用后端 API');
  }
  if (process.env.NODE_ENV === 'production' && !config.adminToken) {
    warnings.push('生产环境建议配置 ADMIN_TOKEN，保护调试转发接口');
  }
  return { errors, warnings };
}
