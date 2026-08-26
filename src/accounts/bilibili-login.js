/**
 * B站自动登录类（v2.0 - 信任设备架构）
 *
 * ════════════════════════════════════════════════════════════
 *  核心架构：本地登录 + 远程存储
 * ════════════════════════════════════════════════════════════
 *
 *  【登录执行】 → 本地运行（Puppeteer + Chromium）
 *    - Render免费版无法运行Puppeteer（缺依赖+内存不足）
 *    - 短信验证码必须用户在本地浏览器输入
 *    - 滑块验证必须用户在本地浏览器完成
 *
 *  【Cookie存储】 → Render后端（API上传）
 *    - 本地登录成功后，POST /api/accounts/sync-cookie 上传
 *    - 后端保存到 accounts.json
 *    - 前端从后端读取账号列表
 *
 * ════════════════════════════════════════════════════════════
 *  B站信任设备逻辑（关键！）
 * ════════════════════════════════════════════════════════════
 *
 *  B站的安全机制：只在"已登录过的信任设备"上，才能用账号密码直接登录，
 *  新设备/未信任设备登录必须通过短信验证码验证。
 *
 *  本类通过 Puppeteer 的 userDataDir 持久化浏览器数据来模拟"信任设备"：
 *
 *  ┌─────────────────────────────────────────────────────────┐
 *  │  首次登录（无信任设备）                                   │
 *  │  ┌──────────┐    ┌──────────────┐    ┌──────────────┐ │
 *  │  │ 启动浏览器 │ →  │ 手机号+验证码 │ →  │ 建立信任设备  │ │
 *  │  │(新userDir)│    │ (必须人工输入)│    │(保存userDir) │ │
 *  │  └──────────┘    └──────────────┘    └──────┬───────┘ │
 *  │                                                │         │
 *  │  后续登录（同一信任设备）                       │         │
 *  │  ┌──────────┐    ┌──────────────┐    ┌──────▼───────┐ │
 *  │  │ 启动浏览器 │ →  │  账号密码登录  │ →  │ 无需短信验证 │ │
 *  │  │(复用userDir)│   │ (自动填充)    │    │ (信任设备)   │ │
 *  │  └──────────┘    └──────────────┘    └──────────────┘ │
 *  │                                                           │
 *  │  信任设备失效（清除数据/换设备/太久未登录）              │
 *  │  → 自动回退到手机号+验证码模式重新建立信任              │
 *  └─────────────────────────────────────────────────────────┘
 *
 * ════════════════════════════════════════════════════════════
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import { getProxy, waitForProxy, markProxyFailed, getProxyPoolStats, startProxyPool } from '../utils/proxy-pool.js';
import { generateFingerprint, injectFingerprint } from '../utils/browser-fingerprint.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 配置
// ============================================================
const LOGIN_URL = 'https://passport.bilibili.com/login';
const HOME_URL = 'https://www.bilibili.com/';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';

// 本地信任设备数据目录（每个账号一个子目录）
const TRUSTED_DEVICE_DIR = path.join(__dirname, '../../.trusted-devices');

// 真实浏览器User-Agent池
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];

// ============================================================
// 人工操作模拟工具函数
// ============================================================
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function bezierCurve(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
    y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
  };
}

async function humanMouseMove(page, targetX, targetY) {
  const startPoint = await page.evaluate(() => ({
    x: window.mouseX || Math.random() * 800 + 100,
    y: window.mouseY || Math.random() * 400 + 100,
  }));
  const cp1 = { x: startPoint.x + (targetX-startPoint.x)*0.3 + (Math.random()-0.5)*200, y: startPoint.y + (targetY-startPoint.y)*0.3 + (Math.random()-0.5)*200 };
  const cp2 = { x: startPoint.x + (targetX-startPoint.x)*0.7 + (Math.random()-0.5)*200, y: startPoint.y + (targetY-startPoint.y)*0.7 + (Math.random()-0.5)*200 };
  const steps = randomDelay(20, 40);
  for (let i = 0; i <= steps; i++) {
    const point = bezierCurve(startPoint, cp1, cp2, {x:targetX,y:targetY}, i/steps);
    await page.mouse.move(point.x, point.y);
    await new Promise(r => setTimeout(r, randomDelay(2, 8)));
  }
  await page.evaluate((x,y) => { window.mouseX=x; window.mouseY=y; }, targetX, targetY);
}

async function humanClick(page, selector) {
  const element = await page.$(selector);
  if (!element) throw new Error(`元素未找到: ${selector}`);
  const box = await element.boundingBox();
  if (!box) throw new Error(`元素不可见: ${selector}`);
  const clickX = box.x + box.width/2 + (Math.random()-0.5)*box.width*0.3;
  const clickY = box.y + box.height/2 + (Math.random()-0.5)*box.height*0.3;
  await humanMouseMove(page, clickX, clickY);
  await new Promise(r => setTimeout(r, randomDelay(100, 400)));
  await page.mouse.down();
  await new Promise(r => setTimeout(r, randomDelay(50, 150)));
  await page.mouse.up();
  await new Promise(r => setTimeout(r, randomDelay(200, 600)));
}

// 可靠地切换登录tab（B站登录页tab是DIV，需点击祖先中cursor:pointer的元素）
async function clickLoginTab(page, tabText) {
  const clicked = await page.evaluate((text) => {
    const all = [...document.querySelectorAll('*')];
    // 优先精确匹配tab文本
    const target = all.find(el => {
      const t = (el.textContent || '').trim();
      return t === text && el.children.length === 0;  // 叶子节点
    });
    if (!target) return false;
    // 沿祖先链找cursor:pointer的可点击元素
    let el = target;
    for (let i = 0; i < 6 && el; i++) {
      if (getComputedStyle(el).cursor === 'pointer') {
        el.click();
        return true;
      }
      el = el.parentElement;
    }
    // 兜底：点击目标本身
    target.click();
    return true;
  }, tabText);
  if (clicked) {
    await new Promise(r => setTimeout(r, randomDelay(800, 1500)));
  }
  return clicked;
}
// 等待元素出现（B站登录页是SPA，输入框动态渲染，需等待）
async function waitForElement(page, selectors, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await page.evaluate((sels) => {
      for (const sel of sels) {
        if (document.querySelector(sel)) return sel;
      }
      return null;
    }, selectors);
    if (found) return found;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}
async function humanType(page, selector, text) {
  await humanClick(page, selector);
  await new Promise(r => setTimeout(r, randomDelay(200, 500)));
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i], { delay: 0 });
    await new Promise(r => setTimeout(r, randomDelay(50, 200)));
    if (Math.random() < 0.05 && i > 0 && i < text.length-1) {
      await page.keyboard.press('Backspace');
      await new Promise(r => setTimeout(r, randomDelay(100, 300)));
      await page.keyboard.type(text[i], { delay: 0 });
      await new Promise(r => setTimeout(r, randomDelay(80, 150)));
    }
  }
  await new Promise(r => setTimeout(r, randomDelay(300, 800)));
}

// ============================================================
// B站登录类（v2.0 信任设备架构）
// ============================================================
export class BilibiliLogin {
  constructor(options = {}) {
    this.headless = options.headless !== false;
    this.timeout = options.timeout || 180000;
    this.backendUrl = options.backendUrl || '';  // Render后端地址，用于上传Cookie
    this.useProxy = options.useProxy !== false;   // ★ 是否使用中国IP代理（默认开启）
    this.useFingerprint = options.useFingerprint !== false;  // ★ 是否使用指纹随机化（默认开启）
    this.proxy = null;           // 当前使用的代理
    this.fingerprint = null;     // 当前使用的指纹
    this.browser = null;
    this.page = null;
    this.userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    this.currentAccountKey = null;  // 当前账号的信任设备标识
  }

  /**
   * 获取账号的信任设备目录路径
   * 每个账号对应一个独立的浏览器数据目录 = 一个"信任设备"
   */
  getTrustedDeviceDir(accountKey) {
    const safeKey = String(accountKey).replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(TRUSTED_DEVICE_DIR, safeKey);
  }

  /**
   * 检测账号是否已有信任设备
   */
  hasTrustedDevice(accountKey) {
    const dir = this.getTrustedDeviceDir(accountKey);
    // 信任设备 = 曾成功登录的设备（有 .trusted 标记）
    return fs.existsSync(path.join(dir, '.trusted'));
  }

  /**
   * 标记账号已成功登录（建立信任设备）
   */
  markTrusted(accountKey) {
    const dir = this.getTrustedDeviceDir(accountKey);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.trusted'), JSON.stringify({ createdAt: new Date().toISOString(), key: accountKey }));
    console.log(`[BilibiliLogin] ✅ 已标记信任设备: ${accountKey}`);
  }

  /**
   * 清除信任标记（登录失败/信任失效时）
   */
  unmarkTrusted(accountKey) {
    const dir = this.getTrustedDeviceDir(accountKey);
    const f = path.join(dir, '.trusted');
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  /**
   * 清除信任设备（当信任失效时调用）
   */
  clearTrustedDevice(accountKey) {
    const dir = this.getTrustedDeviceDir(accountKey);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[BilibiliLogin] 已清除信任设备: ${accountKey}`);
    }
  }

  /**
   * 启动浏览器（使用信任设备目录）
   */
  async launch(accountKey = 'default') {
    // 账号key一致性：如果浏览器已启动但信任设备key不同，先关闭重建
    if (this.browser && this.currentAccountKey && this.currentAccountKey !== accountKey) {
      console.log(`[BilibiliLogin] 信任设备key变化 (${this.currentAccountKey} → ${accountKey})，重建浏览器`);
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.proxy = null;   // 重新获取代理（新设备=新IP）
      this.fingerprint = null;  // 重新生成指纹
    }
    this.currentAccountKey = accountKey;
    const userDataDir = this.getTrustedDeviceDir(accountKey);

    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
      console.log(`[BilibiliLogin] 创建新信任设备目录: ${userDataDir}`);
    } else {
      console.log(`[BilibiliLogin] 复用信任设备目录: ${userDataDir}`);
    }

    // ★ 获取中国IP代理
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,800',
      '--lang=zh-CN',
    ];

    if (this.useProxy) {
      console.log('[BilibiliLogin] 正在获取中国IP代理...');
      try {
        // 确保代理池已启动
        try { startProxyPool(50 * 1000); } catch(e) {}
        console.log('[BilibiliLogin] 正在等待中国IP代理（最多30秒，免费代理验证需要时间）...');
        this.proxy = await waitForProxy(30000);
        if (this.proxy) {
          launchArgs.push(`--proxy-server=http://${this.proxy.proxy}`);
          console.log(`[BilibiliLogin] ✅ 使用代理: ${this.proxy.proxy} (延迟: ${this.proxy.speed}ms, 出口IP: ${this.proxy.ip})`);
        } else {
          console.warn('[BilibiliLogin] ⚠️ 30秒内未获取到代理，将直连登录（建议配置更稳定的代理源）');
        }
      } catch (e) {
        console.warn('[BilibiliLogin] ⚠️ 获取代理失败，将直连登录:', e.message);
      }
    }

    this.browser = await puppeteer.launch({
      headless: this.headless,
      userDataDir: userDataDir,
      args: launchArgs,
      defaultViewport: { width: 1280, height: 800 },
    });

    this.page = await this.browser.newPage();

    // ★ 代理认证（仅当代理带认证信息时）
    if (this.proxy && this.proxy.username && this.proxy.password) {
      await this.page.authenticate({
        username: this.proxy.username,
        password: this.proxy.password,
      });
      console.log('[BilibiliLogin] 已配置代理认证');
    }

    // ★ 浏览器指纹随机化
    if (this.useFingerprint) {
      console.log('[BilibiliLogin] 正在生成随机浏览器指纹...');
      this.fingerprint = generateFingerprint();
      await injectFingerprint(this.page, this.fingerprint);
      console.log(`[BilibiliLogin] 指纹已注入: UA=${this.fingerprint.userAgent.substring(0,50)}...`);
      console.log(`[BilibiliLogin] 屏幕=${this.fingerprint.screenWidth}x${this.fingerprint.screenHeight}, GPU=${this.fingerprint.webglRenderer.substring(0,30)}...`);
      console.log(`[BilibiliLogin] 时区=${this.fingerprint.timezone}, CPU=${this.fingerprint.hardwareConcurrency}核, 内存=${this.fingerprint.deviceMemory}GB`);
    } else {
      // 不使用指纹随机化时，基础反检测
      await this.page.setUserAgent(this.userAgent);
      await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });
      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
        window.chrome = { runtime: {} };
      });
    }

    console.log(`[BilibiliLogin] 浏览器启动成功，信任设备: ${accountKey}`);
    if (this.proxy) console.log(`[BilibiliLogin] 代理: ${this.proxy.proxy}`);
    if (this.fingerprint) console.log(`[BilibiliLogin] 指纹ID: ${this.fingerprint.fingerprintId}`);
    // ★ 登录前验证代理出口IP（确保是中国IP，防止代理失效被B站风控）
    if (this.useProxy && this.proxy) {
      try {
        await this.page.goto('http://ip-api.com/json/?fields=status,country,countryCode,query', { waitUntil: 'domcontentloaded', timeout: 8000 });
        const ipData = await this.page.evaluate(() => JSON.parse(document.body.innerText));
        if (ipData.status === 'success') {
          const isChina = ipData.countryCode === 'CN' || ipData.country === 'China';
          console.log(`[BilibiliLogin] 代理出口IP: ${ipData.query} (${ipData.country}) ${isChina ? '✅ 中国IP' : '⚠️ 非中国IP'}`);
          if (!isChina) {
            console.warn('[BilibiliLogin] ⚠️ 代理出口非中国IP，可能影响B站访问，继续尝试...');
          }
        }
      } catch (e) {
        console.warn('[BilibiliLogin] 代理IP验证失败（继续登录）:', e.message);
      }
    }
  }

  /**
   * 检测当前浏览器是否已有登录态（信任设备+已登录）
   */
  async checkLoginStatus() {
    try {
      const response = await this.page.goto(NAV_URL, { waitUntil: 'networkidle2', timeout: 10000 });
      const data = await response.json();
      if (data.code === 0 && data.data && data.data.isLogin) {
        return { loggedIn: true, uid: data.data.mid, uname: data.data.uname };
      }
      return { loggedIn: false };
    } catch (e) {
      return { loggedIn: false, error: e.message };
    }
  }

  /**
   * 从浏览器提取Cookie并构建账号对象
   */
  async extractAccount(extra = {}) {
    const cookies = await this.page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const sessdata = cookies.find(c => c.name === 'SESSDATA');
    const biliJct = cookies.find(c => c.name === 'bili_jct');
    const dedeUserID = cookies.find(c => c.name === 'DedeUserID');

    if (!sessdata || !biliJct) {
      throw new Error('未获取到完整的登录Cookie（缺少SESSDATA或bili_jct）');
    }

    return {
      id: Date.now() + Math.random(),
      type: 'browser_login',
      username: dedeUserID ? dedeUserID.value : (extra.phone || extra.account || 'unknown'),
      phone: extra.phone || '',
      account: extra.account || '',
      password: extra.password || '',
      remark: extra.remark || `本地登录-${new Date().toLocaleDateString()}`,
      cookie: cookieStr,
      csrf: biliJct.value,
      cookieExpire: Date.now() + 7 * 24 * 3600 * 1000,
      status: 'normal',
      useProxy: true,
      todayPublished: 0,
      lastPublishTime: 0,
      cooldownUntil: 0,
      loginAt: new Date().toISOString(),
      loginMode: extra.loginMode || 'unknown',
      trustedDevice: this.currentAccountKey,
      userAgent: this.fingerprint ? this.fingerprint.userAgent : this.userAgent,
      // ★ 记录本次登录使用的代理和指纹（用于风控分析）
      loginProxy: this.proxy ? this.proxy.proxy : null,
      loginFingerprintId: this.fingerprint ? this.fingerprint.fingerprintId : null,
      loginFingerprintSummary: this.fingerprint ? {
        screen: `${this.fingerprint.screenWidth}x${this.fingerprint.screenHeight}`,
        gpu: this.fingerprint.webglRenderer,
        timezone: this.fingerprint.timezone,
        cpu: this.fingerprint.hardwareConcurrency,
      } : null,
    };
  }

  /**
   * 上传Cookie到Render后端保存
   */
  async uploadToBackend(account) {
    if (!this.backendUrl) {
      console.log('[BilibiliLogin] 未配置后端地址，跳过Cookie上传（仅本地保存）');
      return { uploaded: false, reason: 'no_backend_url' };
    }
    try {
      const response = await fetch(`${this.backendUrl}/api/accounts/sync-cookie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account }),
      });
      const data = await response.json();
      if (data.code === 0) {
        console.log(`[BilibiliLogin] Cookie已上传到后端: ${this.backendUrl}`);
        return { uploaded: true, data };
      }
      console.warn(`[BilibiliLogin] 后端上传失败: ${data.message}`);
      return { uploaded: false, reason: data.message };
    } catch (e) {
      console.warn(`[BilibiliLogin] 后端上传异常: ${e.message}`);
      return { uploaded: false, reason: e.message };
    }
  }

  // ============================================================
  // 登录模式一：手机号 + 短信验证码（首次登录 / 信任设备失效）
  // ============================================================
  async loginByPhoneCode(phone, options = {}) {
    const { onCodeRequired = null, onCaptchaRequired = null, codeTimeout = 180000 } = options;

    await this.launch(phone);  // 始终用手机号作为信任设备key

    console.log(`[BilibiliLogin] 【手机号验证码模式】登录: ${phone.substring(0,3)}****${phone.substring(7)}`);
    console.log('[BilibiliLogin] 此模式用于首次登录或信任设备失效，将建立/重建信任设备');

    try {
      // 1. 打开登录页
      await this.page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: this.timeout });
      await new Promise(r => setTimeout(r, randomDelay(1000, 2000)));

      // 2. 等待登录表单渲染完成（SPA动态渲染）
      const phoneSel = await waitForElement(this.page, ['input[type="tel"]', 'input[placeholder*="手机"]', 'input[placeholder*="手机号"]', 'input[name="tel"]'], 15000);
      if (!phoneSel) {
        console.warn('[BilibiliLogin] ⚠️ 未找到手机号输入框，可能页面结构变化');
      }
      // 2.1 切换到短信登录tab（可靠点击）
      try {
        await clickLoginTab(this.page, '短信登录');
      } catch (e) { console.log('[BilibiliLogin] 切换短信tab失败:', e.message); }

      // 3. 输入手机号（短信tab切换后需等待手机号输入框出现）
      await waitForElement(this.page, ['input[type="tel"]', 'input[placeholder*="手机"]', 'input[placeholder*="手机号"]'], 8000);
      await this.page.evaluate((p) => {
        const input = document.querySelector('input[type="tel"]') || document.querySelector('input[placeholder*="手机"]') || document.querySelector('input[placeholder*="手机号"]');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, p);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, phone);
      await new Promise(r => setTimeout(r, randomDelay(500, 1200)));

      // 4. 点击获取验证码
      await this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
          if (btn.textContent.includes('验证码') && !btn.disabled) { btn.click(); break; }
        }
      });
      await new Promise(r => setTimeout(r, randomDelay(1000, 2000)));

      // 5. 检测滑块验证
      const hasCaptcha = await this.page.evaluate(() => !!document.querySelector('.geetest_panel, [class*="captcha"], [class*="geetest"]'));
      if (hasCaptcha) {
        console.log('[BilibiliLogin] 检测到滑块验证，请在浏览器中手动完成');
        if (onCaptchaRequired) onCaptchaRequired();
        await this.page.waitForFunction(() => !document.querySelector('.geetest_panel'), { timeout: 120000 }).catch(() => {});
        await new Promise(r => setTimeout(r, randomDelay(1000, 2000)));
      }

      // 6. 等待用户输入验证码
      console.log('[BilibiliLogin] 请在浏览器中输入短信验证码...');
      if (onCodeRequired) onCodeRequired(phone);
      await this.page.waitForFunction(() => {
        const input = document.querySelector('input[placeholder*="验证码"], input[type="text"][maxlength="6"]');
        return input && input.value && input.value.length >= 4;
      }, { timeout: codeTimeout }).catch(() => { throw new Error('验证码输入超时'); });

      // 7. 点击登录
      await new Promise(r => setTimeout(r, randomDelay(500, 1000)));
      await this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.includes('登录') && !btn.disabled) { btn.click(); break; }
        }
      });

      // 8. 等待登录成功
      await this.page.waitForFunction(() => document.cookie.includes('SESSDATA=') && document.cookie.includes('bili_jct='), { timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, randomDelay(1500, 3000)));

      // 9. 提取账号 + 上传后端
      const account = await this.extractAccount({ phone, loginMode: 'phone_code' });
      const uploadResult = await this.uploadToBackend(account);

      console.log(`[BilibiliLogin] ✅ 手机号验证码登录成功！UID: ${account.username}`);
      this.markTrusted(this.currentAccountKey);  // 建立信任设备标记
      console.log(`[BilibiliLogin] 信任设备已建立: ${this.currentAccountKey}`);
      console.log(`[BilibiliLogin] Cookie上传后端: ${uploadResult.uploaded ? '成功' : '跳过/失败'}`);

      return { success: true, account, upload: uploadResult, loginMode: 'phone_code' };

    } catch (error) {
      console.error('[BilibiliLogin] 手机号验证码登录失败:', error.message);
      return { success: false, error: error.message, loginMode: 'phone_code' };
    }
  }

  // ============================================================
  // 登录模式二：账号密码（信任设备上，无需短信验证）
  // ============================================================
  async loginByPassword(account, password, options = {}) {
    const accountKey = account;  // 用账号名作为信任设备标识

    await this.launch(accountKey);  // 始终用账号作为信任设备key

    console.log(`[BilibiliLogin] 【账号密码模式】登录: ${account}`);

    // 检测是否已有登录态（信任设备+已登录）
    const status = await this.checkLoginStatus();
    if (status.loggedIn) {
      this.markTrusted(accountKey);  // 确认信任设备有效
      console.log(`[BilibiliLogin] 信任设备已有登录态，UID: ${status.uid}，无需重新登录`);
      const acc = await this.extractAccount({ account, loginMode: 'trusted_auto' });
      const uploadResult = await this.uploadToBackend(acc);
      return { success: true, account: acc, upload: uploadResult, loginMode: 'trusted_auto', skippedLogin: true };
    }

    // 检测是否有信任设备
    if (!this.hasTrustedDevice(accountKey)) {
      console.warn('[BilibiliLogin] ⚠️ 未检测到信任设备！账号密码登录可能失败，建议先使用手机号验证码模式建立信任设备');
    } else {
      console.log('[BilibiliLogin] 检测到信任设备，尝试账号密码登录（无需短信验证）');
    }

    try {
      // 1. 打开登录页
      await this.page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: this.timeout });
      await new Promise(r => setTimeout(r, randomDelay(1000, 2000)));

      // 2. 等待登录表单渲染完成（SPA动态渲染）
      const passSel = await waitForElement(this.page, ['input[type="password"]', 'input[placeholder*="密码"]'], 15000);
      if (!passSel) {
        console.warn('[BilibiliLogin] ⚠️ 未找到密码输入框，可能页面结构变化');
      }
      // 2.1 确保在"密码登录"tab（默认通常是密码登录）
      try {
        await clickLoginTab(this.page, '密码登录');
      } catch (e) {}

      // 3. 输入账号（优先匹配placeholder含"账号"的输入框，避免匹配到验证码框）
      await this.page.evaluate((a) => {
        const exact = document.querySelector('input[placeholder*="账号"]') || document.querySelector('input[placeholder*="手机"]') || document.querySelector('input[placeholder*="邮箱"]');
        const input = exact || document.querySelector('input[type="text"]');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, a);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, account);
      await new Promise(r => setTimeout(r, randomDelay(500, 1000)));

      // 4. 输入密码
      await this.page.evaluate((p) => {
        const input = document.querySelector('input[type="password"]');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, p);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, password);
      await new Promise(r => setTimeout(r, randomDelay(500, 1000)));

      // 5. 点击登录
      await this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.includes('登录') && !btn.disabled) { btn.click(); break; }
        }
      });

      // 6. 等待登录结果（检测是否跳转到验证码页面=信任设备失效）
      await new Promise(r => setTimeout(r, randomDelay(2000, 4000)));

      // 检测是否需要短信验证（信任设备失效）
      const needSms = await this.page.evaluate(() => {
        const text = document.body.innerText;
        return text.includes('短信验证') || text.includes('验证码') || text.includes('安全验证') || document.querySelector('input[placeholder*="验证码"]');
      });

      if (needSms) {
        console.warn('[BilibiliLogin] ⚠️ 信任设备失效！B站要求短信验证。请改用手机号验证码模式重新建立信任设备');
        return {
          success: false,
          error: '信任设备失效，需要短信验证。请使用 loginByPhoneCode() 重新登录建立信任设备',
          loginMode: 'password',
          trustFailed: true,
        };
      }

      // 7. 等待登录成功
      await this.page.waitForFunction(() => document.cookie.includes('SESSDATA=') && document.cookie.includes('bili_jct='), { timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, randomDelay(1000, 2000)));

      // 8. 验证登录成功
      const finalStatus = await this.checkLoginStatus();
      if (!finalStatus.loggedIn) {
        return { success: false, error: '账号密码登录失败，可能密码错误或账号异常', loginMode: 'password' };
      }

      // 9. 提取账号 + 上传后端
      const acc = await this.extractAccount({ account, password, loginMode: 'password' });
      const uploadResult = await this.uploadToBackend(acc);

      this.markTrusted(accountKey);  // 确认信任设备有效
      console.log(`[BilibiliLogin] ✅ 账号密码登录成功！UID: ${acc.username}（信任设备，无需短信验证）`);
      console.log(`[BilibiliLogin] Cookie上传后端: ${uploadResult.uploaded ? '成功' : '跳过/失败'}`);

      return { success: true, account: acc, upload: uploadResult, loginMode: 'password' };

    } catch (error) {
      console.error('[BilibiliLogin] 账号密码登录失败:', error.message);
      return { success: false, error: error.message, loginMode: 'password' };
    }
  }

  // ============================================================
  // 智能登录：自动选择最佳登录模式
  // ============================================================
  async smartLogin(params = {}) {
    const { phone, account, password, forceMode = null } = params;

    console.log('\n═══════════════════════════════════════════');
    console.log('[BilibiliLogin] 智能登录启动');
    console.log('═══════════════════════════════════════════');

    // 强制指定模式
    if (forceMode === 'phone_code') {
      console.log('[BilibiliLogin] 强制使用手机号验证码模式');
      return this.loginByPhoneCode(phone, params);
    }
    if (forceMode === 'password') {
      console.log('[BilibiliLogin] 强制使用账号密码模式');
      return this.loginByPassword(account, password, params);
    }

    // 自动选择逻辑
    if (account && password) {
      // 有账号密码 → 先尝试信任设备密码登录
      const hasTrust = this.hasTrustedDevice(account);
      if (hasTrust) {
        console.log('[BilibiliLogin] 检测到信任设备 → 使用账号密码模式（无需短信验证）');
        const result = await this.loginByPassword(account, password, params);
        // 如果信任设备失效，回退到手机号验证码
        if (result.trustFailed && phone) {
          console.log('[BilibiliLogin] 信任设备失效 → 回退到手机号验证码模式重新建立信任');
          await this.close();
          return this.loginByPhoneCode(phone, params);
        }
        return result;
      } else {
        console.log('[BilibiliLogin] 无信任设备 → 必须使用手机号验证码模式建立信任');
        if (phone) {
          return this.loginByPhoneCode(phone, params);
        }
        return { success: false, error: '无信任设备且未提供手机号，无法登录。请先使用手机号验证码登录建立信任设备' };
      }
    }

    if (phone) {
      console.log('[BilibiliLogin] 仅提供手机号 → 使用手机号验证码模式');
      return this.loginByPhoneCode(phone, params);
    }

    return { success: false, error: '请提供手机号，或提供账号+密码（需已有信任设备）' };
  }

  /**
   * 关闭浏览器
   */
  async close(loginSuccess = true) {
    // 登录失败时取消信任标记（信任建立失败/被B站拒绝）
    if (!loginSuccess && this.currentAccountKey) {
      this.unmarkTrusted(this.currentAccountKey);
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      // 如果登录失败且使用了代理，标记该代理失败（可能是代理被B站封禁）
      if (!loginSuccess && this.proxy) {
        try { markProxyFailed(this.proxy.proxy); } catch(e) {}
        console.log(`[BilibiliLogin] 登录失败，已标记代理: ${this.proxy.proxy}`);
      }
      console.log('[BilibiliLogin] 浏览器已关闭（信任设备数据已保存在本地）');
    }
  }
}

// ============================================================
// 导出人工操作模拟工具
// ============================================================
export const humanSimulator = { randomDelay, humanMouseMove, humanClick, humanType };

export default BilibiliLogin;
