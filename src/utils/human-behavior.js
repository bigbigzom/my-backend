/**
 * 人类行为模拟库（v2.2 - 全方位真实用户行为模拟）
 *
 * 参考：
 * - 鼠标轨迹：Bezier 曲线 + 亚像素抖动 + 自然减速（真实鼠标物理特性）
 * - 键盘输入：逐字符 + 可变节奏 + 中文输入法 IME + 打错重打
 * - 滚动：分段自然滚动（快-慢-停顿阅读）
 * - 浏览路径：先浏览页面 → 滚动到目标 → 才执行操作
 * - 行为节奏库：谨慎/均衡/快速 三档（按账号画像选择）
 *
 * 设计原则：让每个操作都"像真实用户"，且各账号操作习惯差异化。
 */
// ============================================================
// 工具函数
// ============================================================
export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
export function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function chance(p) {
  return Math.random() < p;
}
// ============================================================
// 行为节奏库（三档，按账号画像/健康度选择）
// ============================================================
const BEHAVIOR_PROFILES = {
  cautious: {
    name: '谨慎型',
    // 鼠标
    mouseSteps: [30, 50],       // 移动步数（多=慢）
    mouseStepDelay: [8, 18],    // 每步延迟ms
    hoverBeforeClick: [400, 1200],  // 点击前悬停
    clickDown: [80, 200],       // 按下保持
    clickAfter: [300, 800],     // 点击后停顿
    // 键盘
    keyDelay: [60, 180],        // 字符间延迟
    typoRate: 0.08,             // 打错概率
    // 浏览
    scrollStep: [250, 500],     // 滚动每段px
    scrollPause: [400, 1500],   // 每段间停顿
    browseTime: [3000, 8000],   // 浏览停留
    // 节奏
    typePause: [400, 1200],
    actionPause: [2000, 6000],
  },
  balanced: {
    name: '均衡型',
    mouseSteps: [20, 35],
    mouseStepDelay: [3, 10],
    hoverBeforeClick: [200, 700],
    clickDown: [60, 150],
    clickAfter: [200, 500],
    keyDelay: [40, 120],
    typoRate: 0.05,
    scrollStep: [300, 600],
    scrollPause: [300, 1000],
    browseTime: [2000, 5000],
    typePause: [300, 800],
    actionPause: [1000, 4000],
  },
  quick: {
    name: '快速型',
    mouseSteps: [15, 25],
    mouseStepDelay: [2, 6],
    hoverBeforeClick: [100, 400],
    clickDown: [40, 100],
    clickAfter: [150, 400],
    keyDelay: [30, 90],
    typoRate: 0.02,
    scrollStep: [400, 700],
    scrollPause: [200, 700],
    browseTime: [1000, 3000],
    typePause: [200, 600],
    actionPause: [500, 2000],
  },
};
/**
 * 获取行为画像（可按账号稳定选择，或随机）
 * @param {String} accountKey 账号标识（同一账号保持同一档，模拟固定习惯）
 * @param {Object} account    账号对象（可含 behaviorProfile 字段）
 */
export function getBehaviorProfile(accountKey = '', account = null) {
  // 账号已绑定节奏 → 复用（真实用户习惯稳定）
  if (account && account.behaviorProfile && BEHAVIOR_PROFILES[account.behaviorProfile]) {
    return account.behaviorProfile;
  }
  // 否则基于账号key生成稳定档位（同账号每次登录同档）
  if (accountKey) {
    let hash = 0;
    for (let i = 0; i < accountKey.length; i++) hash = (hash * 31 + accountKey.charCodeAt(i)) | 0;
    const keys = Object.keys(BEHAVIOR_PROFILES);
    return keys[Math.abs(hash) % keys.length];
  }
  return 'balanced';
}
export function getBehaviorProfileConfig(profileName = 'balanced') {
  return BEHAVIOR_PROFILES[profileName] || BEHAVIOR_PROFILES.balanced;
}
// ============================================================
// 鼠标轨迹：Bezier 曲线 + 亚像素抖动 + 路过元素 + 自然减速
// ============================================================
/**
 * 三次贝塞尔曲线点
 */
function bezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
    y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
  };
}
/**
 * 计算当前鼠标位置（从页面或默认值）
 */
async function getMousePosition(page) {
  try {
    return await page.evaluate(() => ({ x: window.__mouseX || 200, y: window.__mouseY || 200 }));
  } catch {
    return { x: 200, y: 200 };
  }
}
/**
 * 模拟真实鼠标移动到目标（Bezier + 抖动 + 减速）
 * @param {Page} page
 * @param {Number} targetX
 * @param {Number} targetY
 * @param {Object} profile 行为画像配置
 */
