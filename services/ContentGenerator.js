/**
 * ContentGenerator - 文案生成器（v7.1 新增）
 *
 * 职责：基于画像模板+变量池随机组合生成评论文案
 * 无AI，纯模板+变量替换。
 * 调用 PersonaService 获取画像，不重复造轮子。
 */

// 通用变量库
const VARIABLE_LIBRARY = {
  greetings: ['大家好', '各位好', '哈喽', '来了来了', '第一'],
  exclamations: ['哇', '天呐', '绝了', '厉害了', '我的天', '好家伙'],
  agreements: ['说得对', '没错', '确实', '同感', '+1', '排'],
  disagreements: ['不一定吧', '我觉得', '讲道理', '有一说一', '客观来说'],
  questionTags: ['?', '？', '呢', '吗', '吧'],
  endings: ['~', '！', '。', '...', ''],
  videoTopics: {
    game: ['这操作', '这关卡', '这BOSS', '这阵容', '这版本'],
    anime: ['这剧情', '这角色', '这作画', '这OP', '这结局'],
    tech: ['这技术', '这参数', '这性能', '这价格', '这设计'],
    food: ['这卖相', '这味道', '这做法', '这分量', '这价格'],
    general: ['这视频', '这内容', '这期', '这个UP', '这个系列'],
  },
  praiseTemplates: [
    '{exclamation}{topic}也太{adj}了吧{ending}',
    '{greeting}，{topic}{adj}得{ending}',
    '终于等到{topic}了，{exclamation}{ending}',
    '{agreement}，{topic}真的{adj}{ending}',
    '{catchphrase}，{topic}做得{adj}{ending}',
  ],
  critiqueTemplates: [
    '{topic}感觉{adj}啊{question}',
    '{disagreement}，{topic}有点{adj}{ending}',
    '{catchphrase}，{topic}还可以更{adj}{ending}',
    '{exclamation}，{topic}怎么{adj}成这样{ending}',
  ],
  randomTemplates: [
    '{greeting}{ending}',
    '前排{ending}',
    '打卡{ending}',
    '{exclamation}{ending}',
    '学到了{ending}',
    '666{ending}',
    '{agreement}{ending}',
    '路过看看{ending}',
  ],
  adjectives: {
    positive: ['厉害', '精彩', '优秀', '用心', '专业', '震撼', '惊艳', '到位', '扎实', '良心'],
    negative: ['拉胯', '敷衍', '离谱', '尴尬', '生硬', '无聊', '拖沓', '混乱', '廉价', '鸡肋'],
    neutral: ['有意思', '特别', '独特', '新鲜', '意外', '有趣', '特别', '少见', '新奇', '惊喜'],
  },
};

export class ContentGenerator {
  constructor(personaService) {
    this.personaService = personaService;
    this.variables = VARIABLE_LIBRARY;
  }

  /**
   * 生成评论内容
   * @param {Object} params
   * @param {string} params.accountId - 账号ID（用于获取画像）
   * @param {string} [params.videoCategory] - 视频类别(game/anime/tech/food/general)
   * @param {string} [params.tone] - 语气: praise/critique/random
   * @param {string} [params.customText] - 自定义文本（优先使用）
   * @param {Object} [params.videoInfo] - 视频信息（标题/标签）用于上下文
   */
  generate({ accountId, videoCategory = 'general', tone = 'random', customText, videoInfo }) {
    if (customText) return this._applyEmoji(customText, accountId);

    const persona = this.personaService?.getPersona(accountId);
    const template = this._pickTemplate(tone);
    const vars = this._buildVariables(persona, videoCategory, videoInfo);
    let text = template;
    for (const [key, val] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
    }
    // 画像风格调整
    if (persona) {
      if (persona.exclamation && Math.random() > 0.5) {
        text = `${persona.exclamation}，${text}`;
      }
      if (persona.catchphrase && Math.random() > 0.6) {
        text = `${persona.catchphrase}，${text}`;
      }
      text = this._applyEmoji(text, accountId);
    }
    return text.trim();
  }

  /**
   * 批量生成不同文案（用于矩阵引流，避免重复）
   * @param {Object} params
   * @param {string[]} params.accountIds - 账号ID列表
   * @param {string} params.videoCategory - 视频类别
   * @param {string} params.tone - 语气
   * @param {number} params.count - 生成数量
   */
  generateBatch({ accountIds = [], videoCategory = 'general', tone = 'random', count = 1 }) {
    const results = [];
    const used = new Set();
    for (let i = 0; i < count; i++) {
      const accountId = accountIds[i % Math.max(accountIds.length, 1)];
      let text;
      let attempts = 0;
      do {
        text = this.generate({ accountId, videoCategory, tone });
        attempts++;
      } while (used.has(text) && attempts < 5);
      used.add(text);
      results.push({ accountId, text });
    }
    return results;
  }

  /**
   * 生成子账号回复文案（回复主评论）
   * @param {Object} params
   * @param {string} params.accountId - 子账号ID
   * @param {string} params.mainComment - 主评论内容
   */
  generateReply({ accountId, mainComment }) {
    const persona = this.personaService?.getPersona(accountId);
    const replyTemplates = [
      '{agreement}{ending}',
      '{exclamation}{ending}',
      '说得好{ending}',
      '+1{ending}',
      '确实{ending}',
      '哈哈哈{ending}',
      '同感{ending}',
      '前排支持{ending}',
    ];
    let text = replyTemplates[Math.floor(Math.random() * replyTemplates.length)];
    const vars = this._buildVariables(persona, 'general');
    for (const [key, val] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
    }
    if (persona?.emojiSet?.length > 0 && Math.random() > 0.5) {
      text += persona.emojiSet[Math.floor(Math.random() * persona.emojiSet.length)];
    }
    return text;
  }

  /** 敏感词检测（基础版） */
  checkSensitive(text) {
    const sensitiveWords = ['政治敏感词1', '政治敏感词2']; // 实际应维护完整词库
    const found = sensitiveWords.filter(w => text.includes(w));
    return { safe: found.length === 0, found };
  }

  // ===== 内部工具 =====
  _pickTemplate(tone) {
    let pool;
    switch (tone) {
      case 'praise': pool = this.variables.praiseTemplates; break;
      case 'critique': pool = this.variables.critiqueTemplates; break;
      default: pool = this.variables.randomTemplates;
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _buildVariables(persona, videoCategory, videoInfo) {
    const adjPool = this.variables.adjectives;
    const topicPool = this.variables.videoTopics[videoCategory] || this.variables.videoTopics.general;
    return {
      greeting: this._pick(this.variables.greetings),
      exclamation: persona?.exclamation || this._pick(this.variables.exclamations),
      agreement: this._pick(this.variables.agreements),
      disagreement: this._pick(this.variables.disagreements),
      catchphrase: persona?.catchphrase || this._pick(['有一说一', '讲道理', '说实话']),
      topic: this._pick(topicPool),
      adj: this._pick([...adjPool.positive, ...adjPool.neutral]),
      question: this._pick(this.variables.questionTags),
      ending: this._pick(this.variables.endings),
    };
  }

  _pick(arr) {
    return arr && arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : '';
  }

  _applyEmoji(text, accountId) {
    const persona = this.personaService?.getPersona(accountId);
    if (persona?.emojiSet?.length > 0 && Math.random() > 0.6) {
      text += persona.emojiSet[Math.floor(Math.random() * persona.emojiSet.length)];
    }
    return text;
  }
}

export default ContentGenerator;
