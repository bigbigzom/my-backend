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
  getReplyList, addReply, replyAction, getVideoInfo, getUpperVideos, checkLogin, debugProxy,
} from './utils/bili-api.js';
import AccountManager from './accounts/account-manager.js';
import { executeStrategy, updateStrategyConfig, getStrategyConfig } from './utils/strategy-engine.js';
import { addMonitorTask, getMonitorTasks, removeMonitorTask, updateMonitorTask, toggleMonitorTask, checkCommentExists, startMonitor, stopMonitor, runMonitorNow, updateMonitorConfig, getMonitorConfig } from './utils/monitor-engine.js';
import { getRiskDashboard, audit, getAuditLogs } from './utils/risk-monitor.js';
import taskQueue from './utils/task-queue.js';
import { generateMainCopy, generateSubCopy, generateDialogue, generateNurtureCopy, semanticRewrite, generateWeakRelevanceCopy } from './utils/content-rewriter.js';
import { listFingerprints, clearFingerprint, getOrCreateFingerprint } from './utils/browser-fingerprint.js';
import { getOccupancyStats } from './utils/proxy-pool.js';
import nurtureEngine from './utils/nurture-engine.js';
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
    version: '2.3.0',
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

// 验证账号登录态（健康检测用）
app.post('/api/bili/check-login', async (req, res) => {
  const { accountId } = req.body;
  const account = AccountManager.getById(accountId);
  if (!account) return res.json({ code: -1, message: '账号不存在' });
  if (!account.cookie) return res.json({ code: -101, message: '账号未登录（无Cookie）', status: 'wait_login' });
  const result = await checkLogin(account);
  const navData = result.data;
  const loggedIn = navData && navData.code === 0 && navData.data && navData.data.isLogin;
  if (loggedIn) {
    return res.json({ code: 0, message: '账号正常', status: 'normal', data: { uname: navData.data.uname, mid: navData.data.mid } });
  }
  const msg = (navData && navData.message) || '登录态失效';
  // -101=未登录 -102=账号被封 -352=风控
  let status = 'expired';
  if (navData && (navData.code === -102 || navData.code === -103)) status = 'banned';
  if (navData && navData.code === -352) status = 'abnormal';
  return res.json({ code: (navData && navData.code) || -101, message: msg, status });
});

// 通用API调试转发（前端API调试台）
app.post('/api/debug/proxy', async (req, res) => {
  // v2.2 安全加固：配置了 ADMIN_TOKEN 时必须携带正确令牌
  if (config.adminToken) {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (token !== config.adminToken) {
      return res.json({ code: -1, message: '缺少有效管理员令牌（X-Admin-Token）' });
    }
  }
  const { path, method = 'GET', params = {}, body, accountId } = req.body;
  if (!path || !path.startsWith('/')) return res.json({ code: -1, message: 'path必须以/开头' });
  // 安全限制：仅允许 B站 API 域名下的相对路径，禁止跳转/访问内网
  if (path.includes('..') || path.startsWith('//')) return res.json({ code: -1, message: '非法路径' });
  const account = accountId ? AccountManager.getById(accountId) : null;
  const result = await debugProxy({ path, method, params, body, account });
  res.json(result);
});

