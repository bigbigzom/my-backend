/**
 * FunnelStrategyService - 矩阵引流策略服务（v7.1 新增）
 *
 * 职责：编排矩阵引流全流程（主评论→子回复→点赞→随机评论→监控→补发）
 * 调用 CommentService / MonitorService / AccountService / ContentGenerator，不重复造轮子。
 *
 * 参数可自定义：
 * - mainCount: 主账号数量 (1 或 1+N)
 * - subCount: 子账号数量 (10+N)
 * - randomCount: 随机评论账号数量 (10+N)
 * - likeCount: 点赞账号数量 (5+N)
 * - delays: 各阶段延迟
 */

const DEFAULT_CONFIG = {
  mainCount: 1,
  subCount: 10,
  randomCount: 10,
  likeCount: 5,
  mainToSubDelay: { min: 2, max: 10 },   // 分钟
  subToLikeDelay: { min: 1, max: 5 },     // 分钟
  monitorPeriod: 24,                       // 小时
  autoRepublish: true,
  globalDailyLimit: 500,
  accountDailyLimit: 20,
};

export class FunnelStrategyService {
  constructor({ accountService, commentService, monitorService, contentGenerator, memoryService }) {
    this.accountService = accountService;
    this.commentService = commentService;
    this.monitorService = monitorService;
    this.contentGenerator = contentGenerator;
    this.memoryService = memoryService;
    this.config = { ...DEFAULT_CONFIG };
    this.activeTasks = new Map(); // funnelId -> task state
    this.completedTasks = [];
  }

  /** 更新全局配置 */
  updateConfig(patch) {
    this.config = { ...this.config, ...patch };
    return this.config;
  }

  /** 获取配置 */
  getConfig() {
    return { ...this.config };
  }

