/**
 * 风控服务（v4.0 OOP重构）
 */
import { getRiskDashboard, audit, getAuditLogs } from '../src/utils/risk-monitor.js';

export class RiskService {
  getDashboard() { return getRiskDashboard(); }
  audit(event) { return audit(event); }
  getLogs(filters) { return getAuditLogs(filters); }
  getAccounts() { return getRiskDashboard().accounts || []; }
  muteAccount(id, reason) { return audit({ type: 'mute', accountId: id, reason }); }
  recompute() { return audit({ type: 'recompute' }); }
}
export default RiskService;