// 批量账号健康检测
app.post('/api/accounts/health', async (req, res) => {
  const { ids, concurrency = 3 } = req.body;
  const targets = (Array.isArray(ids) && ids.length)
    ? ids.map(id => AccountManager.getById(id)).filter(Boolean)
    : AccountManager.getAll();
  if (targets.length === 0) return res.json({ code: 0, data: [], message: '无账号可检测' });
  const results = [];
  // 并发控制
  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const acc = targets[idx++];
      const start = Date.now();
      try {
        if (!acc.cookie) {
          results.push({ id: acc.id, username: acc.username, status: 'wait_login', code: -101, message: '未登录', responseTime: 0 });
          continue;
        }
        const r = await checkLogin(acc);
        const d = r.data;
        const ok = d && d.code === 0 && d.data && d.data.isLogin;
        let status = ok ? 'normal' : 'expired';
        if (!ok && d && (d.code === -102 || d.code === -103)) status = 'banned';
        if (!ok && d && d.code === -352) status = 'abnormal';
        results.push({ id: acc.id, username: acc.username, status, code: ok ? 0 : (d && d.code) || -101, message: ok ? '正常' : (d && d.message) || '失效', responseTime: Date.now() - start });
      } catch (e) {
        results.push({ id: acc.id, username: acc.username, status: 'abnormal', code: -1, message: e.message, responseTime: Date.now() - start });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency || 3, 5) }, worker));
  res.json({ code: 0, data: results });
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
      version: '2.3.0',
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
// v2.2 新增：策略引擎 / 监控引擎 / 风控看板 / 设置持久化
// ============================================================
// ---- 策略执行 ----
app.post('/api/strategy/execute', async (req, res) => {
  try {
    const result = await executeStrategy(req.body || {});
    res.json(result);
  } catch (e) {
    res.json({ code: -1, message: '策略执行异常: ' + e.message });
  }
});
// 获取策略配置
app.get('/api/strategy/config', (req, res) => {
  res.json({ code: 0, data: getStrategyConfig() });
});
// 更新策略配置
app.post('/api/strategy/config', (req, res) => {
  const cfg = updateStrategyConfig(req.body || {});
  res.json({ code: 0, data: cfg, message: '策略配置已更新' });
});
// 一键策略模板（谨慎/均衡/激进）
app.post('/api/strategy/template', (req, res) => {
  const { preset } = req.body || {};
  const presets = {
    cautious: { globalRatePerMin: 4, singleAccountCooldownMin: 15, newAccountGraceHours: 48, maxSubPerVideo: 3, likeMainChance: 0.6 },
    balanced: { globalRatePerMin: 10, singleAccountCooldownMin: 5, newAccountGraceHours: 24, maxSubPerVideo: 5, likeMainChance: 0.8 },
    aggressive: { globalRatePerMin: 20, singleAccountCooldownMin: 2, newAccountGraceHours: 12, maxSubPerVideo: 8, likeMainChance: 0.95 },
  };
  const cfg = presets[preset];
  if (!cfg) return res.json({ code: -1, message: '模板不存在: cautious/balanced/aggressive' });
  const updated = updateStrategyConfig(cfg);
  res.json({ code: 0, data: updated, message: `已应用「${preset}」策略模板` });
});
// ---- 任务队列 ----
app.get('/api/tasks', (req, res) => {
  res.json({ code: 0, data: taskQueue.list({ limit: 100 }), stats: taskQueue.getStats() });
});
app.delete('/api/tasks/:id', (req, res) => {
  taskQueue.cancel(req.params.id);
  res.json({ code: 0, message: '任务已取消' });
});
// ---- 监控引擎 ----
app.get('/api/monitor/tasks', (req, res) => {
  res.json({ code: 0, data: getMonitorTasks() });
});
app.post('/api/monitor/tasks', (req, res) => {
  const task = addMonitorTask(req.body || {});
  res.json({ code: 0, data: task, message: '监控任务已创建' });
});
app.put('/api/monitor/tasks/:id', (req, res) => {
  const t = updateMonitorTask(req.params.id, req.body || {});
  if (!t) return res.json({ code: -1, message: '任务不存在' });
  res.json({ code: 0, data: t, message: '监控任务已更新' });
});
app.delete('/api/monitor/tasks/:id', (req, res) => {
  const ok = removeMonitorTask(req.params.id);
  res.json({ code: ok ? 0 : -1, message: ok ? '监控任务已删除' : '任务不存在' });
});
app.post('/api/monitor/start', (req, res) => {
  startMonitor((req.body && req.body.intervalMs) || 5000);
  res.json({ code: 0, message: '监控轮询已启动' });
});
app.post('/api/monitor/stop', (req, res) => {
  stopMonitor();
  res.json({ code: 0, message: '监控轮询已停止' });
});
app.post('/api/monitor/run-now', async (req, res) => {
  const r = await runMonitorNow();
  res.json({ code: 0, data: r.tasks, message: '已触发一轮检测' });
});
// 检测单条评论是否存在（监控页手动检测）
app.post('/api/monitor/check', async (req, res) => {
  const { bv, oid, accountId, copyPrefix, rpid } = req.body || {};
  if (!bv && !oid) return res.json({ code: -1, message: '需要 bv 或 oid' });
  const r = await checkCommentExists({ bv, oid, accountId, copyPrefix, rpid });
  res.json({ code: 0, data: r, message: r.exists ? (r.level === 'visible' ? '评论存在' : '评论被折叠') : '评论不存在/被删除' });
});
// 监控配置
app.get('/api/monitor/config', (req, res) => {
  res.json({ code: 0, data: getMonitorConfig() });
});
app.post('/api/monitor/config', (req, res) => {
  const cfg = updateMonitorConfig(req.body || {});
  res.json({ code: 0, data: cfg, message: '监控配置已更新' });
});
// ---- 风控看板 ----
app.get('/api/risk/dashboard', (req, res) => {
  res.json(getRiskDashboard());
});
// 风控事件流（前端预警）
app.get('/api/risk/events', (req, res) => {
  res.json({ code: 0, data: { events: AccountManager.getAllRiskEvents().slice(0, 50) } });
});
// 账号健康度/关联风险（前端热力图）
app.get('/api/risk/accounts', (req, res) => {
  res.json({ code: 0, data: AccountManager.getHealthHeatmap() });
});
// 手动设置账号静默
app.post('/api/risk/mute', (req, res) => {
  const { accountId, minutes = 60 } = req.body || {};
  const ok = AccountManager.setMute(accountId, minutes);
  res.json({ code: ok ? 0 : -1, message: ok ? `账号已静默 ${minutes} 分钟` : '账号不存在' });
});
// 手动重新计算所有账号关联风险分
app.post('/api/risk/recompute', (req, res) => {
  const list = AccountManager.getAll();
  for (const a of list) AccountManager.computeRiskScore(a.id);
  res.json({ code: 0, message: `已重算 ${list.length} 个账号的关联风险分` });
});
// ---- 指纹画像管理 ----
app.get('/api/fingerprints', (req, res) => {
  res.json({ code: 0, data: listFingerprints() });
});
app.post('/api/fingerprints/regenerate', (req, res) => {
  const { accountKey } = req.body || {};
  if (!accountKey) return res.json({ code: -1, message: '缺少 accountKey' });
  clearFingerprint(accountKey);
  const fp = getOrCreateFingerprint(accountKey, { forceRegenerate: true });
  res.json({ code: 0, data: { fingerprintId: fp.fingerprintId, summary: { ua: fp.userAgent, screen: `${fp.screenWidth}x${fp.screenHeight}`, gpu: fp.webglRenderer, timezone: fp.timezone } }, message: '指纹画像已重新生成（模拟换设备）' });
});
app.post('/api/fingerprints/clear', (req, res) => {
  const { accountKey } = req.body || {};
  if (!accountKey) return res.json({ code: -1, message: '缺少 accountKey' });
  const ok = clearFingerprint(accountKey);
  res.json({ code: ok ? 0 : -1, message: ok ? '指纹画像已清除' : '无该账号画像' });
});
// ---- 审计日志 ----
app.get('/api/audit/logs', (req, res) => {
  res.json({ code: 0, data: getAuditLogs(parseInt(req.query.limit) || 100) });
});
// ---- 代理占用统计（去关联） ----
app.get('/api/proxy/occupancy', (req, res) => {
  res.json({ code: 0, data: getOccupancyStats() });
});
// ---- 文案重组/引流变体（前端文案工作台调用） ----
app.post('/api/rewrite/semantic', (req, res) => {
  const { text, count = 1 } = req.body || {};
  if (!text) return res.json({ code: -1, message: '缺少文案' });
  const results = [];
  for (let i = 0; i < Math.min(count, 10); i++) results.push(semanticRewrite(text));
  res.json({ code: 0, data: results });
});
app.post('/api/rewrite/main-copy', (req, res) => {
  const { text, keyword, variantIndex } = req.body || {};
  if (!text) return res.json({ code: -1, message: '缺少文案' });
  const results = [];
  for (let i = 0; i < 3; i++) results.push(generateMainCopy(text, { keyword, variantIndex: variantIndex !== undefined ? variantIndex + i : undefined }));
  res.json({ code: 0, data: results });
});
app.post('/api/rewrite/dialogue', (req, res) => {
  const { mainCopy, keyword } = req.body || {};
  const dialogue = generateDialogue({ mainCopy, keyword });
  res.json({ code: 0, data: dialogue });
});
app.post('/api/rewrite/nurture', (req, res) => {
  const results = [];
  for (let i = 0; i < 5; i++) results.push(generateNurtureCopy());
  res.json({ code: 0, data: results });
});
// ---- 人设库 ----
app.get('/api/personas', (req, res) => {
  const personas = [
    { key: 'questioner', name: '提问型', desc: '真实好奇，求链接/求教程' },
    { key: 'praiser', name: '赞叹型', desc: '被种草，认同分享' },
    { key: 'experiencer', name: '晒单型', desc: '已购买，分享体验证明真实性' },
    { key: 'analyzer', name: '理性型', desc: '客观分析，补充信息' },
    { key: 'neutral', name: '路人型', desc: '普通路人，随缘互动' },
  ];
  res.json({ code: 0, data: personas });
});

