/**
 * B站评论靶场后端服务（集成中国IP代理池）
 *
 * 架构（参考 fansky-shop 前后端联通设计）：
 * - 前端：GitHub Pages（静态 HTML/CSS/JS）→ fetch → 本后端
 * - 后端：Render (Node.js + Express)
 * - 联通：前端 config.js 的 BACKEND_URL ↔ 后端 FRONTEND_URL(CORS白名单)
 *
 * 核心功能：
 * - 中国IP代理池：50秒定时增量刷新，自动验证
 * - 账号管理：每个账号可独立配置是否启用代理
 * - 全局代理开关
 * - B站API代理转发（WBI签名、dm_img轨迹、Base64解码）
 * - 主次账号联合发布策略
 * - 评论监控轮询（自动补发）
 * - 安全层：请求日志、限流、慢速防护、CORS白名单
 */
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config, getAllowedOrigins, validateConfig } from './config.js';
import { startProxyPool, getProxyPoolStats, refreshProxyPool } from './utils/proxy-pool.js';
import {
  setGlobalProxy, getGlobalProxy,
  getReplyList, addReply, replyAction, getVideoInfo, getUpperVideos,
} from './utils/bili-api.js';
import AccountManager from './accounts/account-manager.js';
// 注意：bilibili-login.js 引入 puppeteer，仅在本地登录时动态导入
// Render 启动时不加载 puppeteer（Render免费版无法运行），避免拖慢启动
// 本地登录请使用：node local-login.js

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 登录会话管理（内存存储，支持并发登录）
const loginSessions = new Map(); // sessionId -> {login, status, result, phone}
const app = express();
const PORT = config.port;

// Render 反向代理，信任 proxy（获取真实 IP）
app.set('trust proxy', 1);

// ============================================================
//  慢速请求防护：60秒无响应自动断开（防慢速攻击）
// ============================================================
const server = app.listen(PORT, () => {
  console.log(`🚀 B站评论靶场后端启动，端口: ${PORT}`);
});
server.setTimeout(60000);

// ============================================================
//  CORS跨域配置（GitHub Pages前端 → Render后端）
//  白名单由环境变量 FRONTEND_URL（或兼容旧命名 CORS_ORIGIN）控制
//  参考 fansky-shop：FRONTEND_URL=https://yourname.github.io
// ============================================================
const allowedOrigins = getAllowedOrigins();
const corsOptions = {
  origin: function (origin, callback) {
    // 无白名单（开发模式）或同源请求（origin为undefined，curl/服务端）→ 放行
    if (!allowedOrigins || allowedOrigins.length === 0 || !origin) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.warn(`[CORS] 拒绝跨域请求: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400,  // 预检请求缓存24小时
};
app.use(cors(corsOptions));
// 手动处理OPTIONS预检请求
app.options('*', cors(corsOptions));
// CORS 错误处理
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ code: -1, error: '跨域请求被拒绝' });
  }
  next(err);
});
if (!allowedOrigins || allowedOrigins.length === 0) {
  console.warn('[Security] ⚠️ FRONTEND_URL 未配置，CORS 允许所有源。生产环境请在 Render 设置 FRONTEND_URL=https://你的github.io');
} else {
  console.log(`[Security] CORS 白名单: ${allowedOrigins.join(', ')}`);
}

// JSON 解析（限制请求体大小）
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ============================================================
//  请求日志中间件
// ============================================================
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms) ${req.ip}`);
  });
  next();
});

// ============================================================
//  限流中间件（防止滥用/DDoS，参考 fansky-shop 设计）
// ============================================================
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1分钟
  max: config.rateLimit.general,  // 每IP每分钟
  message: { code: -1, error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});
const publishLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.publish,  // 发布评论更严格
  message: { code: -1, error: '操作过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});
// 所有 /api 通用限流
app.use('/api', generalLimiter);
// 发布评论/评论操作等敏感接口严格限流
app.use('/api/bili/add-reply', publishLimiter);
app.use('/api/bili/reply-action', publishLimiter);

// ============================================================
// 根路径：服务信息（供前端/浏览器确认服务在线）
// ============================================================
app.get('/', (req, res) => {
  res.json({
    name: 'Bilibili Comment Target Backend',
    version: '2.0.0',
    status: 'running',
    docs: '/api/health',
    frontend: allowedOrigins || 'all (configure FRONTEND_URL)',
  });
});

// ============================================================
// 健康检查（render.yaml healthCheckPath 使用，需快速响应）
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'bilibili-comment-target-backend',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// 代理池管理API
// ============================================================
// 获取代理池状态
app.get('/api/proxy/stats', (req, res) => {
  res.json({ code: 0, data: getProxyPoolStats() });
});
// 手动触发代理池刷新
app.post('/api/proxy/refresh', async (req, res) => {
  res.json({ code: 0, message: '代理池刷新已触发' });
  refreshProxyPool();
});
// 全局代理开关
app.get('/api/proxy/global', (req, res) => {
  res.json({ code: 0, data: { enabled: getGlobalProxy() } });
});
app.post('/api/proxy/global', (req, res) => {
  const { enabled } = req.body;
  setGlobalProxy(enabled !== false);
  res.json({ code: 0, message: `全局代理已${getGlobalProxy() ? '开启' : '关闭'}` });
});

// ============================================================
// 账号管理API（含代理控制）
// ============================================================
// 获取所有账号
app.get('/api/accounts', (req, res) => {
  res.json({ code: 0, data: AccountManager.getAll() });
});
// 本地登录工具同步Cookie上传（核心联通接口）
// 本地Puppeteer登录成功后，调用此接口将Cookie上传到Render后端保存
app.post('/api/accounts/sync-cookie', (req, res) => {
  const { account } = req.body;
  if (!account || !account.cookie || !account.csrf) {
    return res.json({ code: -1, message: '缺少必要字段：account.cookie 和 account.csrf' });
  }
  try {
    // 确保目录存在
    const modelsDir = path.join(__dirname, 'models');
    if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });
    // 读取现有账号
    const accountFile = path.join(modelsDir, 'accounts.json');
    let accounts = [];
    if (fs.existsSync(accountFile)) {
      accounts = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
    }
    // 去重：同UID/手机号覆盖
    accounts = accounts.filter(a =>
      (a.username && a.username !== account.username) &&
      (a.phone && a.phone !== account.phone)
    );
    // 确保必要字段
    const newAccount = {
      id: account.id || Date.now() + Math.random(),
      type: account.type || 'browser_login',
      username: account.username || '',
      phone: account.phone || '',
      account: account.account || '',
      password: account.password || '',
      remark: account.remark || `本地登录同步-${new Date().toLocaleDateString()}`,
      cookie: account.cookie,
      csrf: account.csrf,
      cookieExpire: account.cookieExpire || Date.now() + 7*24*3600*1000,
      status: 'normal',
      useProxy: account.useProxy !== false,
      todayPublished: 0,
      lastPublishTime: 0,
      cooldownUntil: 0,
      loginAt: account.loginAt || new Date().toISOString(),
      loginMode: account.loginMode || 'local_sync',
      syncedAt: new Date().toISOString(),
    };
    accounts.push(newAccount);
    fs.writeFileSync(accountFile, JSON.stringify(accounts, null, 2));
    // 让 AccountManager 重新加载文件（保持内存与文件一致）
    try { AccountManager.load(); } catch (e) {}
    console.log(`[SyncCookie] Cookie同步成功: UID=${newAccount.username}, 模式=${newAccount.loginMode}, 当前账号数=${accounts.length}`);
    res.json({
      code: 0,
      message: 'Cookie同步成功',
      data: {
        account: { id: newAccount.id, username: newAccount.username, phone: newAccount.phone, status: newAccount.status },
        totalAccounts: accounts.length,
      },
    });
  } catch (err) {
    console.error('[SyncCookie] 同步失败:', err.message);
    res.json({ code: -1, message: 'Cookie同步失败: ' + err.message });
  }
});
// 批量导入账号
app.post('/api/accounts/import', (req, res) => {
  const { accounts } = req.body;
  if (!Array.isArray(accounts)) {
    return res.json({ code: -1, message: 'accounts必须是数组' });
  }
  const count = AccountManager.importBatch(accounts);
  res.json({ code: 0, message: `成功导入${count}个账号`, data: AccountManager.getAll() });
});
// 更新单个账号（含useProxy代理开关）
app.put('/api/accounts/:id', (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const account = AccountManager.update(id, updates);
  if (!account) {
    return res.json({ code: -1, message: '账号不存在' });
  }
  res.json({ code: 0, data: account, message: `账号代理已${account.useProxy ? '开启' : '关闭'}` });
});
// 批量设置账号代理开关
app.post('/api/accounts/proxy-batch', (req, res) => {
  const { ids, useProxy } = req.body;
  if (!Array.isArray(ids)) {
    return res.json({ code: -1, message: 'ids必须是数组' });
  }
  const count = AccountManager.batchSetProxy(ids, useProxy);
  res.json({ code: 0, message: `已更新${count}个账号的代理设置`, data: AccountManager.getAll() });
});
// 删除账号
app.delete('/api/accounts/:id', (req, res) => {
  const { id } = req.params;
  AccountManager.remove(id);
  res.json({ code: 0, message: '账号已删除' });
});

