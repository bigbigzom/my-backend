/**
 * MemoryService - 账号互动记忆与去重（v7.1 新增）
 *
 * 职责：记录账号互动历史，避免重复评论/回复同一视频或用户
 * 独立存储，被 BehaviorEngine / CommentService / FunnelStrategy 调用。
 */
import fs from 'fs';
import path from 'path';

export class MemoryService {
  constructor(storagePath) {
    this.storagePath = storagePath || path.join(process.cwd(), 'data', 'memory.json');
    this.memories = {}; // accountId -> [{type, bvid, rpid, mid, timestamp}]
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        this.memories = JSON.parse(fs.readFileSync(this.storagePath, 'utf-8'));
      }
    } catch { this.memories = {}; }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.memories, null, 2));
    } catch (e) { console.error('[MemoryService] 保存失败:', e.message); }
  }

  /**
   * 记录互动
   * @param {string} accountId
   * @param {Object} interaction - {type, bvid, rpid, mid, content}
   */
  recordInteraction(accountId, interaction) {
    if (!this.memories[accountId]) this.memories[accountId] = [];
    this.memories[accountId].push({ ...interaction, timestamp: Date.now() });
    // 每个账号最多保留500条记忆
    if (this.memories[accountId].length > 500) {
      this.memories[accountId] = this.memories[accountId].slice(-500);
    }
    this._save();
  }

  /** 检查账号是否已互动过某视频 */
  hasInteractedVideo(accountId, bvid) {
    const mems = this.memories[accountId] || [];
    return mems.some(m => m.bvid === bvid);
  }

  /** 检查账号是否已评论过某视频 */
  hasCommented(accountId, bvid) {
    const mems = this.memories[accountId] || [];
    return mems.some(m => m.type === 'comment' && m.bvid === bvid);
  }

  /** 检查账号是否已回复过某评论 */
  hasReplied(accountId, rpid) {
    const mems = this.memories[accountId] || [];
    return mems.some(m => m.type === 'reply' && m.rpid === rpid);
  }

  /** 获取账号互动历史 */
  getHistory(accountId, limit = 50) {
    return (this.memories[accountId] || []).slice(-limit).reverse();
  }

  /** 获取所有账号记忆统计 */
  getStats() {
    return Object.entries(this.memories).map(([accountId, mems]) => ({
      accountId,
      totalInteractions: mems.length,
      commentCount: mems.filter(m => m.type === 'comment').length,
      replyCount: mems.filter(m => m.type === 'reply').length,
      lastInteraction: mems.length > 0 ? mems[mems.length - 1].timestamp : null,
    }));
  }

  /** 清理超过30天的记忆 */
  cleanup(days = 30) {
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    for (const accountId of Object.keys(this.memories)) {
      const before = this.memories[accountId].length;
      this.memories[accountId] = this.memories[accountId].filter(m => m.timestamp > cutoff);
      removed += before - this.memories[accountId].length;
    }
    this._save();
    return { removed };
  }

  /** 清除账号记忆 */
  clearAccount(accountId) {
    delete this.memories[accountId];
    this._save();
    return true;
  }
}

export default MemoryService;
