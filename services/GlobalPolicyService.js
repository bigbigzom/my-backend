/**
 * GlobalPolicyService - 全局群控策略（v7.1 新增）
 *
 * 职责：全局参数管理（总评论上限/频率/活跃时段/矩阵配置）
 * 被 AdaptiveScheduler / RiskController / FunnelStrategy 调用。
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_POLICY = {
  // 全局限额
  globalDailyCommentLimit: 500,
  globalHourlyCommentLimit: 60,
  // 单账号限额
  accountDailyCommentLimit: 20,
  accountMinInterval: 180, // 秒，同账号两次评论最小间隔
  // 活跃时段
  activeHours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
  silentHours: [0, 1, 2, 3, 4, 5, 6, 7],
  // 矩阵引流默认配置
  funnel: {
    mainCount: 1,
    subCount: 10,
    randomCount: 10,
    likeCount: 5,
    mainToSubDelay: { min: 2, max: 10 },
    subToLikeDelay: { min: 1, max: 5 },
    monitorPeriod: 24,
    autoRepublish: true,
  },
  // 风控
  risk: {
    globalMuteThreshold: 5, // 连续N个账号被风控则全局熔断
    cooldownHours: 4,
  },
  // IP策略
  ip: {
    stickyEnabled: true,
    maxFailCount: 5,
  },
};

export class GlobalPolicyService {
  constructor(storagePath) {
    this.storagePath = storagePath || path.join(process.cwd(), 'data', 'global-policy.json');
    this.policy = { ...DEFAULT_POLICY };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const saved = JSON.parse(fs.readFileSync(this.storagePath, 'utf-8'));
        this.policy = { ...DEFAULT_POLICY, ...saved };
      }
    } catch { this.policy = { ...DEFAULT_POLICY }; }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.policy, null, 2));
    } catch (e) { console.error('[GlobalPolicy] 保存失败:', e.message); }
  }

  get() { return { ...this.policy }; }

  update(patch) {
    this.policy = { ...this.policy, ...patch };
    if (patch.funnel) this.policy.funnel = { ...this.policy.funnel, ...patch.funnel };
    if (patch.risk) this.policy.risk = { ...this.policy.risk, ...patch.risk };
    if (patch.ip) this.policy.ip = { ...this.policy.ip, ...patch.ip };
    this._save();
    return this.get();
  }

  reset() {
    this.policy = { ...DEFAULT_POLICY };
    this._save();
    return this.get();
  }

  /** 检查当前是否在活跃时段 */
  isActiveHour(hour = new Date().getHours()) {
    return this.policy.activeHours.includes(hour);
  }

  /** 检查全局日限额是否用尽 */
  checkGlobalDailyLimit(currentCount) {
    return currentCount < this.policy.globalDailyCommentLimit;
  }

  /** 检查全局小时限额 */
  checkGlobalHourlyLimit(currentCount) {
    return currentCount < this.policy.globalHourlyCommentLimit;
  }
}

export default GlobalPolicyService;
