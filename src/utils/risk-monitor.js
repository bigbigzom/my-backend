/**
 * 风控监控与审计 v2.2
 *
 * 1. 账号健康度画像（已由 account-manager 维护，这里提供聚合视图）
 * 2. 风控事件实时流（前端预警）
 * 3. 关联风险评分看板（去关联策略的可量化指标）
 * 4. 审计日志（全链路留痕，供复盘）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AccountManager from '../accounts/account-manager.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIT_FILE = path.join(__dirname, '../models/audit.json');
// ============================================================
// 审计日志（简单追加型，存内存+文件）
// ============================================================
let auditLogs = [];
try {
  if (fs.existsSync(AUDIT_FILE)) {
    auditLogs = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8') || '[]');
  }
} catch (e) {}
function saveAudit() {
  try {
    const dir = path.dirname(AUDIT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(auditLogs.slice(-500), null, 2));
  } catch (e) {}
}
/**
 * 记录审计日志
 * @param {String} op 操作类型
 * @param {Object} data { accountId, username, bv, rpid, proxy, fingerprintId, code, message, result }
 */
export function audit(op, data = {}) {
  const entry = {
    ts: Date.now(),
    op,
    accountId: data.accountId || null,
    username: data.username || '',
    bv: data.bv || '',
    rpid: data.rpid || '',
    proxy: data.proxy || '',
    fingerprintId: data.fingerprintId || '',
    code: data.code || '',
    message: data.message || '',
    result: data.result || '',
  };
  auditLogs.push(entry);
  if (auditLogs.length > 500) auditLogs.shift();
  saveAudit();
  return entry;
}
export function getAuditLogs(limit = 100) {
  return [...auditLogs].reverse().slice(0, limit);
}
// ============================================================
// 风控/关联风险看板
// ============================================================
/**
 * 获取风控看板数据（前端仪表盘）
 * - 账号健康度热力图
 * - 风控事件流
 * - 关联风险评分
 * - 聚合统计
 */
export function getRiskDashboard() {
  const accounts = AccountManager.getAll();
  // 风控事件流
  const events = AccountManager.getAllRiskEvents();
  // 关联风险TOP
  const riskTop = accounts
    .map(a => ({ id: a.id, username: a.username, riskScore: a.riskScore || 0, health: a.health?.score || 100, signals: (a.riskSignals || []).length }))
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 10);
  // 高健康 / 低健康统计
  const stats = {
    highHealth: accounts.filter(a => (a.health?.score || 100) >= 80).length,
    mediumHealth: accounts.filter(a => (a.health?.score || 100) >= 50 && (a.health?.score || 100) < 80).length,
    lowHealth: accounts.filter(a => (a.health?.score || 100) < 50).length,
    totalRiskEvents: events.length,
    highRiskAccounts: accounts.filter(a => (a.riskScore || 0) >= 50).length,
  };
  return {
    code: 0,
    data: {
      events: events.slice(0, 50),
      riskTop,
      heatmap: AccountManager.getHealthHeatmap(),
      stats,
      auditRecent: getAuditLogs(30),
    },
  };
}
export default { audit, getAuditLogs, getRiskDashboard };