export async function simulateMouseMove(page, targetX, targetY, profileCfg = null) {
  const cfg = profileCfg || getBehaviorProfileConfig('balanced');
  const start = await getMousePosition(page);
  // 随机控制点（让轨迹自然弯曲）
  const ctrl1 = {
    x: start.x + (targetX - start.x) * randomFloat(0.2, 0.4) + (Math.random() - 0.5) * randomInt(80, 250),
    y: start.y + (targetY - start.y) * randomFloat(0.2, 0.4) + (Math.random() - 0.5) * randomInt(80, 250),
  };
  const ctrl2 = {
    x: start.x + (targetX - start.x) * randomFloat(0.6, 0.8) + (Math.random() - 0.5) * randomInt(80, 250),
    y: start.y + (targetY - start.y) * randomFloat(0.6, 0.8) + (Math.random() - 0.5) * randomInt(80, 250),
  };
  const steps = randomInt(cfg.mouseSteps[0], cfg.mouseSteps[1]);
  let prevX = start.x, prevY = start.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // 缓动：接近目标时减速（真实鼠标物理）
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const p = bezierPoint(start, ctrl1, ctrl2, { x: targetX, y: targetY }, eased);
    // 亚像素抖动
    const jx = p.x + (Math.random() - 0.5) * 0.8;
    const jy = p.y + (Math.random() - 0.5) * 0.8;
    await page.mouse.move(jx, jy);
    // 接近目标时加大延迟（减速）
    const dist = Math.sqrt((jx - targetX) ** 2 + (jy - targetY) ** 2);
    const speedFactor = dist < 40 ? 1.8 : dist < 120 ? 1.3 : 1;
    await new Promise(r => setTimeout(r, randomFloat(cfg.mouseStepDelay[0], cfg.mouseStepDelay[1]) * speedFactor));
    prevX = jx; prevY = jy;
  }
  // 精确落在目标（最后一次微调）
  await page.mouse.move(targetX, targetY);
  try { await page.evaluate((x, y) => { window.__mouseX = x; window.__mouseY = y; }, targetX, targetY); } catch {}
  return { prevX, prevY };
}
/**
 * 模拟真实点击（悬停 → 按下 → 松开 → 微位移）
 */
export async function simulateClick(page, selector, profileCfg = null) {
  const cfg = profileCfg || getBehaviorProfileConfig('balanced');
  const el = await page.$(selector);
  if (!el) throw new Error(`元素未找到: ${selector}`);
  const box = await el.boundingBox();
  if (!box) throw new Error(`元素不可见: ${selector}`);
  // 在元素内随机偏移点击（真实用户不会点正中心）
  const cx = box.x + box.width * randomFloat(0.35, 0.65);
  const cy = box.y + box.height * randomFloat(0.35, 0.65);
  await simulateMouseMove(page, cx, cy, cfg);
  // 点击前悬停
  await new Promise(r => setTimeout(r, randomInt(cfg.hoverBeforeClick[0], cfg.hoverBeforeClick[1])));
  await page.mouse.down();
  await new Promise(r => setTimeout(r, randomInt(cfg.clickDown[0], cfg.clickDown[1])));
  await page.mouse.up();
  // 点击后微位移（真实用户点击后手会动）
  if (chance(0.6)) {
    await page.mouse.move(cx + (Math.random() - 0.5) * 8, cy + (Math.random() - 0.5) * 8);
  }
  await new Promise(r => setTimeout(r, randomInt(cfg.clickAfter[0], cfg.clickAfter[1])));
  return { x: cx, y: cy };
}
/**
 * 获取页面可见可点击元素坐标（供点击用，避免遮挡）
 */
