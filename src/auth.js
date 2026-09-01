/**
 * auth.js - 管理鉴权中间件（v3.1 新增）
 *
 * 旧系统仅有 /api/debug/proxy 接口做鉴权，账号CRUD/策略/监控等敏感接口
 * 完全裸奔：任意知晓地址的请求（含 CSRF/跨站）都可操作。v3.1 统一接入。
 *
 * 设计：
 * - 通过环境变量 ADMIN_TOKEN 配置令牌（与 config.adminToken 一致）
 * - 支持三种携带方式：Authorization: Bearer <token> / X-Admin-Token / ?token=
 * - 未配置 ADMIN_TOKEN 时：开发环境放行（打警告），生产环境拒绝
 */
export function requireAdmin(req, res, next) {
  const configured = (process.env.ADMIN_TOKEN || '').trim();
  // 未配置令牌
  if (!configured) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(500).json({ code: -1, error: '后端未配置 ADMIN_TOKEN 环境变量' });
    }
    console.warn('[Auth] ⚠️ 未配置 ADMIN_TOKEN，开发环境放行（生产环境必须配置）');
    return next();
  }
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : (req.headers['x-admin-token'] || req.query.token || '');
  if (token !== configured) {
    return res.status(401).json({ code: -1, error: '未授权：AdminToken 无效' });
  }
  next();
}

/**
 * 仅保护写操作（POST/PUT/DELETE）的鉴权中间件
 * - GET/HEAD/OPTIONS 放行（前端看板只读接口不强制令牌，兼容旧前端）
 * - 写操作（改账号/执行策略/监控/删除等）必须携带 AdminToken
 */
export function requireAdminForWrites(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return requireAdmin(req, res, next);
}

export default requireAdmin;