  /**
   * 创建矩阵引流任务
   * @param {Object} params
   * @param {string} params.bvid - 目标视频BV号
   * @param {string} [params.oid] - 视频oid（不传则从bvid获取）
   * @param {string} [params.mainComment] - 主评论内容（不传则自动生成）
   * @param {Object} [params.override] - 覆盖默认配置
   */
  async createTask({ bvid, oid, mainComment, override = {} }) {
    const cfg = { ...this.config, ...override };
    const funnelId = `funnel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    // 选择账号（排除publisher类型）
    const allAccounts = this.accountService.list({ active: true })
      .filter(a => a.accountType !== 'publisher' && a.accountType !== 'video_publisher');

    if (allAccounts.length < cfg.mainCount + 1) {
      throw new Error(`可用评论账号不足，需要至少${cfg.mainCount + 1}个`);
    }

    // 随机打乱并分组
    const shuffled = [...allAccounts].sort(() => Math.random() - 0.5);
    const mainAccounts = shuffled.slice(0, cfg.mainCount);
    const subAccounts = shuffled.slice(cfg.mainCount, cfg.mainCount + cfg.subCount);
    const likeAccounts = shuffled.slice(cfg.mainCount + cfg.subCount, cfg.mainCount + cfg.subCount + cfg.likeCount);
    const randomAccounts = shuffled.slice(
      cfg.mainCount + cfg.subCount + cfg.likeCount,
      cfg.mainCount + cfg.subCount + cfg.likeCount + cfg.randomCount
    );

    const task = {
      funnelId, bvid, oid: oid || bvid,
      config: cfg,
      mainAccounts: mainAccounts.map(a => a.id || a.uid),
      subAccounts: subAccounts.map(a => a.id || a.uid),
      likeAccounts: likeAccounts.map(a => a.id || a.uid),
      randomAccounts: randomAccounts.map(a => a.id || a.uid),
      mainComment,
      status: 'pending',
      progress: { main: 0, sub: 0, like: 0, random: 0 },
      results: { main: [], sub: [], like: [], random: [] },
      createdAt: new Date().toISOString(),
    };

    this.activeTasks.set(funnelId, task);
    console.log(`[FunnelStrategy] 创建引流任务 ${funnelId}: 主${mainAccounts.length}/子${subAccounts.length}/赞${likeAccounts.length}/随机${randomAccounts.length}`);
    return task;
  }

  /**
   * 执行矩阵引流（异步编排）
   * @param {string} funnelId - 任务ID
   */
  async execute(funnelId) {
    const task = this.activeTasks.get(funnelId);
    if (!task) throw new Error(`任务不存在: ${funnelId}`);
    task.status = 'running';

    try {
      // 阶段1：主账号发布评论
      await this._executeMainPhase(task);
      // 阶段2：子账号回复（延迟）
      this._scheduleSubPhase(task);
      // 阶段3：点赞（延迟）
      this._scheduleLikePhase(task);
      // 阶段4：随机评论（延迟）
      this._scheduleRandomPhase(task);
      // 阶段5：注册监控
      this._registerMonitor(task);

      task.status = 'running';
      return { funnelId, status: 'running', message: '引流任务已启动，各阶段按延迟执行' };
    } catch (e) {
      task.status = 'failed';
      task.error = e.message;
      console.error(`[FunnelStrategy] 任务 ${funnelId} 失败:`, e.message);
      throw e;
    }
  }

  /** 获取任务状态 */
  getTask(funnelId) {
    return this.activeTasks.get(funnelId) || this.completedTasks.find(t => t.funnelId === funnelId) || null;
  }

  /** 列出所有任务 */
  listTasks() {
    return [
      ...Array.from(this.activeTasks.values()),
      ...this.completedTasks.slice(-50),
    ];
  }

  // ===== 内部阶段执行 =====
  async _executeMainPhase(task) {
    for (const accountId of task.mainAccounts) {
      try {
        const content = task.mainComment || this.contentGenerator.generate({
          accountId, videoCategory: 'general', tone: 'praise',
        });
        const result = await this.commentService.addComment({
          accountId, oid: task.oid, message: content, type: 1,
        });
        task.results.main.push({ accountId, rpid: result.rpid, content, success: !!result.rpid });
        task.progress.main++;
        // 记录记忆
        this.memoryService?.recordInteraction(accountId, { type: 'comment', bvid: task.bvid, rpid: result.rpid });
      } catch (e) {
        task.results.main.push({ accountId, success: false, error: e.message });
      }
      // 主账号之间间隔
      await this._sleep(3000 + Math.random() * 5000);
    }
  }

  _scheduleSubPhase(task) {
    const delay = (task.config.mainToSubDelay.min + Math.random() * (task.config.mainToSubDelay.max - task.config.mainToSubDelay.min)) * 60000;
    setTimeout(async () => {
      const mainRpids = task.results.main.filter(r => r.rpid).map(r => r.rpid);
      for (const accountId of task.subAccounts) {
        try {
          const rootRpid = mainRpids[Math.floor(Math.random() * mainRpids.length)];
          const content = this.contentGenerator.generateReply({ accountId, mainComment: task.mainComment || '' });
          const result = await this.commentService.addReply({
            accountId, oid: task.oid, message: content, root: rootRpid, parent: rootRpid,
          });
          task.results.sub.push({ accountId, rpid: result.rpid, success: !!result.rpid });
          task.progress.sub++;
        } catch (e) {
          task.results.sub.push({ accountId, success: false, error: e.message });
        }
        await this._sleep(5000 + Math.random() * 10000);
      }
      this._checkComplete(task);
    }, delay);
  }

  _scheduleLikePhase(task) {
    const delay = ((task.config.mainToSubDelay.max + task.config.subToLikeDelay.min) * 60000);
    setTimeout(async () => {
      const mainRpids = task.results.main.filter(r => r.rpid).map(r => r.rpid);
      for (const accountId of task.likeAccounts) {
        try {
          const rpid = mainRpids[Math.floor(Math.random() * mainRpids.length)];
          if (rpid) {
            await this.commentService.likeComment({ accountId, oid: task.oid, rpid, action: 1 });
          }
          task.results.like.push({ accountId, success: true });
          task.progress.like++;
        } catch (e) {
          task.results.like.push({ accountId, success: false, error: e.message });
        }
        await this._sleep(2000 + Math.random() * 3000);
      }
      this._checkComplete(task);
    }, delay);
  }

  _scheduleRandomPhase(task) {
    const delay = (task.config.mainToSubDelay.max + task.config.subToLikeDelay.max + 2) * 60000;
    setTimeout(async () => {
      for (const accountId of task.randomAccounts) {
        try {
          const content = this.contentGenerator.generate({ accountId, tone: 'random' });
          const result = await this.commentService.addComment({
            accountId, oid: task.oid, message: content, type: 1,
          });
          task.results.random.push({ accountId, rpid: result.rpid, success: !!result.rpid });
          task.progress.random++;
        } catch (e) {
          task.results.random.push({ accountId, success: false, error: e.message });
        }
        await this._sleep(8000 + Math.random() * 15000);
      }
      this._checkComplete(task);
    }, delay);
  }

  _registerMonitor(task) {
    if (this.monitorService) {
      const mainRpids = task.results.main.filter(r => r.rpid).map(r => r.rpid);
      for (const rpid of mainRpids) {
        this.monitorService.add({
          bvid: task.bvid, oid: task.oid, rpid,
          funnelId: task.funnelId,
          checkInterval: 3600000, // 1小时
          duration: task.config.monitorPeriod * 3600000,
          autoRepublish: task.config.autoRepublish,
        });
      }
    }
  }

  _checkComplete(task) {
    const total = task.mainAccounts.length + task.subAccounts.length + task.likeAccounts.length + task.randomAccounts.length;
    const done = task.progress.main + task.progress.sub + task.progress.like + task.progress.random;
    if (done >= total) {
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      this.activeTasks.delete(task.funnelId);
      this.completedTasks.push(task);
      console.log(`[FunnelStrategy] 任务 ${task.funnelId} 完成: 主${task.progress.main}/子${task.progress.sub}/赞${task.progress.like}/随机${task.progress.random}`);
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

export default FunnelStrategyService;