export async function getElementCenter(page, selector) {
  const el = await page.$(selector);
  if (!el) return null;
  const box = await el.boundingBox();
  if (!box) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
// ============================================================
// 键盘输入：逐字符 + 中文IME + 打错重打 + 可变节奏
// ============================================================
/**
 * 模拟真实键盘输入
 * - 逐字符输入，字符间延迟随机不均
 * - 偶尔打错字再删除重打（typoRate）
 * - 输入前后有停顿
 *
 * @param {Page} page
 * @param {String} selector 输入框选择器
 * @param {String} text 要输入的文本
 * @param {Object} profileCfg 行为画像
 * @param {Object} opts { ime: 是否模拟中文输入法（true=整段上屏，更真实的中文场景） }
 */
export async function simulateType(page, selector, text, profileCfg = null, opts = {}) {
  const cfg = profileCfg || getBehaviorProfileConfig('balanced');
  const { ime = true } = opts;
  // 1. 点击聚焦
  await simulateClick(page, selector, cfg);
  await new Promise(r => setTimeout(r, randomInt(200, 500)));
  // 2. 清空已有内容（如果有）
  await page.evaluate((sel) => {
    const input = document.querySelector(sel);
    if (input) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, selector);
  await new Promise(r => setTimeout(r, randomInt(100, 300)));
  if (ime && /[\u4e00-\u9fa5]/.test(text)) {
    // 中文输入法模式：模拟 IME 上屏（聚焦后整段上屏，符合中文输入法体验）
    await page.evaluate((sel, t) => {
      const input = document.querySelector(sel);
      if (input) {
        // 模拟 IME composition
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, t);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: t, inputType: 'insertCompositionText' }));
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: t }));
        // 兼容 textarea
        const ta = document.querySelector(`${sel}, textarea`);
        if (ta && ta.tagName === 'TEXTAREA') {
          setter.call(ta, t);
          ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: t }));
        }
      }
    }, selector, text);
    // 模拟输入法打字过程（时间开销）
    const typeDuration = Math.min(text.length * randomInt(30, 60), 2000);
    await new Promise(r => setTimeout(r, typeDuration));
  } else {
    // 英文/数字：逐字符输入
    for (let i = 0; i < text.length; i++) {
      await page.keyboard.type(text[i], { delay: 0 });
      await new Promise(r => setTimeout(r, randomInt(cfg.keyDelay[0], cfg.keyDelay[1])));
      // 打错重打
      if (chance(cfg.typoRate) && i > 0 && i < text.length - 1) {
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, randomInt(100, 300)));
        await page.keyboard.type(text[i], { delay: 0 });
        await new Promise(r => setTimeout(r, randomInt(80, 200)));
      }
    }
  }
  // 3. 输入后停顿（真实用户会检查）
  await new Promise(r => setTimeout(r, randomInt(300, 900)));
}
// ============================================================
// 滚动行为：自然分段滚动 + 停顿阅读
// ============================================================
/**
 * 模拟自然滚动到页面某位置（快-慢-停）
 */
export async function simulateScroll(page, targetY = null, profileCfg = null) {
  const cfg = profileCfg || getBehaviorProfileConfig('balanced');
  const curY = await page.evaluate(() => window.scrollY);
  const maxY = targetY !== null ? targetY : await page.evaluate(() => document.body.scrollHeight);
  let y = curY;
  let guard = 0;
  while ((targetY === null ? y < maxY - 200 : Math.abs(y - maxY) > 50) && guard < 40) {
    const delta = randomInt(cfg.scrollStep[0], cfg.scrollStep[1]);
    const direction = targetY === null ? 1 : (targetY > y ? 1 : -1);
    y += delta * direction;
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'instant' }), y);
    // 随机停顿（阅读）
    await new Promise(r => setTimeout(r, randomInt(cfg.scrollPause[0], cfg.scrollPause[1])));
    guard++;
  }
  await new Promise(r => setTimeout(r, randomInt(300, 1000)));
  return y;
}
// ============================================================
// 浏览路径模拟：打开页面 → 浏览 → 停顿
// ============================================================
/**
 * 模拟真实用户浏览页面（产生自然流量模式）
 * @param {Page} page
 * @param {String} url 目标URL
 * @param {Object} opts { scrollTo: 是否滚动, browseMs: 浏览时长 }
 */
export async function simulateBrowsing(page, url, opts = {}) {
  const profileName = getBehaviorProfile();
  const cfg = getBehaviorProfileConfig(profileName);
  const browseMs = opts.browseMs || randomInt(cfg.browseTime[0], cfg.browseTime[1]);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // 页面加载后短暂停顿（真实用户感知页面加载）
  await new Promise(r => setTimeout(r, randomInt(800, 2000)));
  // 分段滚动浏览
  if (opts.scrollTo !== false) {
    await simulateScroll(page, null, cfg);
  }
  // 浏览停留
  await new Promise(r => setTimeout(r, browseMs));
  return profileName;
}
/**
 * 页面停留（随机时长）
 */
export async function simulatePause(page, profileCfg = null, msOverride = null) {
  const cfg = profileCfg || getBehaviorProfileConfig('balanced');
  const ms = msOverride || randomInt(cfg.actionPause[0], cfg.actionPause[1]);
  await new Promise(r => setTimeout(r, ms));
  return ms;
}
/**
 * Tab 切换/失焦模拟（真实用户会切走再回来）
 */
export async function simulateTabSwitch(page, probability = 0.3) {
  if (!chance(probability)) return false;
  try {
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('blur'));
    });
    await new Promise(r => setTimeout(r, randomInt(1500, 5000)));
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    return true;
  } catch {
    return false;
  }
}
// ============================================================
// 综合：登录页人机行为模拟（登录时调用）
// ============================================================
export const humanSimulator = {
  randomInt, randomFloat, chance,
  getBehaviorProfile, getBehaviorProfileConfig,
  simulateMouseMove, simulateClick, simulateType,
  simulateScroll, simulateBrowsing, simulatePause, simulateTabSwitch,
};
export default humanSimulator;
