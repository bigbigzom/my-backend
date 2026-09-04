/**
 * 养号服务（v4.0 OOP重构）
 */
import nurtureEngine from '../src/utils/nurture-engine.js';

export class NurtureService {
  getStats() { return nurtureEngine.getStats(); }
  getPlans() { return nurtureEngine.getPlans(); }
  getHistory() { return nurtureEngine.getHistory(); }
  async run(params) { return nurtureEngine.run(params); }
  start() { return nurtureEngine.start(); }
  stop() { return nurtureEngine.stop(); }
  updatePlan(accountId, plan) { return nurtureEngine.updatePlan(accountId, plan); }
}
export default NurtureService;
