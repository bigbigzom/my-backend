/**
 * ReportService - 举报中心服务（v7.1 新增）
 *
 * 职责：举报任务队列管理 + 多账号轮询举报 + 结果统计
 * 调用 ReportAPI / AccountService / VideoAPI，不重复造轮子。
 */
import fs from 'fs';
import path from 'path';
import { REPORT_REASONS } from '../src/bili-api/ReportAPI.js';

export class ReportService {
  constructor({ accountService, reportApiFactory, videoService }) {
    this.accountService = accountService;
    this.reportApiFactory = reportApiFactory; // (account) => ReportAPI实例
    this.videoService = videoService;
    this.storagePath = path.join(process.cwd(), 'data', 'report-tasks.json');
    this.tasks = [];
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        this.tasks = JSON.parse(fs.readFileSync(this.storagePath, 'utf-8'));
      }
    } catch { this.tasks = []; }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.tasks, null, 2));
    } catch (e) { console.error('[ReportService] 保存失败:', e.message); }
  }

  /** 获取举报原因列表 */
  getReasons() {
    return Object.entries(REPORT_REASONS).map(([key, val]) => ({ key, code: val.code, label: val.label }));
  }

  /**
   * 创建举报任务
   * @param {Object} params
   * @param {string} params.type - video/user/comment/danmaku
   * @param {string} [params.keyword] - 搜索关键词（视频举报时批量获取目标）
   * @param {Array} params.targets - 目标列表 [{aid/mid/rpid/dmid, ...}]
   * @param {number} params.reason - 举报原因code
   * @param {string} [params.desc] - 详细描述
   * @param {string[]} [params.accountIds] - 指定举报账号（不传则自动轮询）
   * @param {number} [params.maxReports] - 最大举报次数
   */
  createTask(params) {
    const taskId = `report_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const task = {
      taskId,
      type: params.type,
      keyword: params.keyword || '',
      targets: params.targets || [],
      reason: params.reason,
      desc: params.desc || '',
      accountIds: params.accountIds || [],
      maxReports: params.maxReports || 10,
      status: 'pending',
      progress: { total: params.targets?.length || 0, done: 0, success: 0, failed: 0 },
      results: [],
      createdAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    this._save();
    return task;
  }

  /**
   * 通过关键词搜索视频并创建举报任务
   */
  async createTaskByKeyword({ keyword, reason, desc, maxReports = 10, accountIds }) {
    const videos = await this.videoService.search({ keyword, pageSize: maxReports });
    const targets = (videos.videos || []).map(v => ({ aid: v.aid, bvid: v.bvid, title: v.title }));
    return this.createTask({
      type: 'video', keyword, targets, reason, desc, accountIds, maxReports,
    });
  }

  /**
   * 执行举报任务
   */
  async execute(taskId) {
    const task = this.tasks.find(t => t.taskId === taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    task.status = 'running';

    // 获取可用举报账号
    let reportAccounts = task.accountIds.length > 0
      ? task.accountIds.map(id => this.accountService.get(id)).filter(Boolean)
      : this.accountService.list({ active: true }).filter(a => a.accountType !== 'publisher');

    if (reportAccounts.length === 0) {
      task.status = 'failed';
      task.error = '无可用举报账号';
      this._save();
      return task;
    }

    let accountIdx = 0;
    for (const target of task.targets) {
      if (task.progress.done >= task.maxReports) break;
      const account = reportAccounts[accountIdx % reportAccounts.length];
      accountIdx++;
      try {
        const reportApi = this.reportApiFactory(account);
        let result;
        switch (task.type) {
          case 'video':
            result = await reportApi.reportVideo({ aid: target.aid, reason: task.reason, desc: task.desc });
            break;
          case 'user':
            result = await reportApi.reportUser({ mid: target.mid, reason: task.reason, desc: task.desc });
            break;
          case 'comment':
            result = await reportApi.reportComment({ rpid: target.rpid, oid: target.oid, reason: task.reason, desc: task.desc });
            break;
          case 'danmaku':
            result = await reportApi.reportDanmaku({ dmid: target.dmid, cid: target.cid, reason: task.reason, desc: task.desc });
            break;
        }
        const success = result.data?.code === 0;
        task.results.push({ target, accountId: account.id || account.uid, success, response: result.data });
        if (success) task.progress.success++; else task.progress.failed++;
      } catch (e) {
        task.results.push({ target, accountId: account.id || account.uid, success: false, error: e.message });
        task.progress.failed++;
      }
      task.progress.done++;
      // 随机延迟5-30秒
      await this._sleep(5000 + Math.random() * 25000);
    }

    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    this._save();
    return task;
  }

  listTasks() { return this.tasks.slice(-50).reverse(); }
  getTask(taskId) { return this.tasks.find(t => t.taskId === taskId); }
  deleteTask(taskId) {
    this.tasks = this.tasks.filter(t => t.taskId !== taskId);
    this._save();
    return true;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

export default ReportService;
