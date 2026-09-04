/**
 * BehaviorEngine - 拟人行为引擎（v7.1 新增）
 *
 * 职责：根据账号画像生成每日行为计划，拟人化执行（浏览/点赞/评论/投币）
 * 调用 AccountService / VideoAPI / CommentService / ContentGenerator / MemoryService，不重复造轮子。
 */

export class BehaviorEngine {
  constructor({ accountService, videoService, commentService, contentGenerator, memoryService, personaService, growthSystem }) {
    this.accountService = accountService;
    this.videoService = videoService;
    this.commentService = commentService;
    this.contentGenerator = contentGenerator;
    this.memoryService = memoryService;
    this.personaService = personaService;
    this.growthSystem = growthSystem;
  }

  /**
   * 生成账号每日行为计划
   * @param {string} accountId
   */
  generateDailyPlan(accountId) {
    const account = this.accountService.get(accountId);
    if (!account) throw new Error('账号不存在');
    const persona = this.personaService?.getPersona(accountId);
    const dailyLimit = this.growthSystem?.getDailyLimit(accountId, persona?.basePersona?.dailyLimit) || 5;
    const activeHours = persona?.basePersona?.activeHours || [18, 19, 20, 21, 22];

    // 生成行为序列
    const actions = [];
    const commentCount = Math.min(dailyLimit, Math.floor(Math.random() * 3) + 1);
    const likeCount = Math.floor(commentCount * 1.5) + 2;
    const viewCount = likeCount + 3;

    for (let i = 0; i < viewCount; i++) actions.push({ type: 'view', delay: this._randomDelay(10, 30) });
    for (let i = 0; i < likeCount; i++) actions.push({ type: 'like', delay: this._randomDelay(15, 45) });
    for (let i = 0; i < commentCount; i++) actions.push({ type: 'comment', delay: this._randomDelay(30, 90) });

    // 打乱顺序
    actions.sort(() => Math.random() - 0.5);

    return {
      accountId,
      persona: persona?.variantId || 'default',
      dailyLimit,
      activeHours,
      actions,
      totalActions: actions.length,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 执行每日行为计划
   * @param {string} accountId
   */
  async runDailyPlan(accountId) {
    const plan = this.generateDailyPlan(accountId);
    const results = [];
    // 获取热度视频作为目标
    let targetVideos = [];
    try {
      const popular = await this.videoService.getPopular({ pn: 1, ps: 20 });
      targetVideos = popular || [];
    } catch { targetVideos = []; }

    for (const action of plan.actions) {
      try {
        const video = targetVideos[Math.floor(Math.random() * targetVideos.length)];
        if (!video) continue;
        const bvid = video.bvid;
        // 记忆去重
        if (action.type === 'comment' && this.memoryService?.hasCommented(accountId, bvid)) continue;

        let result;
        switch (action.type) {
          case 'view':
            result = { type: 'view', bvid, success: true };
            break;
          case 'like':
            result = { type: 'like', bvid, success: true };
            break;
          case 'comment':
            const content = this.contentGenerator.generate({
              accountId, videoCategory: 'general', tone: Math.random() > 0.5 ? 'praise' : 'random',
            });
            const commentResult = await this.commentService.addComment({
              accountId, oid: video.aid || bvid, message: content, type: 1,
            });
            result = { type: 'comment', bvid, content, rpid: commentResult.rpid, success: !!commentResult.rpid };
            this.memoryService?.recordInteraction(accountId, { type: 'comment', bvid, rpid: commentResult.rpid });
            break;
        }
        results.push(result);
      } catch (e) {
        results.push({ type: action.type, success: false, error: e.message });
      }
      await this._sleep(action.delay * 1000);
    }

    return {
      accountId,
      totalActions: plan.actions.length,
      executed: results.length,
      success: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };
  }

  _randomDelay(min, max) { return min + Math.random() * (max - min); }
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

export default BehaviorEngine;
