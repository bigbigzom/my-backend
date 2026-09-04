/**
 * PersonaService - 账号画像管理（v7.1 新增）
 *
 * 职责：画像模板CRUD + 变体生成 + 批量分配
 * 无AI，基于模板+变量池随机组合生成变体。
 * 只调用storage，不重复造轮子。
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_TEMPLATES = [
  {
    templateId: 'toxic_gamer',
    name: '毒舌游戏玩家',
    basePersona: {
      style: '毒舌吐槽',
      interests: ['游戏', '动画', '数码'],
      speechHabit: '短句+反问',
      activeHours: [20, 21, 22, 23, 0, 1],
      dailyLimit: 15,
    },
    variants: {
      nicknamePool: ['玩家X', '老炮儿', '键盘侠', '游戏宅', '电竞少年'],
      exclamationPool: ['笑死', '就这?', '离谱', '绝了', '蚌埠住了'],
      catchphrasePool: ['有一说一', '讲真', '不是我说', '讲道理', '说实话'],
      emojiPool: ['😂', '🤔', '💀', '😅', '🤡'],
    },
  },
  {
    templateId: 'cute_girl',
    name: '萌系少女',
    basePersona: {
      style: '可爱软萌',
      interests: ['美食', '猫', '综艺', '手工'],
      speechHabit: '语气词+叠词',
      activeHours: [8, 9, 10, 12, 13, 19, 20, 21],
      dailyLimit: 10,
    },
    variants: {
      nicknamePool: ['小猫咪', '糖果酱', '布丁', '奶糖', '团子'],
      exclamationPool: ['哇~', '好可爱!', '嘤嘤', '嘿嘿', '喵喵'],
      catchphrasePool: ['人家觉得', '真的吗', '好棒呀', '超喜欢', '太可爱啦'],
      emojiPool: ['🥰', '😻', '🍬', '✨', '💕'],
    },
  },
  {
    templateId: 'rational_tech',
    name: '理性科技党',
    basePersona: {
      style: '理性分析',
      interests: ['科技', '财经', '数码', '科普'],
      speechHabit: '长句+数据',
      activeHours: [11, 12, 13, 18, 19, 20, 21],
      dailyLimit: 8,
    },
    variants: {
      nicknamePool: ['数据党', '理性人', '分析师', '科技宅', '观察者'],
      exclamationPool: ['值得注意', '事实上', '从数据看', '客观来说', '统计显示'],
      catchphrasePool: ['从这个角度', '需要注意的是', '数据表明', '客观分析', '结论是'],
      emojiPool: ['📊', '🤓', '💡', '📈', '🔬'],
    },
  },
  {
    templateId: 'casual_browser',
    name: '佛系路人',
    basePersona: {
      style: '随意简短',
      interests: ['生活', '搞笑', '音乐', '旅行'],
      speechHabit: '极短句',
      activeHours: [9, 10, 12, 14, 18, 19, 20, 21, 22],
      dailyLimit: 12,
    },
    variants: {
      nicknamePool: ['路人甲', '吃瓜群众', '潜水员', '打酱油', '路过'],
      exclamationPool: ['哈哈', '666', '前排', '打卡', '学到了'],
      catchphrasePool: ['看看就好', '还行吧', '可以可以', '不错不错', '路过看看'],
      emojiPool: ['👍', '😄', '🙏', '👀', '💪'],
    },
  },
];

export class PersonaService {
  constructor(storagePath) {
    this.storagePath = storagePath || path.join(process.cwd(), 'data', 'personas.json');
    this.templates = [];
    this.assigned = {}; // accountId -> personaVariant
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const data = JSON.parse(fs.readFileSync(this.storagePath, 'utf-8'));
        this.templates = data.templates || DEFAULT_TEMPLATES;
        this.assigned = data.assigned || {};
      } else {
        this.templates = DEFAULT_TEMPLATES;
        this.assigned = {};
        this._save();
      }
    } catch {
      this.templates = DEFAULT_TEMPLATES;
      this.assigned = {};
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify({
        templates: this.templates, assigned: this.assigned,
      }, null, 2));
    } catch (e) {
      console.error('[PersonaService] 保存失败:', e.message);
    }
  }

  /** 获取所有模板 */
  listTemplates() {
    return this.templates.map(t => ({
      templateId: t.templateId,
      name: t.name,
      style: t.basePersona.style,
      interests: t.basePersona.interests,
      dailyLimit: t.basePersona.dailyLimit,
      variantCount: this._countVariants(t),
    }));
  }

  /** 获取单个模板详情 */
  getTemplate(templateId) {
    return this.templates.find(t => t.templateId === templateId) || null;
  }

  /** 新增/更新模板 */
  saveTemplate(template) {
    const idx = this.templates.findIndex(t => t.templateId === template.templateId);
    if (idx >= 0) this.templates[idx] = { ...this.templates[idx], ...template };
    else this.templates.push(template);
    this._save();
    return this.getTemplate(template.templateId);
  }

  /** 删除模板 */
  deleteTemplate(templateId) {
    this.templates = this.templates.filter(t => t.templateId !== templateId);
    this._save();
    return true;
  }

  /**
   * 从模板生成N个唯一变体
   * @param {string} templateId - 模板ID
   * @param {number} count - 生成数量
   * @returns {Array} 变体数组
   */
  generateVariants(templateId, count = 1) {
    const template = this.getTemplate(templateId);
    if (!template) throw new Error(`模板不存在: ${templateId}`);
    const variants = [];
    const usedSeeds = new Set();
    for (let i = 0; i < count; i++) {
      let seed;
      do { seed = Math.floor(Math.random() * 100000); } while (usedSeeds.has(seed));
      usedSeeds.add(seed);
      const v = template.variants || {};
      const pick = (arr) => arr && arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : '';
      variants.push({
        variantId: `${templateId}_${seed}`,
        templateId,
        basePersona: { ...template.basePersona },
        nickname: pick(v.nicknamePool),
        exclamation: pick(v.exclamationPool),
        catchphrase: pick(v.catchphrasePool),
        emojiSet: v.emojiPool ? this._pickRandom(v.emojiPool, 3) : [],
        variantSeed: seed,
      });
    }
    return variants;
  }

  /**
   * 为账号分配画像变体
   * @param {string} accountId - 账号ID
   * @param {string} templateId - 模板ID（不传则随机）
   */
  assignPersona(accountId, templateId) {
    const tid = templateId || this.templates[Math.floor(Math.random() * this.templates.length)]?.templateId;
    if (!tid) throw new Error('无可用模板');
    const variant = this.generateVariants(tid, 1)[0];
    this.assigned[accountId] = variant;
    this._save();
    return variant;
  }

  /** 批量分配画像 */
  batchAssign(accountIds, templateId) {
    return accountIds.map(id => {
      try { return { accountId: id, persona: this.assignPersona(id, templateId), success: true }; }
      catch (e) { return { accountId: id, success: false, error: e.message }; }
    });
  }

  /** 获取账号画像 */
  getPersona(accountId) {
    return this.assigned[accountId] || null;
  }

  /** 获取所有已分配画像 */
  listAssigned() {
    return Object.entries(this.assigned).map(([accountId, persona]) => ({
      accountId, ...persona,
    }));
  }

  /** 移除账号画像 */
  removePersona(accountId) {
    delete this.assigned[accountId];
    this._save();
    return true;
  }

  // ===== 内部工具 =====
  _countVariants(template) {
    const v = template.variants || {};
    const pools = Object.values(v).filter(Array.isArray);
    if (pools.length === 0) return 0;
    return pools.reduce((acc, p) => acc * Math.max(p.length, 1), 1);
  }

  _pickRandom(arr, n) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }
}

export default PersonaService;
