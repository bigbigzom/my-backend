/**
 * GrowthSystem - 账号成长等级体系（v7.1 新增）
 *
 * 职责：账号等级成长（新手→活跃→资深→KOL），根据互动数据升级
 * 等级越高，日评论限额越高，可参与高价值引流任务。
 * 调用 AccountService / MemoryService，不重复造轮子。
 */

const GROWTH_LEVELS = [
  { level: 1, name: '新手', dailyLimit: 3, minComments: 0, canFunnel: false },
  { level: 2, name: '活跃', dailyLimit: 8, minComments: 10, canFunnel: true },
  { level: 3, name: '资深', dailyLimit: 15, minComments: 50, canFunnel: true },
  { level: 4, name: '核心', dailyLimit: 25, minComments: 150, canFunnel: true },
  { level: 5, name: 'KOL', dailyLimit: 40, minComments: 400, canFunnel: true },
];

export class GrowthSystem {
  constructor({ accountService, memoryService }) {
    this.accountService = accountService;
    this.memoryService = memoryService;
  }

  /** 获取等级配置 */
  getLevels() { return GROWTH_LEVELS; }

  /**
   * 评估账号等级（基于历史互动数）
   * @param {string} accountId
   */
  evaluateLevel(accountId) {
    const history = this.memoryService?.getHistory(accountId, 500) || [];
    const totalComments = history.filter(h => h.type === 'comment' || h.type === 'reply').length;
    let currentLevel = 1;
    for (const lvl of GROWTH_LEVELS) {
      if (totalComments >= lvl.minComments) currentLevel = lvl.level;
    }
    const levelConfig = GROWTH_LEVELS.find(l => l.level === currentLevel);
    // 更新账号
    this.accountService.update(accountId, {
      growthLevel: currentLevel,
      growthLevelName: levelConfig.name,
    });
    return {
      accountId, level: currentLevel, levelName: levelConfig.name,
      totalComments, dailyLimit: levelConfig.dailyLimit,
      canFunnel: levelConfig.canFunnel,
      nextLevel: GROWTH_LEVELS.find(l => l.level === currentLevel + 1) || null,
    };
  }

  /** 批量评估 */
  evaluateAll() {
    const accounts = this.accountService.list({ active: true });
    return accounts.map(a => {
      try { return this.evaluateLevel(a.id || a.uid); }
      catch (e) { return { accountId: a.id || a.uid, error: e.message }; }
    });
  }

  /** 获取账号日限额（取画像限额和等级限额的较小值） */
  getDailyLimit(accountId, personaLimit) {
    const result = this.evaluateLevel(accountId);
    const levelLimit = result.dailyLimit || 3;
    return Math.min(levelLimit, personaLimit || levelLimit);
  }

  /** 检查账号是否可参与矩阵引流 */
  canParticipateFunnel(accountId) {
    const result = this.evaluateLevel(accountId);
    return result.canFunnel;
  }
}

export default GrowthSystem;