// ============================================================
// 浏览器自动登录API（Puppeteer）
// 生产环境（Render）禁用，用本地 local-login.js
// ============================================================
// 启动浏览器登录会话
app.post('/api/login/start', async (req, res) => {
  // 生产环境禁用浏览器登录（Render无法运行Puppeteer，用本地登录）
  if (!config.features.browserLogin) {
    return res.json({ code: -1, message: '浏览器登录已禁用（Render无法运行Puppeteer）。请使用本地工具：node local-login.js' });
  }
  const { phone, headless = false } = req.body;
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
    return res.json({ code: -1, message: '请输入有效的手机号' });
  }
  const sessionId = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  try {
    // 动态导入（仅登录时加载puppeteer，不影响服务启动）
    const { BilibiliLogin } = await import('./accounts/bilibili-login.js');
    const login = new BilibiliLogin({ headless, timeout: 180000 });
    loginSessions.set(sessionId, { login, status: 'launching', result: null, phone });
    // 异步执行登录
    (async () => {
      try {
        const session = loginSessions.get(sessionId);
        session.status = 'waiting_code';
        const result = await login.loginByPhone(phone, {
          headless,
          autoClose: false,
          onCodeRequired: (p) => {
            session.status = 'waiting_code';
            console.log(`[Login] 会话${sessionId} 等待验证码输入: ${p}`);
          },
          onCaptchaRequired: () => {
            session.status = 'waiting_captcha';
            console.log(`[Login] 会话${sessionId} 需要滑块验证`);
          },
          codeTimeout: 180000,
        });
        session.result = result;
        session.status = result.success ? 'success' : 'failed';
        if (result.success) {
          // 自动保存账号
          login.saveAccount(result.account);
          AccountManager.load();
          console.log(`[Login] 会话${sessionId} 登录成功，账号已保存`);
        }
      } catch (err) {
        const session = loginSessions.get(sessionId);
        if (session) {
          session.status = 'failed';
          session.result = { success: false, error: err.message };
        }
        console.error(`[Login] 会话${sessionId} 登录异常:`, err.message);
      }
    })();
    res.json({ code: 0, message: '登录会话已启动', data: { sessionId, status: 'launching' } });
  } catch (err) {
    res.json({ code: -1, message: '启动登录失败: ' + err.message });
  }
});
// 查询登录状态
app.get('/api/login/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = loginSessions.get(sessionId);
  if (!session) {
    return res.json({ code: -1, message: '登录会话不存在或已过期' });
  }
  res.json({
    code: 0,
    data: {
      sessionId,
      status: session.status,  // launching/waiting_code/waiting_captcha/success/failed
      phone: session.phone,
      result: session.result,
    },
  });
});
// 关闭登录会话
app.post('/api/login/close/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = loginSessions.get(sessionId);
  if (session) {
    try { await session.login.close(); } catch (e) {}
    loginSessions.delete(sessionId);
  }
  res.json({ code: 0, message: '登录会话已关闭' });
});

