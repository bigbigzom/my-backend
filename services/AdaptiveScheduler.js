/**
 * AdaptiveScheduler - 智能调度器（v7.1 新增）
 *
 * 职责：基于账号成功率/风控等级/活跃时段/画像，动态分配任务
 * 调用所有Service，是定时任务和API路由的统一入口。
 */

export class AdaptiveScheduler {
  constructor({
    accountService, behaviorEngine, commentService, funnelStrategyService,
    riskController, globalPolicyService, growthSystem, memoryService,
  }) {
    this.accountService = accountService;
    this.behaviorEngine = behaviorEngine;
    this.commentService = commentService;
    this.funnelStrategyService = funnelStrategyService;
    this.riskController = riskController;
    this.globalPolicyService = globalPolicyService;
    this.growthSystem = growthSystem;
    this.memoryService = memoryService;
    this.dailyStats = { date: this._today(), comments: 0 };
    this.hourlyStats = { hour: new Date().getHours(), comments: 0 };
    this.running = false;
    this.timer = null;
  }

  /** 启动定时调度（每5分钟检查一次） */
  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this._tick(), 5 * 60 * 1000);
    console.log('[AdaptiveScheduler] 已启动，每5分钟调度一次');
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    console.log('[AdaptiveScheduler] 已停止');
  }

  /**
   * 为指定视频执行矩阵引流（手动触发）
   */
  async runFunnel({ bvid, mainComment, override }) {
    const pre = this._preDispatchCheck();
    if (!pre.allowed) return { skipped: true, reason: pre.reason };

    const task = await this.funnelStrategyService.createTask({ bvid, mainComment, override });
    return this.funnelStrategyService.execute(task.funnelId);
  }

  /**
   * 执行一轮养号任务（为所有活跃账号生成每日行为）
   */
  async runCultivationRound() {
    const pre = this._preDispatchCheck();
    if (!pre.allowed) return { skipped: true, reason: pre.reason };

    const accounts = this.accountService.list({ active: true })
      .filter(a => a.accountType !== 'publisher' && a.accountType !== 'video_publisher');
    const results = [];
    for (const account of accounts) {
      const id = account.id || account.uid;
      const check = this.riskController.preCheck(id);
      if (!check.allowed) { results.push({ accountId: id, skipped: true, reason: check.reason }); continue; }
      try {
        const result = await this.behaviorEngine.runDailyPlan(id);
        results.push({ accountId: id, success: true, ...result });
      } catch (e) {
        results.push({ accountId: id, success: false, error: e.message });
      }
      await this._sleep(3000);
    }
    return { total: accounts.length, results };
  }

  /** 获取调度状态 */
  getStatus() {
    return {
      running: this.running,
      dailyComments: this.dailyStats.comments,
      hourlyComments: this.hourlyStats.comments,
      globalMuted: this.riskController.globalMuted,
      activeHour: this.globalPolicyService.isActiveHour(),
    };
  }

  // ===== 内部 =====
  _tick() {
    // 重置统计
    const today = this._today();
    if (this.dailyStats.date !== today) {
      this.dailyStats = { date: today, comments: 0 };
    }
    const hour = new Date().getHours();
    if (this.hourlyStats.hour !== hour) {
      this.hourlyStats = { hour, comments: 0 };
    }
    // 非活跃时段跳过
    if (!this.globalPolicyService.isActiveHour()) return;
    // 全局熔断跳过
    if (this.riskController.globalMuted) return;
    // 限额检查
    if (!this.globalPolicyService.checkGlobalDailyLimit(this.dailyStats.comments)) return;
    if (!this.globalPolicyService.checkGlobalHourlyLimit(this.hourlyStats.comments)) return;

    console.log('[AdaptiveScheduler] 定时调度触发');
    this.runCultivationRound().catch(e => console.error('[AdaptiveScheduler] 调度失败:', e.message));
  }

  _preDispatchCheck() {
    if (this.riskController.globalMuted) return { allowed: false, reason: '全局熔断中' };
    if (!this.globalPolicyService.isActiveHour()) return { allowed: false, reason: '非活跃时段' };
    if (!this.globalPolicyService.checkGlobalDailyLimit(this.dailyStats.comments)) {
      return { allowed: false, reason: '全局日评论限额已用尽' };
    }
    return { allowed: true };
  }

  _today() { return new Date().toISOString().slice(0, 10); }
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

export default AdaptiveScheduler;
