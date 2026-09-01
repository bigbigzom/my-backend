/**
 * B站内容互动管理平台后端服务（集成中国IP代理池）
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
import { startProxyPool, getProxyPoolStats, refreshProxyPool, getProxy, acquireProxy, markProxyFailed, isProxyReady } from './utils/proxy-pool.js';
import {
  setGlobalProxy, getGlobalProxy,
  getReplyList, addReply, replyAction, getVideoInfo, getUpperVideos, checkLogin, debugProxy,
} from './utils/bili-api.js';
import AccountManager from './accounts/account-manager.js';
import { AccountManagerV2, AccountCultivator, ACCOUNT_TYPE } from './accounts-v2/index.js';
import requireAdmin, { requireAdminForWrites } from './auth.js';
import { BiliClient, CommentAPI, VideoAPI, UserAPI, BehaviorSimulator } from './bili-api/index.js';
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
// v3.1 修复：JSON/urlencoded 解析与管理鉴权必须注册在所有路由之前
// （Express 按注册顺序匹配中间件；旧实现把 express.json 放在路由之后，
//   导致 /api/v2/* 等前置路由的 req.body 为 undefined 而抛 500）
// ============================================================
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
// v3.1 管理鉴权：写操作（POST/PUT/DELETE）必须携带 AdminToken
//  - GET/HEAD/OPTIONS 放行（只读看板兼容旧前端）
//  - Authorization: Bearer <token> / X-Admin-Token / ?token=
app.use([
  '/api/v2/accounts', '/api/cultivation', '/api/strategy', '/api/monitor',
  '/api/risk', '/api/fingerprints', '/api/nurture', '/api/accounts',
  '/api/bili/add-reply', '/api/bili/reply-action', '/api/rewrite',
  '/api/tasks', '/api/debug/proxy',
], requireAdminForWrites);


// ============================================================
//  慢速请求防护：60秒无响应自动断开（防慢速攻击）
// ============================================================

// ============================================================
// v2 账号系统（面向对象重构版）
// ============================================================
const AccountManagerV2Inst = AccountManagerV2.getInstance();

// 获取所有账号（v2格式，含健康度）
app.get('/api/v2/accounts', (req, res) => {
  res.json({ code: 0, data: AccountManagerV2Inst.getAllDisplay(), count: AccountManagerV2Inst.count });
});

// 账号统计摘要
app.get('/api/v2/accounts/stats', (req, res) => {
  res.json({ code: 0, data: AccountManagerV2Inst.getStats() });
});

// 单个账号详情
app.get('/api/v2/accounts/:id', (req, res) => {
  const a = AccountManagerV2Inst.get(req.params.id);
  res.json(a ? { code: 0, data: a.toJSON() } : { code: -1, message: '账号不存在' });
});

// 刷新单个账号Cookie（6步完整刷新）
app.post('/api/v2/accounts/:id/refresh', async (req, res) => {
  try {
    const r = await AccountManagerV2Inst.refreshAccount(req.params.id, req.body || {});
    res.json({ code: r.success ? 0 : -1, data: r, message: r.error || '' });
  } catch (e) { res.json({ code: -1, message: e.message }); }
});

// 批量刷新
app.post('/api/v2/accounts/refresh-all', async (req, res) => {
  try {
    const r = await AccountManagerV2Inst.refreshAllNeedsRefresh(req.body || {});
    res.json({ code: 0, data: r });
  } catch (e) { res.json({ code: -1, message: e.message }); }
});

// 健康度检查
app.post('/api/v2/accounts/health-check', (req, res) => {
  res.json({ code: 0, data: AccountManagerV2Inst.checkAllHealth() });
});

// 验证登录态
app.post('/api/v2/accounts/:id/verify', async (req, res) => {
  try {
    const r = await AccountManagerV2Inst.verifyLogin(req.params.id);
    res.json({ code: r.valid ? 0 : -1, data: r });
  } catch (e) { res.json({ code: -1, message: e.message }); }
});

// v2批量导入
app.post('/api/v2/accounts/import', (req, res) => {
  const { accounts } = req.body;
  if (!Array.isArray(accounts)) return res.json({ code: -1, message: 'accounts必须是数组' });
  const count = AccountManagerV2Inst.importBatch(accounts);
  res.json({ code: 0, message: `成功导入${count}个账号`, data: { count } });
});

// 删除账号
app.delete('/api/v2/accounts/:id', (req, res) => {
  const ok = AccountManagerV2Inst.remove(req.params.id);
  res.json({ code: ok ? 0 : -1, message: ok ? '已删除' : '账号不存在' });
});



// ============================================================
// 养号系统 API（AccountCultivator）
// ============================================================

// 获取账号养号状态
app.get('/api/cultivation/status/:accountId', (req, res) => {
  try {
    const acc = AccountManagerV2Inst.get(req.params.accountId);
    if (!acc) return res.json({ code: -1, message: '账号不存在' });
    const cultivator = new AccountCultivator({ account: acc, accountType: acc.accountType });
    res.json({ code: 0, data: cultivator.getReport() });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// 执行每日养号任务
app.post('/api/cultivation/daily', async (req, res) => {
  try {
    const { accountId, targetBvids, searchKeywords, actionMultiplier } = req.body;
    if (!accountId) return res.json({ code: -1, message: '缺少 accountId' });
    const acc = AccountManagerV2Inst.get(accountId);
    if (!acc) return res.json({ code: -1, message: '账号不存在' });
    const cultivator = new AccountCultivator({ account: acc, accountType: acc.accountType });
    const result = await cultivator.runDailyCultivation({
      targetBvids: targetBvids || [],
      searchKeywords: searchKeywords || [],
      actionMultiplier: actionMultiplier || 1,
    });
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// 推进养号阶段
app.post('/api/cultivation/advance', (req, res) => {
  try {
    const { accountId } = req.body;
    const acc = AccountManagerV2Inst.get(accountId);
    if (!acc) return res.json({ code: -1, message: '账号不存在' });
    const cultivator = new AccountCultivator({ account: acc, accountType: acc.accountType });
    const success = cultivator.advanceStage();
    res.json({ code: success ? 0 : -1, data: { success, stage: cultivator.stage } });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// 设置账号类型（视频发布号/评论号）
app.post('/api/cultivation/set-type', (req, res) => {
  try {
    const { accountId, accountType } = req.body;
    if (!accountId || !accountType) return res.json({ code: -1, message: '缺少参数' });
    if (![ACCOUNT_TYPE.VIDEO_PUBLISHER, ACCOUNT_TYPE.COMMENT_ACCOUNT].includes(accountType)) {
      return res.json({ code: -1, message: '无效的账号类型' });
    }
    const acc = AccountManagerV2Inst.get(accountId);
    if (!acc) return res.json({ code: -1, message: '账号不存在' });
    acc.accountType = accountType;
    AccountManagerV2Inst.save();
    res.json({ code: 0, data: { accountId, accountType } });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// 检查账号隔离状态
app.get('/api/cultivation/isolation/:accountId', (req, res) => {
  try {
    const acc = AccountManagerV2Inst.get(req.params.accountId);
    if (!acc) return res.json({ code: -1, message: '账号不存在' });
    const cultivator = new AccountCultivator({ account: acc, accountType: acc.accountType });
    res.json({ code: 0, data: cultivator.checkIsolation() });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// ============================================================
// 改进2：视频发布者分组 API（发布账号 ≠ 评论账号）
// ============================================================
// 列出所有账号及发布者/评论者角色（合并新旧两套账号存储展示）
app.get('/api/video-publisher/list', (req, res) => {
  try {
    const oldAccounts = AccountManager.getAll().map(a => ({
      id: a.id, uid: a.uid || '', phone: a.phone || '', username: a.username || a.account || '',
      remark: a.remark || '', status: a.status, ipRole: a.ipRole || 'commenter',
      primaryProxy: a.primaryProxy || '', source: 'legacy', accountType: a.ipRole === 'publisher' ? ACCOUNT_TYPE.VIDEO_PUBLISHER : ACCOUNT_TYPE.COMMENT_ACCOUNT,
      hasCookie: !!(a.cookie || '').includes('SESSDATA'),
    }));
    const v2Accounts = AccountManagerV2Inst.getAll().map(a => {
      const d = a.toDisplay ? a.toDisplay() : a;
      return {
        id: a.id, uid: d.uid || '', phone: d.phone || '', username: d.username || '',
        remark: d.remark || '', status: d.status, ipRole: a.accountType === ACCOUNT_TYPE.VIDEO_PUBLISHER ? 'publisher' : 'commenter',
        primaryProxy: d.proxy || '', source: 'v2', accountType: a.accountType || ACCOUNT_TYPE.COMMENT_ACCOUNT,
        hasCookie: !!(a.cookieStr || '').includes('SESSDATA'),
      };
    });
    // 合并去重：同 uid 优先 v2 展示
    const merged = [];
    const seen = new Set();
    for (const a of [...v2Accounts, ...oldAccounts]) {
      const key = a.uid || a.phone || a.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(a);
    }
    const publishers = merged.filter(a => a.ipRole === 'publisher');
    const commenters = merged.filter(a => a.ipRole !== 'publisher');
    res.json({ code: 0, data: { accounts: merged, publishers, commenters, total: merged.length } });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// 设置账号为视频发布者 / 评论者（同步标记新旧两套存储）
app.post('/api/video-publisher/set', (req, res) => {
  try {
    const { accountId, role } = req.body;
    if (!accountId || !['publisher', 'commenter'].includes(role)) {
      return res.json({ code: -1, message: '参数错误：需要 accountId 与 role(publisher/commenter)' });
    }
    const results = { legacy: null, v2: null };
    // 旧账号（策略/监控使用）：ipRole
    const oldAcc = AccountManager.getById(accountId);
    if (oldAcc) {
      AccountManager.update(accountId, { ipRole: role });
      results.legacy = { id: accountId, ipRole: role };
    }
    // v2 账号（养号/本地登录）：accountType
    const v2Acc = AccountManagerV2Inst.get(accountId);
    if (v2Acc) {
      AccountManagerV2Inst.update(accountId, { accountType: role === 'publisher' ? ACCOUNT_TYPE.VIDEO_PUBLISHER : ACCOUNT_TYPE.COMMENT_ACCOUNT });
      results.v2 = { id: accountId, accountType: role === 'publisher' ? ACCOUNT_TYPE.VIDEO_PUBLISHER : ACCOUNT_TYPE.COMMENT_ACCOUNT };
    }
    // 按 uid 兜底：部分账号只在其中一套存储
    if (!results.legacy && !results.v2) {
      const uidMatch = AccountManagerV2Inst.getByUid(accountId);
      if (uidMatch) {
        AccountManagerV2Inst.update(uidMatch.id, { accountType: role === 'publisher' ? ACCOUNT_TYPE.VIDEO_PUBLISHER : ACCOUNT_TYPE.COMMENT_ACCOUNT });
        results.v2 = { id: uidMatch.id, accountType: role === 'publisher' ? ACCOUNT_TYPE.VIDEO_PUBLISHER : ACCOUNT_TYPE.COMMENT_ACCOUNT };
      }
    }
    if (!results.legacy && !results.v2) return res.json({ code: -1, message: '未找到该账号' });
    res.json({ code: 0, data: { accountId, role, results } });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});
// ============================================================
// v3.1 Cookie 延迟使用调度 API（温号期/活跃窗口/错峰刷新）
// ============================================================
// 获取单个账号使用策略（温号等级 + 活跃窗口 + 各操作是否开放）
app.get('/api/v2/accounts/:id/usage-policy', (req, res) => {
  try {
    const p = AccountManagerV2Inst.getUsagePolicy(req.params.id);
    if (!p) return res.json({ code: -1, message: '账号不存在' });
    res.json({ code: 0, data: p });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});
// 获取所有账号使用策略
app.get('/api/v2/usage-policies', (req, res) => {
  res.json({ code: 0, data: AccountManagerV2Inst.getAllUsagePolicies() });
});
// 手动重置温号期（如：导入真实老号后想跳过冷静期，或新号想重新冷静）
app.post('/api/v2/accounts/:id/warmup/reset', (req, res) => {
  const acc = AccountManagerV2Inst.get(req.params.id);
  if (!acc) return res.json({ code: -1, message: '账号不存在' });
  const { disabled } = req.body || {};
  acc.warmUpStartedAt = new Date().toISOString();
  acc.warmUpDurationHours = 0; // 0 = 默认72h
  acc.warmUpDisabled = !!disabled;
  AccountManagerV2Inst.ensureSchedulingFields(acc);
  AccountManagerV2Inst._save();
  res.json({ code: 0, data: AccountManagerV2Inst.getUsagePolicy(acc.id), message: `温号期已${disabled ? '关闭' : '重置'}` });
});
// 手动触发错峰刷新（仅刷新"到期待刷新"账号）
app.post('/api/v2/accounts/refresh-due', async (req, res) => {
  try {
    const due = AccountManagerV2Inst.getRefreshDue();
    res.json({ code: 0, data: { due: due.map(a => ({ id: a.id, uid: a.uid, nextRefreshAt: a.nextRefreshAt })) }, message: `当前${due.length}个账号到期待刷新（自动调度会在5分钟内逐个执行）` });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// ============================================================
// bili-api 模块 API（基于HAR分析的完整B站API封装）
// ============================================================

// 辅助：为指定账号创建BiliClient
// 改进1：使用账号注册时的中国IP（IP粘性），失效才重分配新IP（resolveAccountProxy）
function createBiliClientForAccount(accountId) {
  const acc = AccountManagerV2Inst.get(accountId);
  if (!acc) return null;
  // 使用账号的完整设备环境（本地登录时采集），确保后端操作与登录时环境一致，降低平台安全机制
  const proxy = resolveAccountProxy(accountId);
  return new BiliClient({
    cookieStr: acc.cookieStr,
    csrf: acc.csrf,
    userAgent: acc.userAgent || undefined,
    deviceProfile: acc.deviceProfile || undefined,
    proxy: proxy ? proxy.proxy : (typeof acc.proxy === 'string' ? acc.proxy : undefined),
    maxQps: 2,
  });
}

// 改进1：账号注册IP粘性 —— 优先复用本地登录时使用的中国IP，直到该IP失效才重新分配
// 本地登录已把注册IP缓存到 account.proxy；这里校验其是否仍在可用池，失效则重分配并写回账号
function resolveAccountProxy(accountId) {
  const acc = AccountManagerV2Inst.get(accountId);
  if (!acc) return null;
  const boundProxy = typeof acc.proxy === 'string' ? acc.proxy : (acc.proxy && acc.proxy.proxy) || null;
  // 1) IP粘性：注册IP仍可用 → 继续使用（不产生占用）
  if (boundProxy) {
    const alive = isProxyReady(boundProxy);
    if (alive) return alive;
    console.log(`[IP-Sticky] 账号 ${accountId} 注册IP ${boundProxy} 已失效，重新分配`);
  }
  // 2) 失效/未绑定 → 从中国IP池新分配并写回账号（持久化绑定，供后续粘性使用）
  const np = getProxy();
  if (np) {
    AccountManagerV2Inst.update(accountId, { proxy: np.proxy, proxyCity: np.city || '' });
    console.log(`[IP-Sticky] 账号 ${accountId} 重新分配IP: ${np.proxy} (${np.city || '未知'})`);
    return np;
  }
  return null;
}

// 改进1：定时检查账号绑定IP健康度（Render 自动化运行：失效IP自动重分配）
function startAccountProxySweep(intervalMs = 30 * 60 * 1000) {
  const sweep = async () => {
    try {
      const accounts = AccountManagerV2Inst.getAll();
      let reallocated = 0;
      for (const acc of accounts) {
        const boundProxy = typeof acc.proxy === 'string' ? acc.proxy : (acc.proxy && acc.proxy.proxy) || null;
        if (boundProxy && !isProxyReady(boundProxy)) {
          const np = getProxy();
          if (np) {
            AccountManagerV2Inst.update(acc.id, { proxy: np.proxy, proxyCity: np.city || '' });
            reallocated++;
            console.log(`[IP-Sweep] 账号 ${acc.id} 失效IP ${boundProxy} → 新IP ${np.proxy}`);
          }
        }
      }
      if (reallocated > 0) console.log(`[IP-Sweep] 本轮重分配 ${reallocated} 个账号的失效IP`);
    } catch (e) {
      console.error('[IP-Sweep] 扫描异常:', e.message);
    }
  };
  sweep();
  setInterval(sweep, intervalMs);
  console.log(`[IP-Sweep] 账号IP健康扫描已启动（每${intervalMs / 60000}分钟）`);
}

// 检测评论是否存在（监控用）
app.post('/api/bili/comment/check', async (req, res) => {
  try {
    const { accountId, oid, rpid } = req.body;
    if (!accountId || !oid || !rpid) return res.json({ code: -1, message: '缺少参数' });
    const client = createBiliClientForAccount(accountId);
    if (!client) return res.json({ code: -1, message: '账号不存在' });
    const commentApi = new CommentAPI(client);
    const result = await commentApi.checkCommentExists(oid, rpid);
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// 获取视频信息
app.get('/api/bili/video/info', async (req, res) => {
  try {
    const { bvid, accountId } = req.query;
    if (!bvid) return res.json({ code: -1, message: '缺少bvid' });
    const client = accountId ? createBiliClientForAccount(accountId) : new BiliClient();
    const videoApi = new VideoAPI(client);
    const result = await videoApi.getInfo(bvid);
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// 获取用户所有视频（监控轮询用）
app.get('/api/bili/user/videos', async (req, res) => {
  try {
    const { mid, accountId, maxPages = 3 } = req.query;
    if (!mid) return res.json({ code: -1, message: '缺少mid' });
    const client = accountId ? createBiliClientForAccount(accountId) : new BiliClient();
    const videoApi = new VideoAPI(client);
    const result = await videoApi.getUserVideos(mid, 30, parseInt(maxPages));
    res.json({ code: 0, data: result, count: result.length });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// 评论区描述（含UP主ID，独立运营用）
app.get('/api/bili/comment/subject', async (req, res) => {
  try {
    const { oid, accountId } = req.query;
    if (!oid) return res.json({ code: -1, message: '缺少oid' });
    const client = accountId ? createBiliClientForAccount(accountId) : new BiliClient();
    const commentApi = new CommentAPI(client);
    const result = await commentApi.getSubjectDescription(oid);
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// 养号行为模拟
app.post('/api/bili/nurture', async (req, res) => {
  try {
    const { accountId, bvids = [], minActions = 2, maxActions = 5 } = req.body;
    if (!accountId) return res.json({ code: -1, message: '缺少accountId' });
    const client = createBiliClientForAccount(accountId);
    if (!client) return res.json({ code: -1, message: '账号不存在' });
    const simulator = new BehaviorSimulator(client);
    const result = await simulator.nurtureSession({ bvids, minActions, maxActions });
    res.json({ code: 0, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});

// 给评论点赞（推热度用）
app.post('/api/bili/comment/like', async (req, res) => {
  try {
    const { accountId, oid, rpid } = req.body;
    if (!accountId || !oid || !rpid) return res.json({ code: -1, message: '缺少参数' });
    const client = createBiliClientForAccount(accountId);
    if (!client) return res.json({ code: -1, message: '账号不存在' });
    const commentApi = new CommentAPI(client);
    const result = await commentApi.like(oid, rpid);
    res.json({ code: result.success ? 0 : -1, data: result });
  } catch (e) {
    res.json({ code: -1, message: e.message });
  }
});


const server = app.listen(PORT, () => {
  console.log(`🚀 B站内容互动管理平台后端启动，端口: ${PORT}`);
  // v2定时：每6小时健康度检查
  setInterval(() => {
    try {
      const r = AccountManagerV2Inst.checkAllHealth();
      console.log(`[v2] 健康度检查: 平均分${r.summary.avgScore}, 预警${r.alerts.length}个`);
    } catch (e) { console.error('[v2] 健康度检查失败:', e.message); }
  }, 6 * 60 * 60 * 1000);
  // 改进1：账号注册IP健康扫描（失效自动重分配，Render 自动化运行）
  startAccountProxySweep(30 * 60 * 1000);
  // v3.1 错峰刷新：每账号独立随机刷新时刻，到点逐个刷新（账号间 20~40 分钟间隔）
  // 替代旧版"凌晨3点全体齐刷"（多账号同时刷新 = 集群关联信号）
  setInterval(async () => {
    try {
      const due = AccountManagerV2Inst.getRefreshDue();
      if (due.length === 0) return;
      console.log(`[v3.1] 错峰刷新: ${due.length} 个账号到期待刷新`);
      // 逐个后台执行，账号间由 refreshDueAccounts 内部随机间隔控制
      const r = await AccountManagerV2Inst.refreshDueAccounts();
      console.log(`[v3.1] 错峰刷新完成: 成功${r.success}, 失败${r.failed}, 跳过${r.skipped}`);
    } catch (e) { console.error('[v3.1] 错峰刷新失败:', e.message); }
  }, 5 * 60 * 1000); // 每5分钟检查一次"到期待刷新"账号
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
// v3.1 管理鉴权：写操作必须携带 AdminToken
//  - GET/HEAD/OPTIONS 放行（只读看板兼容旧前端）
//  - POST/PUT/DELETE 需 Authorization: Bearer <token> / X-Admin-Token / ?token=
// ============================================================

// ============================================================
// 根路径：服务信息（供前端/浏览器确认服务在线）
// ============================================================
app.get('/', (req, res) => {
  res.json({
    name: 'Bilibili Comment Target Backend',
    version: '3.1.0',
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
  // -101=未登录 -102=账号受限 -352=平台安全机制
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
      version: '3.1.0',
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
// v2.2 新增：策略引擎 / 监控引擎 / 安全看板 / 设置持久化
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
// ---- 安全看板 ----
app.get('/api/risk/dashboard', (req, res) => {
  res.json(getRiskDashboard());
});
// 安全事件流（前端预警）
app.get('/api/risk/events', (req, res) => {
  res.json({ code: 0, data: { events: AccountManager.getAllRiskEvents().slice(0, 50) } });
});
// 账号健康度/运营关联度（前端热力图）
app.get('/api/risk/accounts', (req, res) => {
  res.json({ code: 0, data: AccountManager.getHealthHeatmap() });
});
// 手动设置账号静默
app.post('/api/risk/mute', (req, res) => {
  const { accountId, minutes = 60 } = req.body || {};
  const ok = AccountManager.setMute(accountId, minutes);
  res.json({ code: ok ? 0 : -1, message: ok ? `账号已静默 ${minutes} 分钟` : '账号不存在' });
});
// 手动重新计算所有账号运营关联度分
app.post('/api/risk/recompute', (req, res) => {
  const list = AccountManager.getAll();
  for (const a of list) AccountManager.computeRiskScore(a.id);
  res.json({ code: 0, message: `已重算 ${list.length} 个账号的运营关联度分` });
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
// ---- 代理占用统计（独立运营） ----
app.get('/api/proxy/occupancy', (req, res) => {
  res.json({ code: 0, data: getOccupancyStats() });
});
// ---- 文案重组/内容互动变体（前端文案工作台调用） ----
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
// v2.3 独立运营：养号引擎 API
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
// v2.3 独立运营：账号活跃时段 / IP角色 / 社交隔离 API
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
// v2.3 独立运营：弱相关文案 / 风险详情 API
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
║   Bilibili Comment Target Backend v3.1.0                  ║
║   B站内容互动管理平台 · 后端服务 v2.2                       ║
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
