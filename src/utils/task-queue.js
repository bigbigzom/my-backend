/**
 * 任务队列 v2.2（延迟任务 / 优先级 / 重试 / 持久化）
 *
 * 用途：支撑"分阶段热度增长曲线"——主号发布后，次级号的点赞/楼中楼
 * 在随机时间点执行（模拟真实热度爬升），而非立即全部执行。
 *
 * 特性：
 * - 支持延迟执行（delayedAt 时间戳）
 * - 优先级（数值越大越先执行）
 * - 失败自动重试（指数退避 + 随机抖动）
 * - 持久化到 tasks.json（Render 重启可恢复未完成任务）
 * - 任务类型：publish_like / publish_reply / nurture / monitor_check
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TASKS_FILE = path.join(__dirname, '../models/tasks.json');
// 任务执行器注册表（由外部模块注册任务处理函数）
const handlers = new Map();
class TaskQueue {
  constructor() {
    this.tasks = [];       // [{id, type, data, priority, delayedAt, retries, maxRetries, status, createdAt, result, error}]
    this.timer = null;
    this.processing = false;
    this.load();
  }
  // ============================================================
  // 持久化
  // ============================================================
  load() {
    try {
      if (fs.existsSync(TASKS_FILE)) {
        const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8') || '[]');
        this.tasks = data.filter(t => t.status === 'pending' || t.status === 'retrying');
        // 重启后恢复到待执行
        this.tasks.forEach(t => { if (t.status === 'retrying') t.status = 'pending'; });
        if (this.tasks.length) console.log(`[TaskQueue] 恢复 ${this.tasks.length} 个未完成任务`);
      }
    } catch (e) {
      console.warn('[TaskQueue] 任务加载失败:', e.message);
      this.tasks = [];
    }
  }
  save() {
    try {
      const dir = path.dirname(TASKS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(TASKS_FILE, JSON.stringify(this.tasks, null, 2));
    } catch (e) {
      console.warn('[TaskQueue] 任务保存失败:', e.message);
    }
  }
  // ============================================================
  // 注册任务处理器
  // ============================================================
  register(type, handler) {
    handlers.set(type, handler);
  }
  // ============================================================
  // 任务操作
  // ============================================================
  /**
   * 添加任务
   * @param {String} type 任务类型（须注册handler）
   * @param {Object} data 任务数据
   * @param {Object} opts { delayMs: 延迟毫秒, priority, maxRetries }
   * @returns {Object} 任务对象
   */
  add(type, data = {}, opts = {}) {
    const task = {
      id: 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8),
      type,
      data,
      priority: opts.priority || 0,
      delayedAt: Date.now() + (opts.delayMs || 0),
      retries: 0,
      maxRetries: opts.maxRetries !== undefined ? opts.maxRetries : 3,
      status: 'pending',
      createdAt: Date.now(),
      result: null,
      error: null,
    };
    this.tasks.push(task);
    this.save();
    this.scheduleNext();
    return task;
  }
  /**
   * 添加多个延迟任务（按时间分散）
   */
  addMany(type, dataList, opts = {}) {
    return dataList.map((data, i) => {
      const delayMs = (opts.delayMs || 0) + (opts.staggerMs || 0) * i + (opts.jitterMs || 0) * Math.random();
      return this.add(type, data, { ...opts, delayMs });
    });
  }
  get(id) {
    return this.tasks.find(t => t.id === id);
  }
  cancel(id) {
    this.tasks = this.tasks.filter(t => t.id !== id);
    this.save();
  }
  list({ status, type, limit = 50 } = {}) {
    let list = [...this.tasks];
    if (status) list = list.filter(t => t.status === status);
    if (type) list = list.filter(t => t.type === type);
    list.sort((a, b) => (b.priority - a.priority) || (a.delayedAt - b.delayedAt));
    return list.slice(0, limit);
  }
  getStats() {
    const byStatus = {};
    for (const t of this.tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    return {
      total: this.tasks.length,
      pending: this.tasks.filter(t => t.status === 'pending' && t.delayedAt <= Date.now()).length,
      scheduled: this.tasks.filter(t => t.status === 'pending' && t.delayedAt > Date.now()).length,
      processing: this.tasks.filter(t => t.status === 'processing').length,
      done: this.tasks.filter(t => t.status === 'done').length,
      failed: this.tasks.filter(t => t.status === 'failed').length,
      byStatus,
    };
  }
  // ============================================================
  // 调度循环
  // ============================================================
  scheduleNext() {
    if (this.timer) clearTimeout(this.timer);
    const now = Date.now();
    const due = this.tasks
      .filter(t => t.status === 'pending' && t.delayedAt <= now)
      .sort((a, b) => (b.priority - a.priority) || (a.delayedAt - b.delayedAt));
    if (due.length > 0) {
      this.timer = setTimeout(() => this.process(), 50);
    } else {
      const next = this.tasks.filter(t => t.status === 'pending').sort((a, b) => a.delayedAt - b.delayedAt)[0];
      if (next) {
        const wait = Math.max(50, next.delayedAt - now);
        this.timer = setTimeout(() => this.process(), wait);
      }
    }
  }
  async process() {
    if (this.processing) return;
    this.processing = true;
    const now = Date.now();
    const due = this.tasks
      .filter(t => t.status === 'pending' && t.delayedAt <= now)
      .sort((a, b) => (b.priority - a.priority) || (a.delayedAt - b.delayedAt));
    for (const task of due) {
      if (task.status !== 'pending') continue;
      const handler = handlers.get(task.type);
      if (!handler) {
        task.status = 'failed';
        task.error = `未注册的任务类型: ${task.type}`;
        this.save();
        continue;
      }
      task.status = 'processing';
      this.save();
      try {
        const result = await handler(task.data, task);
        task.status = 'done';
        task.result = result;
        task.error = null;
        console.log(`[TaskQueue] ✅ 任务完成 ${task.type} #${task.id}`);
      } catch (err) {
        task.retries++;
        const isBiliRisk = String(err.code) === '-352' || String(err.message || '').includes('-352');
        if (task.retries <= task.maxRetries) {
          task.status = 'pending';
          // 指数退避 + 随机抖动（安全校验错误更长退避）
          const base = isBiliRisk ? 5 * 60 * 1000 : 5 * 1000;
          task.delayedAt = Date.now() + base * Math.pow(2, task.retries - 1) + Math.random() * 30000;
          task.error = `第${task.retries}次失败: ${err.message}，${Math.round((task.delayedAt - Date.now()) / 1000)}s后重试`;
          console.warn(`[TaskQueue] ⚠️ 任务重试 ${task.type} #${task.id} (${task.retries}/${task.maxRetries})`);
        } else {
          task.status = 'failed';
          task.error = `重试${task.maxRetries}次后失败: ${err.message}`;
          console.error(`[TaskQueue] ❌ 任务失败 ${task.type} #${task.id}: ${err.message}`);
        }
      }
      this.save();
    }
    this.processing = false;
    this.scheduleNext();
  }
  start() {
    this.scheduleNext();
    console.log('[TaskQueue] 任务队列已启动');
  }
}
const taskQueue = new TaskQueue();
export default taskQueue;
export { TaskQueue };
