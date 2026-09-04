/**
 * VideoPublishService - 自动视频发布服务（v7.1 新增）
 *
 * 职责：视频素材库管理 + 发布任务调度 + 审核状态轮询
 * 发布者账号(accountType=publisher)不参与评论区。
 * 调用 PublishAPI / AccountService.resolveProxy / FunnelStrategyService，不重复造轮子。
 */
import fs from 'fs';
import path from 'path';

export class VideoPublishService {
  constructor({ accountService, publishApiFactory, funnelStrategyService }) {
    this.accountService = accountService;
    this.publishApiFactory = publishApiFactory; // (account) => PublishAPI实例
    this.funnelStrategyService = funnelStrategyService;
    this.storagePath = path.join(process.cwd(), 'data', 'video-publish-tasks.json');
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
    } catch (e) { console.error('[VideoPublish] 保存失败:', e.message); }
  }

  /** 获取发布者账号列表 */
  listPublishers() {
    const all = this.accountService.list({ active: true });
    const publishers = all.filter(a => a.accountType === 'publisher' || a.accountType === 'video_publisher');
    const commenters = all.filter(a => !(a.accountType === 'publisher' || a.accountType === 'video_publisher'));
    return { accounts: all, publishers, commenters, total: all.length };
  }

  /** 标记/取消标记发布者账号 */
  setPublisher(accountId, isPublisher) {
    return this.accountService.setPublisher(accountId, isPublisher);
  }

  /**
   * 创建发布任务
   * @param {Object} params
   * @param {string[]} params.accountIds - 发布者账号ID列表
   * @param {string} params.title - 视频标题
   * @param {number} params.tid - 分区ID
   * @param {string} params.tag - 标签（逗号分隔）
   * @param {string} params.desc - 简介
   * @param {string} params.videoFile - 视频文件路径或URL
   * @param {string} [params.cover] - 封面
   * @param {Date} [params.scheduledAt] - 定时发布时间
   * @param {boolean} [params.autoFunnel] - 发布成功后自动触发矩阵引流
   */
  createTask(params) {
    const taskId = `pub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const task = {
      taskId, ...params,
      status: 'pending',
      progress: {},
      results: [],
      createdAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    this._save();
    return task;
  }

  /**
   * 执行发布任务
   */
  async execute(taskId) {
    const task = this.tasks.find(t => t.taskId === taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    task.status = 'running';

    for (const accountId of task.accountIds) {
      try {
        const account = this.accountService.get(accountId);
        if (!account) { task.results.push({ accountId, success: false, error: '账号不存在' }); continue; }

        // 解析IP
        const proxyResult = await this.accountService.resolveProxy(accountId);
        if (proxyResult.skipped) {
          task.results.push({ accountId, success: false, error: proxyResult.reason });
          continue;
        }

        // 创建PublishAPI
        const publishApi = this.publishApiFactory(account);

        // 提交投稿（简化版：实际需要先上传文件到OSS）
        const result = await publishApi.submitArchive({
          title: task.title,
          tid: task.tid,
          tag: task.tag,
          desc: task.desc,
          filename: task.videoFile,
          cover: task.cover,
        });

        const aid = result.data?.data?.aid;
        const bvid = result.data?.data?.bvid;
        task.results.push({ accountId, success: !!aid, aid, bvid, raw: result.data });

        // 发布成功后触发矩阵引流
        if (bvid && task.autoFunnel && this.funnelStrategyService) {
          await this.funnelStrategyService.createTask({ bvid, oid: aid });
        }
      } catch (e) {
        task.results.push({ accountId, success: false, error: e.message });
      }
    }

    task.status = task.results.every(r => r.success) ? 'completed' : 'partial';
    this._save();
    return task;
  }

  /** 轮询审核状态 */
  async checkStatus(taskId) {
    const task = this.tasks.find(t => t.taskId === taskId);
    if (!task) throw new Error(`任务不存在`);
    for (const r of task.results) {
      if (r.aid) {
        try {
          const account = this.accountService.list().find(a => (a.id || a.uid) === r.accountId);
          if (account) {
            const publishApi = this.publishApiFactory(account);
            const status = await publishApi.getArchiveStatus(r.aid);
            r.reviewStatus = status.data?.data?.state || 'unknown';
          }
        } catch (e) { r.reviewStatus = 'error'; }
      }
    }
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
}

export default VideoPublishService;
