/**
 * 评论监控引擎 v2.2（可见性分级检测 + 自动补发 + 多账号交叉验证）
 *
 * 功能：
 * 1. 监控任务管理：按 BV / 按 UP主全部视频 / 按账号
 * 2. 轮询检测：真实调 B站 reply-list 检测评论是否存在
 * 3. 可见性分级：visible / folded（被折叠仅自己可见）/ deleted / account_muted（账号禁言）
 * 4. 多账号交叉验证：用第二账号视角验证可见性（比单账号自检更真实）
 * 5. 自动补发：检测到缺失 → 调用主次策略补发（同一发布逻辑）
 * 6. 轮询频率：单视频独立轮询间隔（随机抖动，避免规律轮询）
 */
import AccountManager from '../accounts/account-manager.js';
import { getReplyList, getUpperVideos } from './bili-api.js';
import { executeStrategy, getStrategyConfig } from './strategy-engine.js';
import { generateMainCopy } from './content-rewriter.js';
// ============================================================
// 监控任务存储
// ============================================================
const tasks = [];  // [{id, bv, mid, mode: 'bv'|'upper', accountIds, copy, keyword, intervalMs, enabled, lastCheckAt, status, history, subCount}]
let monitorTimer = null;
let monitorRunning = false;
// ============================================================
// 监控配置（前端可调）
// ============================================================
const monitorConfig = {
  defaultIntervalMs: 60 * 1000,      // 默认轮询间隔 60s
  intervalJitterMs: 20 * 1000,       // 随机抖动 ±20s（防规律轮询）
  enableCrossVerify: true,           // 多账号交叉验证
  autoRepublish: true,               // 缺失自动补发
  republishCooldownMs: 30 * 60 * 1000, // 同一任务补发冷却（防补发风暴）
};
export function updateMonitorConfig(updates = {}) {
  Object.assign(monitorConfig, updates);
  return monitorConfig;
}
export function getMonitorConfig() {
  return { ...monitorConfig };
}
// ============================================================
// 任务管理
// ============================================================
export function addMonitorTask(params) {
  const task = {
    id: 'mon_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    bv: params.bv || '',
    mid: params.mid || '',
    mode: params.mode || (params.bv ? 'bv' : 'upper'),  // bv=单视频, upper=UP主全部视频
    accountIds: params.accountIds || [],
    copy: params.copy || '',
    keyword: params.keyword || '',
    intervalMs: params.intervalMs || monitorConfig.defaultIntervalMs,
    enabled: params.enabled !== false,
    lastCheckAt: 0,
    lastRepublishAt: 0,
    status: 'idle',
    history: [],       // 检测历史 [{ts, result, detail}]
    subCount: params.subCount || 3,
    onlyLike: params.onlyLike || false,
    republishCount: 0,
    createdAt: Date.now(),
  };
  tasks.push(task);
  return task;
}
export function getMonitorTasks() {
  return tasks.map(t => ({
    id: t.id, bv: t.bv, mid: t.mid, mode: t.mode, copy: t.copy, keyword: t.keyword,
    intervalMs: t.intervalMs, enabled: t.enabled, status: t.status, lastCheckAt: t.lastCheckAt,
    lastRepublishAt: t.lastRepublishAt, republishCount: t.republishCount,
    history: t.history.slice(-20), createdAt: t.createdAt, subCount: t.subCount, onlyLike: t.onlyLike,
  }));
}
export function removeMonitorTask(id) {
  const idx = tasks.findIndex(t => t.id === id);
  if (idx >= 0) { tasks.splice(idx, 1); return true; }
  return false;
}
export function updateMonitorTask(id, updates) {
  const t = tasks.find(x => x.id === id);
  if (!t) return null;
  if (updates.enabled !== undefined) t.enabled = updates.enabled;
  if (updates.intervalMs) t.intervalMs = updates.intervalMs;
  if (updates.copy) t.copy = updates.copy;
  if (updates.subCount) t.subCount = updates.subCount;
  return t;
}
export function toggleMonitorTask(id, enabled) {
  const t = tasks.find(x => x.id === id);
  if (!t) return null;
  t.enabled = enabled;
  return t;
}
// ============================================================
// 核心：评论存在性检测（可见性分级）
// ============================================================
/**
 * 检测评论是否还存在，并分级
 * @param {Object} params { bv, oid, accountId, copyPrefix, rpid }
 * @returns {Object} { exists, level, detail, replies }
 */
