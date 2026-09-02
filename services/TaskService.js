/**
 * 任务队列服务（v4.0 OOP重构）
 */
import taskQueue from '../src/utils/task-queue.js';

export class TaskService {
  list() { return taskQueue.list(); }
  remove(id) { return taskQueue.remove(id); }
  add(task) { return taskQueue.add(task); }
  getStats() { return taskQueue.getStats(); }
}
export default TaskService;