// ============================================================
// 404 兜底
// ============================================================
// ============================================================
// v2.3 去关联：养号引擎 API
// ============================================================
app.get('/api/nurture/stats', (req, res) => {
  res.json({ code: 0, data: nurtureEngine.getStats() });
});
app.get('/api/nurture/plans', (req, res) => {
  res.json({ code: 0, data: nurtureEngine.getAllPlans() });
});
app.get('/api/nurture/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ code: 0, data: nurtureEngine.getHistory(limit) });
});
app.post('/api/nurture/run', async (req, res) => {
  const { accountId, force } = req.body || {};
  try {
    if (accountId) {
      const result = await nurtureEngine.performNurtureAction(accountId, { force: !!force });
      res.json({ code: 0, data: result });
    } else {
      const results = await nurtureEngine.nurtureAllAccounts({ force: !!force });
      res.json({ code: 0, data: results, count: results.length });
    }
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});
app.post('/api/nurture/start', (req, res) => {
  const interval = parseInt(req.body?.intervalMs) || 3600000;
  nurtureEngine.startScheduler(interval);
  res.json({ code: 0, message: '养号调度已启动', data: nurtureEngine.getStats() });
});
app.post('/api/nurture/stop', (req, res) => {
  nurtureEngine.stopScheduler();
  res.json({ code: 0, message: '养号调度已停止', data: nurtureEngine.getStats() });
});
app.put('/api/nurture/plan/:accountId', (req, res) => {
  const plan = nurtureEngine.updatePlan(req.params.accountId, req.body || {});
  if (!plan) return res.json({ code: -1, message: '养号计划不存在' });
  res.json({ code: 0, data: plan });
});

// ============================================================
// v2.3 去关联：账号活跃时段 / IP角色 / 社交隔离 API
// ============================================================
app.put('/api/accounts/:id/active-hours', (req, res) => {
  const { activeStartHour, activeEndHour } = req.body || {};
  const account = AccountManager.update(req.params.id, { activeStartHour, activeEndHour });
  if (!account) return res.json({ code: -1, message: '账号不存在' });
  res.json({ code: 0, data: { activeStartHour: account.activeStartHour, activeEndHour: account.activeEndHour } });
});
app.put('/api/accounts/:id/ip-role', (req, res) => {
  const { ipRole } = req.body || {};
  if (!['publisher', 'commenter'].includes(ipRole)) return res.json({ code: -1, message: 'ipRole必须是publisher或commenter' });
  const account = AccountManager.update(req.params.id, { ipRole });
  if (!account) return res.json({ code: -1, message: '账号不存在' });
  res.json({ code: 0, data: { ipRole: account.ipRole } });
});
app.put('/api/accounts/:id/social-separation', (req, res) => {
  const { socialSeparation } = req.body || {};
  const account = AccountManager.update(req.params.id, { socialSeparation: !!socialSeparation });
  if (!account) return res.json({ code: -1, message: '账号不存在' });
  res.json({ code: 0, data: { socialSeparation: account.socialSeparation } });
});
app.get('/api/accounts/publisher-ips', (req, res) => {
  res.json({ code: 0, data: AccountManager.getPublisherIps() });
});

// ============================================================
// v2.3 去关联：弱相关文案 / 风险详情 API
// ============================================================
app.get('/api/copy/weak-relevance', (req, res) => {
  const keyword = req.query.keyword || '';
  const count = parseInt(req.query.count) || 5;
  const copies = [];
  for (let i = 0; i < count; i++) {
    copies.push(generateWeakRelevanceCopy({ keyword }));
  }
  res.json({ code: 0, data: copies });
});
app.get('/api/accounts/:id/risk-detail', (req, res) => {
  const account = AccountManager.getById(req.params.id);
  if (!account) return res.json({ code: -1, message: '账号不存在' });
  const score = AccountManager.computeRiskScore(req.params.id);
  res.json({ code: 0, data: { riskScore: score, breakdown: account.riskBreakdown || {}, riskSignals: account.riskSignals || [] } });
});

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
║   Bilibili Comment Target Backend v2.3.0                  ║
║   B站评论系统攻防练习靶场 · 后端服务 v2.2                       ║
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
  // 启动任务队列（支撑分阶段热度曲线延迟任务）
  try {
    taskQueue.start();
  } catch (err) {
    console.warn('[Server] 任务队列启动失败:', err.message);
  }
  // 启动监控轮询（评论存在性检测）
  try {
    startMonitor(config.strategy.monitorScanInterval * 1000);
  } catch (err) {
    console.warn('[Server] 监控轮询启动失败:', err.message);
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