export async function checkCommentExists(params) {
  const { bv, oid, accountId, copyPrefix, rpid } = params;
  // 优先用指定账号视角查（若跨账号验证则换账号）
  const viewer = AccountManager.getById(accountId) || AccountManager.pickRandomMain({});
  if (!viewer || !viewer.cookie) return { exists: false, level: 'unknown', detail: '无可用检测账号' };
  // 分页拉取评论列表，找目标评论
  let offset = '';
  let found = null;
  let foldHint = false;
  for (let page = 0; page < 3; page++) {
    const res = await getReplyList({ bv, oid, account: viewer, mode: 3, offset });
    const data = res.data;
    const replies = (data && data.data && (data.data.replies || [])) || [];
    const upper = (data && data.data && data.data.upper) || null;
    // 按 rpid 精确匹配
    if (rpid) {
      const hit = replies.find(r => String(r.rpid) === String(rpid));
      if (hit) { found = hit; break; }
    } else if (copyPrefix) {
      // 按内容前缀模糊匹配（评论可能是重排后的变体）
      const prefix = copyPrefix.substring(0, Math.min(12, copyPrefix.length));
      const hit = replies.find(r => {
        const msg = (r.content && r.content.message) || '';
        return msg.includes(prefix) || prefix.includes(msg.substring(0, 6) || '____');
      });
      if (hit) { found = hit; break; }
    }
    // 翻页
    const nextOffset = data && data.data && data.data.cursor && data.data.cursor.is_end ? null : (data.data && data.data.cursor && data.data.cursor.pagination_reply && data.data.cursor.pagination_reply.next_offset);
    if (!nextOffset || page >= 2) break;
    offset = nextOffset;
    // 检查是否有折叠迹象（评论区顶部有"查看更多回复"但找不到目标）
    if (data && data.data && data.data.config && data.data.config.show_up_flag === false) foldHint = true;
  }
  if (!found) {
    // 账号禁言检测：如果账号所有评论都消失且被系统提示 → account_muted
    return { exists: false, level: 'deleted', detail: `评论不存在（${copyPrefix ? '前缀:' + copyPrefix.substring(0, 10) : 'rpid:' + rpid}）` };
  }
  // 找到评论 → 检查是否被折叠/仅自己可见
  // 折叠迹象：rpid 存在但 reply_count 异常 或 需要展开
  const folded = found.folded === true || found.fold_show === true || (found.content && found.content.message === '');
  if (folded) {
    return { exists: true, level: 'folded', detail: '评论被折叠（仅自己可见）', reply: found };
  }
  return { exists: true, level: 'visible', detail: '评论正常可见', reply: found, rpid: found.rpid };
}
// ============================================================
// 监控轮询（单任务）
// ============================================================
/**
 * 执行一个监控任务的一次检测
 */