// ============================================================
// B站API代理转发
// ============================================================
// 获取评论列表
app.get('/api/bili/reply-list', async (req, res) => {
  const { bv, oid, mode, offset, accountId } = req.query;
  const account = AccountManager.getById(accountId);
  const result = await getReplyList({ bv, oid: parseInt(oid), account, mode: parseInt(mode) || 3, offset });
  res.json(result);
});
// 发布评论
app.post('/api/bili/add-reply', async (req, res) => {
  const { bv, oid, accountId, message, root, parent, useDmImg } = req.body;
  const account = AccountManager.getById(accountId);
  if (!account) {
    return res.json({ code: -1, message: '账号不存在' });
  }
  const result = await addReply({
    bv, oid: parseInt(oid), account, message,
    root: root ? parseInt(root) : 0,
    parent: parent ? parseInt(parent) : 0,
    useDmImg: useDmImg !== false,
  });
  res.json(result);
});
// 评论点赞
app.post('/api/bili/reply-action', async (req, res) => {
  const { oid, rpid, action, accountId } = req.body;
  const account = AccountManager.getById(accountId);
  const result = await replyAction({ oid: parseInt(oid), rpid: parseInt(rpid), action: action || 1, account });
  res.json(result);
});
// 获取视频信息（BV转aid）
app.get('/api/bili/video-info', async (req, res) => {
  const { bv } = req.query;
  const result = await getVideoInfo(bv);
  res.json(result);
});
// 获取UP主视频列表
app.get('/api/bili/upper-videos', async (req, res) => {
  const { mid, page, ps, order } = req.query;
  const result = await getUpperVideos(parseInt(mid), parseInt(page) || 1, parseInt(ps) || 30, order || 'pubdate');
  res.json(result);
});

// ============================================================
// 健康检查（详细版，前端「测试连接」使用）
// ============================================================
app.get('/api/health', (req, res) => {
  let proxyStats = null;
  try { proxyStats = getProxyPoolStats(); } catch(e) {}
  res.json({
    code: 0,
    data: {
      status: 'ok',
      service: 'bilibili-comment-target-backend',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      // 前后端联通关键信息
      cors: {
        configured: allowedOrigins && allowedOrigins.length > 0,
        allowedOrigin: allowedOrigins ? allowedOrigins.join(', ') : 'all (*)',
        requestOrigin: req.headers.origin || 'none',
      },
      accounts: AccountManager.getAll().length,
      proxy: {
        globalEnabled: getGlobalProxy(),
        pool: proxyStats,
      },
      // 前端可据此判断后端是否正常运行
      endpoints: {
        accounts: '/api/accounts',
        proxyStats: '/api/proxy/stats',
        syncCookie: '/api/accounts/sync-cookie',
        biliReply: '/api/bili/reply-list',
      },
    },
  });
});

// ============================================================
// 404 兜底
// ============================================================
app.use((req, res) => {
  res.status(404).json({ code: -1, error: 'Not Found', path: req.path });
});

// ============================================================
// 错误处理
// ============================================================
app.use((err, req, res, next) => {
  console.error('[Server] 未处理错误:', err);
  res.status(500).json({ code: -1, error: '服务器内部错误' });
});

// ============================================================
// 启动流程（异步初始化，失败不影响HTTP服务）
// ============================================================
async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║   Bilibili Comment Target Backend v2.0.0                  ║
║   B站评论系统攻防练习靶场 · 后端服务                       ║
╠══════════════════════════════════════════════════════════╣
║   前端: GitHub Pages (静态) → fetch → 本后端              ║
║   后端: Render (Node.js + Express)                        ║
║   CORS: ${(allowedOrigins || ['all']).join(', ').substring(0, 40)}  ║
╚══════════════════════════════════════════════════════════╝
  `);
  // 配置校验
  try {
    const { errors, warnings } = validateConfig();
    warnings.forEach(w => console.warn(`[Config] ⚠️ ${w}`));
    errors.forEach(e => console.error(`[Config] ❌ ${e}`));
  } catch (err) {
    console.warn('[Config] 配置校验失败:', err.message);
  }
  // 启动中国IP代理池（50秒定时刷新，防止Render休眠）
  try {
    if (config.features.proxyPool) {
      startProxyPool(50 * 1000);
      console.log('[Server] 中国IP代理池已启动，50秒定时刷新');
    } else {
      console.log('[Server] 代理池已禁用（USE_PROXY_POOL=false）');
    }
  } catch (err) {
    console.warn('[Server] 代理池启动失败:', err.message);
  }
  // 加载账号数据
  try {
    if (config.features.loadAccounts) {
      AccountManager.load();
      console.log(`[Server] 已加载 ${AccountManager.getAll().length} 个账号`);
    }
  } catch (err) {
    console.warn('[Server] 账号加载失败:', err.message);
  }
}
main().catch(err => {
  console.error('[Server] 初始化异常（HTTP服务已在运行）:', err);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[Server] 收到 SIGTERM，正在关闭...');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('\n[Server] 收到 SIGINT，正在关闭...');
  process.exit(0);
});
