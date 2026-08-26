/**
 * B站评论靶场后端服务（集成中国IP代理池）
 *
 * 部署：Render (Node.js)
 * 核心功能：
 * - 中国IP代理池：50秒定时增量刷新，自动验证
 * - 账号管理：每个账号可独立配置是否启用代理
 * - 全局代理开关
 * - B站API代理转发（WBI签名、dm_img轨迹、Base64解码）
 * - 主次账号联合发布策略
 * - 评论监控轮询（自动补发）
 */
import express from 'express';
import cors from 'cors';
import { startProxyPool, getProxyPoolStats, refreshProxyPool } from './utils/proxy-pool.js';
import {
  setGlobalProxy, getGlobalProxy,
  getReplyList, addReply, replyAction, getVideoInfo, getUpperVideos,
} from './utils/bili-api.js';
import AccountManager from './accounts/account-manager.js';
import { BilibiliLogin } from './accounts/bilibili-login.js';

// 登录会话管理（内存存储，支持并发登录）
const loginSessions = new Map(); // sessionId -> {login, status, result, phone}

const app = express();
const PORT = process.env.PORT || 3000;

// CORS跨域配置：GitHub Pages前端 → Render后端
// 生产环境建议设置环境变量 CORS_ORIGIN=https://yourname.github.io
// 多个源用逗号分隔：CORS_ORIGIN=https://a.github.io,https://b.github.io
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const corsOptions = {
  origin: function (origin, callback) {
    // 允许所有源（开发模式）或匹配白名单（生产模式）
    if (CORS_ORIGIN === '*' || !origin) {
      return callback(null, true);
    }
    const allowedOrigins = CORS_ORIGIN.split(',').map(s => s.trim());
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
// 手动处理OPTIONS预检请求（部分浏览器cors中间件可能不覆盖）
app.options('*', cors(corsOptions));
app.use(express.json());
app.set('trust proxy', 1);

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

// 本地登录工具同步Cookie上传（核心接口）
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
    const key = account.username || account.phone || account.id;
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
// ============================================================

// 启动浏览器登录会话
app.post('/api/login/start', async (req, res) => {
  const { phone, headless = false } = req.body;
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
    return res.json({ code: -1, message: '请输入有效的手机号' });
  }

  const sessionId = Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  try {
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

// 命令行登录（本地使用，node src/accounts/bilibili-login.js <手机号>）
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
// 健康检查
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    code: 0,
    data: {
      status: 'ok',
      proxy: {
        globalEnabled: getGlobalProxy(),
        pool: getProxyPoolStats(),
      },
      accounts: AccountManager.getAll().length,
    },
  });
});

// ============================================================
// 启动服务
// ============================================================
app.listen(PORT, () => {
  console.log(`[Server] B站评论靶场后端启动，端口: ${PORT}`);

  // 启动中国IP代理池（50秒定时刷新，防止Render休眠）
  try {
    startProxyPool(50 * 1000);
    console.log('[Server] 中国IP代理池已启动，50秒定时刷新');
  } catch (err) {
    console.warn('[Server] 代理池启动失败:', err.message);
  }

  // 加载账号数据
  AccountManager.load();
  console.log(`[Server] 已加载 ${AccountManager.getAll().length} 个账号`);
});
