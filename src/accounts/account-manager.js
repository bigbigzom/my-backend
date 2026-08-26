/**
 * 账号管理类 v2.2（健康度画像 + 去关联 + 人设 + 指纹绑定）
 *
 * 每个账号字段：
 * - id: 唯一标识
 * - username: 账号名/UID
 * - password: 密码（可选，Cookie模式不需要）
 * - remark: 备注
 * - cookie / csrf / cookieExpire
 * - status: normal/expired/abnormal/banned/wait_login
 * - useProxy: 是否启用中国IP代理
 * - todayPublished / lastPublishTime / cooldownUntil
 * - primaryProxy: 账号主用IP（去关联：固定常用IP，模拟真实用户所在地）
 * - persona: 人设（评论语气模板 key）
 * - behaviorProfile: 行为节奏（cautious/balanced/quick）
 * - fingerprintId / loginFingerprintId: 指纹画像
 * - health: 健康度画像 { score, riskEvents, deletedCount, republishCount, lastRiskTime }
 * - riskScore: 关联风险评分(0-100)
 * - riskSignals: 关联信号记录 [{type, ts, detail}]
 * - registeredAt: 注册时间（新号冷静期）
 * - muteUntil: 静默截止（临时降权）
 *
 * 持久化：models/accounts.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ACCOUNT_FILE = path.join(__dirname, '../models/accounts.json');
// 人设模板库（评论语气，用于次级号楼中楼差异化）
const PERSONAS = {
  questioner: { name: '提问型', traits: ['真实好奇', '求链接'], examples: ['这个是怎么弄的呀', '求个教程，谢谢！', '怎么私信你？'] },
  praiser: { name: '赞叹型', traits: ['被种草', '认同'], examples: ['太实用了，学到了', '感谢分享，已收藏', '说得太对了'] },
  experiencer: { name: '晒单型', traits: ['已购买', '分享体验'], examples: ['上周就下单了，真心不错', '亲测有效，帮顶', '用了一段时间，值得入'] },
  analyzer: { name: '理性型', traits: ['客观分析', '补充信息'], examples: ['补充一点：这个确实比同类好', '看了半天，总结得很到位', '这条信息含量很高'] },
  neutral: { name: '路人型', traits: ['普通路人', '随缘互动'], examples: ['路过帮顶', '前排围观', '关注了，期待更新'] },
};
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
        this.migrate();
      }
    } catch (err) {
      console.warn('[AccountManager] 加载账号文件失败:', err.message);
      this.accounts = [];
    }
    return this.accounts;
  }
  // 迁移旧账号字段（v2.2 新字段补默认值）
  migrate() {
    for (const a of this.accounts) {
      if (a.health === undefined) a.health = { score: 100, riskEvents: 0, deletedCount: 0, republishCount: 0, lastRiskTime: 0 };
      if (a.riskScore === undefined) a.riskScore = 0;
      if (a.riskSignals === undefined) a.riskSignals = [];
      if (a.primaryProxy === undefined) a.primaryProxy = null;
      if (a.persona === undefined) a.persona = this.randomPersona();
      if (a.behaviorProfile === undefined) a.behaviorProfile = ['cautious', 'balanced', 'balanced', 'quick'][Math.floor(Math.random() * 4)];
      if (a.registeredAt === undefined) a.registeredAt = a.loginAt || new Date().toISOString();
      if (a.muteUntil === undefined) a.muteUntil = 0;
      if (a.associationCount === undefined) a.associationCount = 0;
    }
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
  getAvailable() {
    const now = Date.now();
    return this.accounts.filter(a =>
      a.status === 'normal' &&
      (!a.cooldownUntil || a.cooldownUntil < now) &&
      (!a.muteUntil || a.muteUntil < now)
    );
  }
  // 获取启用代理的账号
  getProxyEnabled() {
    return this.accounts.filter(a => a.useProxy !== false && a.status === 'normal');
  }
  // ============================================================
  // v2.2：智能选主账号（健康度加权随机）
  // ============================================================
  /**
   * 随机挑选一个可用账号作为主账号
   * 改进：按健康度加权（健康度高更可能被选中），排除新号冷静期/高风险账号
   * @param {Object} opts { excludeId, requirePersona }
   */
  pickRandomMain(opts = {}) {
    const now = Date.now();
    const candidates = this.getAvailable().filter(a => {
      if (opts.excludeId && String(a.id) === String(opts.excludeId)) return false;
      // 新号冷静期：注册不足X小时不参与主号（主号曝光高）
      if (opts.newAccountGraceMs && this.isNewAccount(a, opts.newAccountGraceMs)) return false;
      return true;
    });
    if (candidates.length === 0) return null;
    // 健康度加权：score越高权重越大
    const weights = candidates.map(a => {
      const health = a.health?.score || 100;
      const riskPenalty = Math.max(0, (a.riskScore || 0) / 200);  // 关联风险分降权
      return Math.max(0.1, (health / 100) - riskPenalty);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }
  /**
   * 挑选N个次级账号（楼中楼/点赞用，健康度加权，排除主号）
   */
  pickSubAccounts(mainId, count, opts = {}) {
    const now = Date.now();
    const candidates = this.getAvailable().filter(a =>
      String(a.id) !== String(mainId) &&
      (!opts.newAccountGraceMs || !this.isNewAccount(a, opts.newAccountGraceMs))
    );
    // 按健康度降序
    candidates.sort((a, b) => (b.health?.score || 0) - (a.health?.score || 0));
    // 加权抽样：从前60%健康账号中随机抽count个（保留一定随机性）
    const pool = candidates.slice(0, Math.max(count, Math.ceil(candidates.length * 0.6)));
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }
  /**
   * 新号冷静期判断（新注册账号不参与策略，降低"新号+引流"高危组合）
   */
  isNewAccount(account, graceMs = 24 * 3600 * 1000) {
    if (!account.registeredAt) return false;
    const age = Date.now() - new Date(account.registeredAt).getTime();
    return age < graceMs;
  }
  // ============================================================
  // v2.2：健康度与风控
  // ============================================================
  /**
   * 记录风控事件（影响健康度）
   * @param {String} id 账号id
   * @param {Object} evt { type, code, message, op }
   */
  recordRiskEvent(id, evt) {
    const account = this.getById(id);
    if (!account) return null;
    if (!account.health) account.health = { score: 100, riskEvents: 0, deletedCount: 0, republishCount: 0, lastRiskTime: 0 };
    const h = account.health;
    h.riskEvents = (h.riskEvents || 0) + 1;
    h.lastRiskTime = Date.now();
    // 按事件类型扣分
    const penalties = {
      '-352': 20,     // 风控/验证码
      '-403': 30,     // 禁止访问（IP/账号）
      '-102': 40,     // 封禁
      '-103': 40,     // 封禁
      '-101': 15,     // 未登录
      'comment_deleted': 10,  // 评论被删
      'comment_folded': 5,    // 评论被折叠
      'network': 3,
    };
    const penalty = penalties[String(evt.code)] || 5;
    h.score = Math.max(0, Math.min(100, (h.score || 100) - penalty));
    // 风控事件记录（供前端预警流）
    if (!account.riskLog) account.riskLog = [];
    account.riskLog.unshift({
      ts: Date.now(),
      type: evt.type || 'unknown',
      code: evt.code || '',
      message: evt.message || '',
      op: evt.op || '',
    });
    if (account.riskLog.length > 50) account.riskLog.length = 50;
    this.save();
    return account.health;
  }
  /**
   * 记录评论被删/被折叠（监控发现）
   */
  recordCommentDeleted(id, level = 'deleted') {
    const account = this.getById(id);
    if (!account) return;
    if (!account.health) account.health = { score: 100, riskEvents: 0, deletedCount: 0, republishCount: 0, lastRiskTime: 0 };
    account.health.deletedCount = (account.health.deletedCount || 0) + 1;
    this.recordRiskEvent(id, { code: level === 'deleted' ? 'comment_deleted' : 'comment_folded', message: `评论被${level === 'deleted' ? '删除' : '折叠'}`, op: 'monitor' });
  }
  /**
   * 记录补发
   */
  recordRepublish(id) {
    const account = this.getById(id);
    if (!account) return;
    if (!account.health) account.health = { score: 100, riskEvents: 0, deletedCount: 0, republishCount: 0, lastRiskTime: 0 };
    account.health.republishCount = (account.health.republishCount || 0) + 1;
    this.save();
  }
  /**
   * 计算账号关联风险评分（0-100）
   * 输入信号：同IP次数、同时段操作重叠、文案模板相似、集中度
   */
  computeRiskScore(id) {
    const account = this.getById(id);
    if (!account) return 0;
    let score = 0;
    const signals = account.riskSignals || [];
    // 1. 同IP关联信号
    const sameIpCount = signals.filter(s => s.type === 'same_ip').length;
    score += Math.min(30, sameIpCount * 10);
    // 2. 同时段操作
    const sameTimeCount = signals.filter(s => s.type === 'same_time').length;
    score += Math.min(25, sameTimeCount * 8);
    // 3. 文案模板重复
    const templateCount = signals.filter(s => s.type === 'template_dup').length;
    score += Math.min(20, templateCount * 6);
    // 4. 集中度（只在该UP主评论）
    const concentration = signals.filter(s => s.type === 'concentration').length;
    score += Math.min(25, concentration * 12);
    account.riskScore = Math.min(100, score);
    return account.riskScore;
  }
  /**
   * 记录关联信号
   */
  recordRiskSignal(id, type, detail = '') {
    const account = this.getById(id);
    if (!account) return;
    if (!account.riskSignals) account.riskSignals = [];
    account.riskSignals.push({ type, ts: Date.now(), detail });
    if (account.riskSignals.length > 30) account.riskSignals.length = 30;
    this.computeRiskScore(id);
    this.save();
  }
  /**
   * 设置账号静默（临时降权，前端管理员操作/自动）
   */
  setMute(id, minutes) {
    const account = this.getById(id);
    if (!account) return false;
    account.muteUntil = Date.now() + minutes * 60 * 1000;
    this.save();
    return true;
  }
  /**
   * 冷静期：按风控等级设置冷却
   * level: 1=短(30min) 2=中(6h) 3=长(24h)
   */
  setCooldownByLevel(id, level = 1) {
    const minutes = { 1: 30, 2: 360, 3: 1440 }[level] || 30;
    this.setCooldown(id, minutes);
    return minutes;
  }
  // ============================================================
  // 导入/创建
  // ============================================================
  importBatch(list) {
    let count = 0;
    for (const item of list) {
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
        useProxy: item.useProxy !== false,
        todayPublished: 0,
        lastPublishTime: 0,
        cooldownUntil: 0,
        // v2.2 新字段
        primaryProxy: item.primaryProxy || null,
        persona: item.persona || this.randomPersona(),
        behaviorProfile: item.behaviorProfile || null,
        registeredAt: item.registeredAt || new Date().toISOString(),
        health: { score: 100, riskEvents: 0, deletedCount: 0, republishCount: 0, lastRiskTime: 0 },
        riskScore: 0,
        riskSignals: [],
        muteUntil: 0,
      });
      count++;
    }
    this.save();
    return count;
  }
  // 随机分配人设（保证次级号语气差异化）
  randomPersona() {
    const keys = Object.keys(PERSONAS);
    return keys[Math.floor(Math.random() * keys.length)];
  }
  // ============================================================
  // 更新
  // ============================================================
  update(id, updates) {
    const account = this.getById(id);
    if (!account) return null;
    const allowedFields = ['remark', 'cookie', 'password', 'status', 'useProxy', 'cooldownUntil', 'todayPublished', 'primaryProxy', 'persona', 'behaviorProfile', 'registeredAt', 'muteUntil'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        account[field] = updates[field];
      }
    }
    if (updates.cookie) {
      account.csrf = this.extractCsrf(updates.cookie);
      account.cookieExpire = Date.now() + 7 * 24 * 3600 * 1000;
    }
    this.save();
    return account;
  }
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
  setCooldown(id, minutes) {
    const account = this.getById(id);
    if (!account) return;
    account.cooldownUntil = Date.now() + minutes * 60 * 1000;
    this.save();
  }
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
  // 获取全部风控事件（前端预警流）
  getAllRiskEvents() {
    const events = [];
    for (const a of this.accounts) {
      if (a.riskLog && a.riskLog.length) {
        for (const evt of a.riskLog) {
          events.push({ accountId: a.id, username: a.username, ...evt });
        }
      }
    }
    events.sort((a, b) => b.ts - a.ts);
    return events.slice(0, 100);
  }
  // 健康度热力图数据
  getHealthHeatmap() {
    return this.accounts.map(a => ({
      id: a.id,
      username: a.username,
      status: a.status,
      health: a.health?.score || 100,
      riskScore: a.riskScore || 0,
      deletedCount: a.health?.deletedCount || 0,
      republishCount: a.health?.republishCount || 0,
      riskEvents: a.health?.riskEvents || 0,
      persona: a.persona,
      primaryProxy: a.primaryProxy,
      muteUntil: a.muteUntil,
      isNew: this.isNewAccount(a),
      cooldownUntil: a.cooldownUntil,
    }));
  }
  getStats() {
    return {
      total: this.accounts.length,
      normal: this.accounts.filter(a => a.status === 'normal').length,
      expired: this.accounts.filter(a => a.status === 'expired').length,
      abnormal: this.accounts.filter(a => a.status === 'abnormal' || a.status === 'banned').length,
      proxyEnabled: this.accounts.filter(a => a.useProxy !== false).length,
      proxyDisabled: this.accounts.filter(a => a.useProxy === false).length,
      cooling: this.accounts.filter(a => a.cooldownUntil && a.cooldownUntil > Date.now()).length,
      muted: this.accounts.filter(a => a.muteUntil && a.muteUntil > Date.now()).length,
      newAccounts: this.accounts.filter(a => this.isNewAccount(a)).length,
      avgHealth: this.accounts.length ? Math.round(this.accounts.reduce((s, a) => s + (a.health?.score || 100), 0) / this.accounts.length) : 0,
      highRisk: this.accounts.filter(a => (a.riskScore || 0) >= 50).length,
    };
  }
  // 人设库导出（前端展示/管理）
  static getPersonas() {
    return PERSONAS;
  }
}
// 单例导出
const accountManager = new AccountManager();
export default accountManager;
export { PERSONAS };