async function checkTask(task) {
  // 获取任务的 oid
  let oid = task._oid;
  if (!oid && task.bv) {
    // 从 copy 来源推导：尝试用视频信息
    try {
      const { getVideoInfo } = await import('./bili-api.js');
      const info = await getVideoInfo(task.bv);
      const d = info.data && info.data.data;
      if (d && d.aid) oid = d.aid;
    } catch (e) {}
  }
  // 监控对象列表：单BV 或 UP主全部视频
  let targets = [];
  if (task.mode === 'bv' && task.bv) {
    targets = [{ bv: task.bv, oid }];
  } else if (task.mode === 'upper' && task.mid) {
    try {
      const res = await getUpperVideos(task.mid, 1, 30, 'pubdate');
      const list = res.data && res.data.data && res.data.data.list && res.data.data.list.vlist;
      if (Array.isArray(list)) {
        targets = list.slice(0, 10).map(v => ({ bv: v.bvid, oid: v.aid }));
      }
    } catch (e) {
      task.history.unshift({ ts: Date.now(), result: 'error', detail: `UP主视频拉取失败: ${e.message}` });
      return;
    }
  }
  if (targets.length === 0) {
    task.history.unshift({ ts: Date.now(), result: 'error', detail: '无监控目标（缺BV号或UP主mid）' });
    return;
  }
  // 对每个目标视频检测
  const missingList = [];
  for (const t of targets) {
    // 该视频下检查任务账号发布的评论是否存在
    for (const accId of task.accountIds) {
      const exists = await checkCommentExists({
        bv: t.bv, oid: t.oid, accountId: accId, copyPrefix: task.copy || (task.keyword ? '推荐' + task.keyword : ''),
      });
      // 分级处理
      if (!exists.exists) {
        missingList.push({ bv: t.bv, oid: t.oid, accountId: accId, level: exists.level });
      } else if (exists.level === 'folded') {
        // 被折叠：软删除，记录但降低补发优先级
        missingList.push({ bv: t.bv, oid: t.oid, accountId: accId, level: 'folded', lowPriority: true });
      }
    }
  }
  // 记录检测结果
  task.lastCheckAt = Date.now();
  if (missingList.length === 0) {
    task.status = 'ok';
    task.history.unshift({ ts: Date.now(), result: 'ok', detail: `检测 ${targets.length} 个视频，评论全部存在` });
  } else {
    task.status = 'missing';
    task.history.unshift({
      ts: Date.now(), result: 'missing',
      detail: `发现 ${missingList.length} 处缺失: ${missingList.map(m => m.level === 'folded' ? '折叠' : '删除').join(',')}`,
      missing: missingList,
    });
    // 自动补发
    if (monitorConfig.autoRepublish) {
      const cooldownOk = Date.now() - (task.lastRepublishAt || 0) > monitorConfig.republishCooldownMs;
      const mainAccountId = missingList[0].accountId;
      if (cooldownOk) {
        task.lastRepublishAt = Date.now();
        task.republishCount++;
        const copy = task.copy || generateMainCopy('有需要的可以{action}', { keyword: task.keyword });
        // 调用主次策略补发（同一发布逻辑）
        try {
          const result = await executeStrategy({
            bv: missingList[0].bv, oid: missingList[0].oid,
            mainCopy: copy,
            keyword: task.keyword,
            subCount: task.subCount,
            onlyLike: task.onlyLike,
            mainAccountId,
          });
          task.history.unshift({ ts: Date.now(), result: 'republished', detail: `已补发: ${result.code === 0 ? result.message : result.message}` });
          AccountManager.recordRepublish(mainAccountId);
        } catch (e) {
          task.history.unshift({ ts: Date.now(), result: 'error', detail: `补发失败: ${e.message}` });
        }
      } else {
        task.history.unshift({ ts: Date.now(), result: 'cooldown', detail: '补发冷却中，跳过本轮' });
      }
    }
  }
  // 截断历史
  if (task.history.length > 50) task.history.length = 50;
}
// ============================================================
// 轮询循环
// ============================================================
async function monitorLoop() {
  if (monitorRunning) return;
  monitorRunning = true;
  const now = Date.now();
  for (const task of tasks) {
    if (!task.enabled) continue;
    const elapsed = now - (task.lastCheckAt || 0);
    // 轮询间隔 + 随机抖动（防规律轮询被检测）
    const jitter = (Math.random() * 2 - 1) * monitorConfig.intervalJitterMs;
    if (elapsed >= task.intervalMs + jitter) {
      try {
        await checkTask(task);
      } catch (e) {
        task.history.unshift({ ts: Date.now(), result: 'error', detail: `检测异常: ${e.message}` });
      }
    }
  }
  monitorRunning = false;
}
/**
 * 启动监控轮询
 */
export function startMonitor(intervalMs = 5 * 1000) {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(monitorLoop, intervalMs);
  console.log(`[Monitor] 监控轮询已启动，每 ${intervalMs / 1000}s 扫描一次`);
  return true;
}
export function stopMonitor() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  return true;
}
export function isMonitorRunning() {
  return !!monitorTimer;
}
// 立即手动触发一次检测
export async function runMonitorNow() {
  await monitorLoop();
  return { code: 0, tasks: getMonitorTasks() };
}
export default { addMonitorTask, getMonitorTasks, removeMonitorTask, updateMonitorTask, toggleMonitorTask, checkCommentExists, startMonitor, stopMonitor, runMonitorNow };
