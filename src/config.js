/**
 * B站评论靶场 - 后端配置模块
 *
 * 所有配置通过环境变量驱动（Render 部署时设置）。
 * 与前端 config.js 的 BACKEND_URL 配合，实现 GitHub Pages → Render 联通。
 *
 * 环境变量说明（Render → Environment → Add Environment Variable）：
 * ---------------------------------------------------------------
 * | PORT         | 端口，Render 自动注入（默认 3000）              |
 * | FRONTEND_URL | ★ 前端域名白名单（CORS），如 https://xxx.github.io |
 * |              |   多个用逗号分隔；不设则允许所有源（开发模式）     |
 * | CORS_ORIGIN  | 兼容旧命名，等价于 FRONTEND_URL（二选一）        |
 * | NODE_ENV     | production / development                        |
 * | RATE_LIMIT   | 通用接口限流（次/分钟，默认 120）                |
 * | ORDER_LIMIT  | 发布评论限流（次/分钟，默认 20）                 |
 * ---------------------------------------------------------------
 */
// 端口：优先环境变量（Render 自动设置），否则默认 3000
export const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  env: process.env.NODE_ENV || 'development',

  // 前端域名白名单（CORS 用）：兼容 FRONTEND_URL / CORS_ORIGIN 两种命名
  frontendUrls: (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  // 限流配置
  rateLimit: {
    // 通用接口：每 IP 每分钟请求上限
    general: parseInt(process.env.RATE_LIMIT, 10) || 120,
    // 发布评论/敏感操作：更严格
    publish: parseInt(process.env.ORDER_LIMIT, 10) || 20,
  },

  // 功能开关（环境变量控制）
  features: {
    // 是否启动中国IP代理池（Render 海外环境下建议开启）
    proxyPool: process.env.USE_PROXY_POOL !== 'false',
    // 是否允许浏览器登录接口（Render 无法运行 Puppeteer，生产建议关闭）
    browserLogin: process.env.ENABLE_BROWSER_LOGIN === 'true' || process.env.NODE_ENV !== 'production',
    // 是否加载本地账号文件
    loadAccounts: process.env.DISABLE_ACCOUNT_LOAD !== 'true',
  },

  // 信任设备目录（本地登录用，Puppeteer userDataDir）
  trustedDevicesDir: process.env.TRUSTED_DEVICES_DIR || 'backend/.trusted-devices',
};

/**
 * 获取 CORS 允许源列表
 * 无配置时返回 null（表示允许所有源，开发模式）
 */
export function getAllowedOrigins() {
  return config.frontendUrls.length > 0 ? config.frontendUrls : null;
}

/**
 * 校验配置完整性，返回 { errors, warnings }
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
  return { errors, warnings };
}
