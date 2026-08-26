/**
 * 账号管理类（集成中国IP代理控制）
 *
 * 每个账号字段：
 * - id: 唯一标识
 * - username: 账号名/UID
 * - password: 密码（可选，Cookie模式不需要）
 * - remark: 备注
 * - cookie: B站完整Cookie
 * - csrf: 从Cookie提取的bili_jct
 * - cookieExpire: Cookie过期时间戳
 * - status: normal/expired/abnormal/banned/wait_login
 * - useProxy: 是否启用中国IP代理（核心新增字段）
 * - todayPublished: 今日发布数
 * - lastPublishTime: 上次发布时间戳
 * - cooldownUntil: 冷却截止时间戳
 *
 * 持久化：models/accounts.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ACCOUNT_FILE = path.join(__dirname, '../models/accounts.json');

class AccountManager {
  constructor() {
    this.accounts = [];
  }

  // ============================================================
  // 持久化
  // ============================================================
  load() {
    try {
      if (fs.existsSync(ACCOUNT_FILE)) {
        const data = fs.readFileSync(ACCOUNT_FILE, 'utf8');
        this.accounts = JSON.parse(data || '[]');
      }
    } catch (err) {
      console.warn('[AccountManager] 加载账号文件失败:', err.message);
      this.accounts = [];
    }
    return this.accounts;
  }

  save() {
    try {
      const dir = path.dirname(ACCOUNT_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(this.accounts, null, 2));
    } catch (err) {
      console.warn('[AccountManager] 保存账号文件失败:', err.message);
    }
  }

  // ============================================================
  // 查询
  // ============================================================
  getAll() {
    return this.accounts;
  }

  getById(id) {
    return this.accounts.find(a => String(a.id) === String(id));
  }

  getNormal() {
    return this.accounts.filter(a => a.status === 'normal');
  }

  // 获取可用账号（正常 + 不在冷却中）
  getAvailable() {
    const now = Date.now();
    return this.accounts.filter(a =>
      a.status === 'normal' &&
      (!a.cooldownUntil || a.cooldownUntil < now)
    );
  }

  // 随机挑选一个可用账号作为主账号
  pickRandomMain() {
    const available = this.getAvailable();
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
  }

  // 获取启用代理的账号
  getProxyEnabled() {
    return this.accounts.filter(a => a.useProxy !== false && a.status === 'normal');
  }

  // ============================================================
  // 导入/创建
  // ============================================================
  importBatch(list) {
    let count = 0;
    for (const item of list) {
      // 去重
      const exist = this.accounts.find(a => a.username === item.username);
      if (exist) continue;

      const csrf = this.extractCsrf(item.cookie || '');
      this.accounts.push({
        id: Date.now() + Math.random(),
        username: item.username || '',
        password: item.password || '',
        remark: item.remark || '',
        cookie: item.cookie || '',
        csrf,
        cookieExpire: item.cookie ? Date.now() + 7 * 24 * 3600 * 1000 : 0,
        status: item.cookie ? 'normal' : 'wait_login',
        useProxy: item.useProxy !== false,  // 默认启用代理
        todayPublished: 0,
        lastPublishTime: 0,
        cooldownUntil: 0,
      });
      count++;
    }
    this.save();
    return count;
  }

  // ============================================================
  // 更新
  // ============================================================
  update(id, updates) {
    const account = this.getById(id);
    if (!account) return null;

    // 允许更新的字段
    const allowedFields = ['remark', 'cookie', 'password', 'status', 'useProxy', 'cooldownUntil', 'todayPublished'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        account[field] = updates[field];
      }
    }

    // 如果更新了cookie，重新提取csrf
    if (updates.cookie) {
      account.csrf = this.extractCsrf(updates.cookie);
      account.cookieExpire = Date.now() + 7 * 24 * 3600 * 1000;
    }

    this.save();
    return account;
  }

  // 批量设置代理开关
  batchSetProxy(ids, useProxy) {
    let count = 0;
    for (const id of ids) {
      const account = this.getById(id);
      if (account) {
        account.useProxy = useProxy !== false;
        count++;
      }
    }
    this.save();
    return count;
  }

  // 设置账号冷却
  setCooldown(id, minutes) {
    const account = this.getById(id);
    if (!account) return;
    account.cooldownUntil = Date.now() + minutes * 60 * 1000;
    this.save();
  }

  // 记录发布
  recordPublish(id) {
    const account = this.getById(id);
    if (!account) return;
    account.todayPublished = (account.todayPublished || 0) + 1;
    account.lastPublishTime = Date.now();
    this.save();
  }

  // ============================================================
  // 删除
  // ============================================================
  remove(id) {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter(a => String(a.id) !== String(id));
    if (this.accounts.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  // 清理异常账号
  clearAbnormal() {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter(a => a.status !== 'abnormal' && a.status !== 'banned');
    const removed = before - this.accounts.length;
    if (removed > 0) this.save();
    return removed;
  }

  // ============================================================
  // 工具
  // ============================================================
  extractCsrf(cookie) {
    const match = cookie.match(/bili_jct=([^;]+)/);
    return match ? match[1] : '';
  }

  // 统计
  getStats() {
    return {
      total: this.accounts.length,
      normal: this.accounts.filter(a => a.status === 'normal').length,
      expired: this.accounts.filter(a => a.status === 'expired').length,
      abnormal: this.accounts.filter(a => a.status === 'abnormal' || a.status === 'banned').length,
      proxyEnabled: this.accounts.filter(a => a.useProxy !== false).length,
      proxyDisabled: this.accounts.filter(a => a.useProxy === false).length,
      cooling: this.accounts.filter(a => a.cooldownUntil && a.cooldownUntil > Date.now()).length,
    };
  }
}

// 单例导出
const accountManager = new AccountManager();
export default accountManager;
