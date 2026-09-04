/**
 * 策略服务（v4.0 OOP重构）
 */
import { executeStrategy, updateStrategyConfig, getStrategyConfig } from '../src/utils/strategy-engine.js';

export class StrategyService {
  async execute(params) { return executeStrategy(params); }
  getConfig() { return getStrategyConfig(); }
  updateConfig(patch) { return updateStrategyConfig(patch); }
  applyTemplate(template) {
    const config = this.getConfig();
    return this.updateConfig({ ...config, ...template });
  }
}
export default StrategyService;
