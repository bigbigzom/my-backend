/**
 * 文案重组与引流变体引擎 v2.2
 *
 * 功能：
 * 1. 语义重排：保留关键词但改变语序/结构，弱化相同特征（反文案指纹）
 * 2. 引流词变体化：微信/QQ/加群 等强引流词 → 谐音/符号/拼音/私信引导变体
 * 3. 对话剧本生成：主号引流 + 次级号提问/晒单/赞同 的真实对话场
 * 4. 人设差异化：按账号人设选择语气模板
 *
 * 设计原则：
 * - 每条评论引流词最多1个变体（防连续多条同变体指纹）
 * - 不同账号用不同变体
 * - 次级号评论"弱相关"：不夸UP主，做内容相关独立视角
 */
// ============================================================
// 引流词变体库
// ============================================================
const REFERRAL_VARIANTS = {
  'wechat': [
    '威♥', '薇❤️', '微❤', 'W.X', 'w.x', 'V信', 'v信', '胃xin', '威信', 'V❤',
    '加我薇', '私发薇', '威杏', '微X', '视频简介有', '看头像', '看主页',
  ],
  'qq': ['扣扣', '扣Q', 'Q.Q', 'q.q', '企鹅号', 'Q号', '鹅号', '哔Q'],
  'wechat_group': ['拉群', '建了个小群', '交流群', '车友群', '互助群', '小圈子'],
  'direct': ['私信我', '私我', '戳我', '评论区不说这个', '不方便这里说', '发你'],  // 私信引导
  'guide': ['看简介', '看评论区置顶', '点我主页', '看资料'],  // 图片/主页引导
};
// 引流意图模板（主号文案骨架，可变体化）
const MAIN_COPY_TEMPLATES = [
  { action: 'wechat', template: '有需要的可以{action}，人挺多的', weight: 1 },
  { action: 'direct', template: '需要的{action}，看到了就回', weight: 1 },
  { action: 'guide', template: '详细的我放{action}了，自行查看', weight: 1 },
];
// ============================================================
// 次级号对话剧本模板（第三方化：主号被动被问，而非主动安利）
// ============================================================
const DIALOGUE_SCRIPTS = {
  // 对话开场（次级A 提问）
  opener: [
    '这个{keyword}是哪买的呀？求个路子',
    '问一下，这个{keyword}怎么弄的？',
    '楼主这个{keyword}是原创吗？想学',
    '我也一直想弄{keyword}，能带带吗',
    '这个{keyword}在哪搞到的，蹲一个',
  ],
  // 对话回应（主号回复，补充引导）
  mainReply: [
    '{action}，人有点多回复慢',
    '都是自己弄的，有需要的{action}',
    '{action}吧，这里不方便细说',
  ],
  // 围观附和（次级B/C 参与讨论）
  supporter: [
    '同求，我也想问这个',
    '楼主讲的确实中肯，顶一个',
    '蹲到了踢我，我也想入',
    '感谢分享，先码住慢慢看',
    '这条信息量可以，帮顶让更多人看到',
    '已私信楼主，坐等回复',
  ],
  // 晒单/体验（次级D 证明真实性）
  experiencer: [
    '上周刚搞完，效果确实不错，帮楼主证实',
    '自己试过才敢说，这个真行',
    '跟着楼主弄的，已经搞定了，感谢',
    '亲测好用，不是托，放心入',
  ],
  // 理性补充（次级E 增加可信度）
  analyzer: [
    '补充一下，这个确实比市面上那些靠谱',
    '楼主的思路是对的，我补充点细节',
    '看了半天，这条总结得最到位',
  ],
};
// 通用生活化文案池（养号任务用：非引流普通评论）
const NURTURE_COPY = [
  '路过，看到这条有点意思',
  '收藏了，回头慢慢研究',
  '这个视角挺独特的',
  '学到了，感谢分享',
  '说得有道理，支持一下',
  '第一次刷到这个UP主，感觉不错',
  '评论区都是人才，学到了',
  '这个视频剪得挺用心的',
];
// ============================================================
// 工具函数
// ============================================================
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function chance(p) {
  return Math.random() < p;
}
/**
 * 随机替换引流词为变体（每条评论最多1个变体）
 * @param {String} text 含 {action} 占位的文案
 * @param {Object} opts { variantIndex: 指定变体索引（跨账号分散） }
 */
function applyReferralVariant(text, opts = {}) {
  // 提取 action 类型（wechat/qq/wechat_group/direct/guide）
  const m = text.match(/\{action\}/);
  if (!m) return text;
  const actionKeys = Object.keys(REFERRAL_VARIANTS);
  // 随机选一个引流类型（多数用私信/主页引导，少用强词）
  const weightedKeys = ['wechat', 'wechat', 'direct', 'direct', 'guide', 'wechat_group', 'qq'];
  const key = pick(weightedKeys);
  const variants = REFERRAL_VARIANTS[key];
  let variant;
  if (opts.variantIndex !== undefined) {
    variant = variants[opts.variantIndex % variants.length];  // 跨账号分散指定
  } else {
    variant = pick(variants);
  }
  return text.replace('{action}', variant);
}
/**
 * 语义重排：对文案做句式变化（保留关键词，改变语序/标点/断句）
 * 用于弱化"相同特征"（反机器检测：同一文案多次出现时指纹不同）
 */
