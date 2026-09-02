/**
 * 监控服务（v4.0 OOP重构）
 *
 * 封装 monitor-engine，提供评论监控轮询、补发等功能。
 */
import {
  addMonitorTask, getMonitorTasks, removeMonitorTask, updateMonitorTask,
  toggleMonitorTask, checkCommentExists, startMonitor, stopMonitor,
  runMonitorNow, updateMonitorConfig, getMonitorConfig,
} from '../src/utils/monitor-engine.js';

export class MonitorService {
  constructor({ commentService }) {
    this.commentService = commentService;
  }

  list() { return getMonitorTasks(); }
  add(task) { return addMonitorTask(task); }
  update(id, patch) { return updateMonitorTask(id, patch); }
  remove(id) { return removeMonitorTask(id); }
  toggle(id, enabled) { return toggleMonitorTask(id, enabled); }
  async checkComment(params) { return checkCommentExists(params); }
  start() { return startMonitor(); }
  stop() { return stopMonitor(); }
  async runNow(id) { return runMonitorNow(id); }
  getConfig() { return getMonitorConfig(); }
  updateConfig(patch) { return updateMonitorConfig(patch); }
}

export default MonitorService;