export function semanticRewrite(text) {
  if (!text) return text;
  const trim = text.trim();
  const variants = [];
  // 1. 原样
  variants.push(trim);
  // 2. 加标点变化（句尾感叹/省略/波浪）
  variants.push(trim + pick(['！', '～', '…', '.', '！', '~']));
  // 3. 加前缀（口语化开场）
  variants.push(pick(['说实话', '讲真', '说真的', '有一说一', '个人觉得', '真心觉得', '过来人讲一句']) + '，' + trim);
  // 4. 加后缀（补充引导）
  variants.push(trim + pick(['，有同样想法的可以一起交流', '，需要的自取', '，先到先得', '，看到都会回']));
  // 5. 断句变化（逗号分隔）
  variants.push(trim.replace(/(.{8,12})/g, '$1，').replace(/，$/, ''));
  // 6. 中英文混排轻微变化
  variants.push(trim.replace(/(?<=\s|^)(和|与)(?=\S)/g, '&'));
  // 7. 括号补充
  variants.push(trim + pick(['（懂的都懂）', '（不是广告）', '（仅供参考）', '（认真脸）']));
  // 8. emoji点缀（少量）
  variants.push(pick(['👀', '✅', '👍', '✨', '🔥']) + ' ' + trim + ' ' + pick(['👌', '🙏', '🎉', '']));
  return pick(variants);
}
/**
 * 生成主号引流文案（语义重排 + 引流词变体）
 * @param {String} base 用户提供的基础引流文案（可含 {action} 占位）
 * @param {Object} opts { variantIndex, keyword }
 */
export function generateMainCopy(base, opts = {}) {
  if (!base) return '';
  let text = base.trim();
  // 若用户文案含引流意图词但无占位，自动附加引导
  if (!text.includes('{action}') && chance(0.6)) {
    text += '，' + pick(['有需要的可以私我', '需要的扣我', '看我主页', '感兴趣的评论区说']).replace(/私我|扣我/, '{action}');
  }
  // 引流词变体化
  const withVariant = applyReferralVariant(text, opts);
  // 语义重排
  return semanticRewrite(withVariant);
}
/**
 * 生成次级号楼中楼文案（对话剧本）
 * @param {String} persona 人设类型
 * @param {Object} opts { keyword, variantIndex, role }
 * @returns {String}
 */
export function generateSubCopy(persona = 'neutral', opts = {}) {
  const keyword = opts.keyword || '';
  const kw = keyword || '这个';
  switch (persona) {
    case 'questioner':
      return pick(DIALOGUE_SCRIPTS.opener).replace('{keyword}', kw);
    case 'praiser':
      return pick(DIALOGUE_SCRIPTS.supporter);
    case 'experiencer':
      return pick(DIALOGUE_SCRIPTS.experiencer);
    case 'analyzer':
      return pick(DIALOGUE_SCRIPTS.analyzer);
    default:
      return pick(DIALOGUE_SCRIPTS.supporter);
  }
}
/**
 * 生成主号回复次级号的文案（对话式：被动引导）
 */
export function generateMainReply(keyword = '', opts = {}) {
  let t = pick(DIALOGUE_SCRIPTS.mainReply);
  t = t.replace('{keyword}', keyword || '');
  return applyReferralVariant(semanticRewrite(t), opts);
}
/**
 * 生成养号用普通生活化评论（非引流，用于账号日常活跃）
 */
export function generateNurtureCopy() {
  return semanticRewrite(pick(NURTURE_COPY));
}
/**
 * 生成一套完整对话剧本（主号发布 + 次级号楼中楼）
 * @param {Object} config { mainCopy, keyword, subPersonas, variantStart }
 * @returns {Object} { mainCopy, subReplies: [{persona, text, role}] }
 */
export function generateDialogue(config = {}) {
  const keyword = config.keyword || '';
  // 主号引流文案
  const mainCopy = generateMainCopy(config.mainCopy, { keyword });
  // 次级号楼中楼（多种角色，形成对话场）
  const subReplies = [];
  const roles = config.roles || ['questioner', 'supporter', 'experiencer', 'analyzer'];
  const variantIdx = config.variantStart || 0;
  roles.forEach((persona, i) => {
    subReplies.push({
      persona,
      role: persona,
      text: generateSubCopy(persona, { keyword, variantIndex: variantIdx + i }),
    });
  });
  // 主号回复（对提问型回复，形成对话）
  if (subReplies.some(r => r.role === 'questioner')) {
    subReplies.unshift({
      persona: 'main',
      role: 'main_reply',
      text: generateMainReply(keyword, { variantIndex: variantIdx + 5 }),
      isMainReply: true,
    });
  }
  return { mainCopy, subReplies };
}
export default { semanticRewrite, generateMainCopy, generateSubCopy, generateMainReply, generateNurtureCopy, generateDialogue };
