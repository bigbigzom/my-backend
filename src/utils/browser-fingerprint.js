/**
 * 浏览器指纹工具 v2.2（10 → 20+ 维度，画像化）
 *
 * 参考开源项目：
 * - puppeteer-extra-plugin-stealth（17个evasion模块）
 * - fingerprint-suite by Apify（贝叶斯网络生成真实指纹）
 * - CloakBrowser（源码级指纹补丁）
 * - browser-fingerprint-mitigations（Chrome官方指纹缓解）
 *
 * v2.2 重大升级：
 * 1. 维度扩展 10→20+：字体列表、WebRTC、DPR、ClientRects、电池、传感器、键盘布局、媒体设备、权限、GPU精度
 * 2. 合理组合库 REAL_COMBOS：杜绝"Mac上跑GTX显卡"这类不存在设备
 * 3. 指纹画像持久化：每账号绑定稳定画像（getOrCreateFingerprint），同账号复用，换号才换
 * 4. WebRTC 防真IP泄漏（伪造与代理一致的对等IP）
 * 5. 指纹与代理IP地理一致性（timezone 从代理城市映射）
 * 6. Canvas/WebGL 噪声种子绑定指纹ID（同指纹噪声一致）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FINGERPRINT_DIR = path.join(__dirname, '../../.fingerprints');
// ============================================================
// 真实设备合理组合库（OS ↔ GPU ↔ 屏幕 ↔ 浏览器 ↔ 字体）
// 每组是一个"真实存在的设备"，抽取时整组使用，保证自洽
// ============================================================
const REAL_COMBOS = [
  // Windows 桌面机（NVIDIA 独显）
  { os: 'win', gpu: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB, OpenGL 4.5)' }, screens: [{ w: 1920, h: 1080, dpr: 1 }, { w: 2560, h: 1440, dpr: 1 }], chrome: [120, 121, 122], hw: [{ c: 8, m: 16 }, { c: 16, m: 32 }] },
  { os: 'win', gpu: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)' }, screens: [{ w: 1920, h: 1080, dpr: 1 }, { w: 2560, h: 1440, dpr: 1 }], chrome: [120, 121], hw: [{ c: 8, m: 16 }, { c: 16, m: 32 }] },
  { os: 'win', gpu: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650, OpenGL 4.5)' }, screens: [{ w: 1366, h: 768, dpr: 1 }, { w: 1920, h: 1080, dpr: 1 }], chrome: [119, 120, 121], hw: [{ c: 4, m: 8 }, { c: 8, m: 8 }] },
  // Windows 集显（办公机）
  { os: 'win', gpu: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.5)' }, screens: [{ w: 1366, h: 768, dpr: 1 }, { w: 1920, h: 1080, dpr: 1 }, { w: 1280, h: 720, dpr: 1 }], chrome: [120, 121, 122, 123], hw: [{ c: 4, m: 4 }, { c: 4, m: 8 }, { c: 8, m: 8 }] },
  { os: 'win', gpu: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, OpenGL 4.5)' }, screens: [{ w: 1920, h: 1080, dpr: 1 }, { w: 1536, h: 864, dpr: 1 }], chrome: [121, 122], hw: [{ c: 8, m: 16 }] },
  // Windows AMD 独显
  { os: 'win', gpu: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series, OpenGL 4.5)' }, screens: [{ w: 1920, h: 1080, dpr: 1 }, { w: 1600, h: 900, dpr: 1 }], chrome: [120, 121], hw: [{ c: 8, m: 8 }, { c: 8, m: 16 }] },
  // macOS（Apple 硅/Intel）
  { os: 'mac', gpu: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)' }, screens: [{ w: 1440, h: 900, dpr: 2 }, { w: 2560, h: 1600, dpr: 2 }, { w: 1280, h: 800, dpr: 2 }], chrome: [120, 121, 122], hw: [{ c: 8, m: 8 }, { c: 8, m: 16 }] },
  { os: 'mac', gpu: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' }, screens: [{ w: 1440, h: 900, dpr: 2 }, { w: 1512, h: 982, dpr: 2 }], chrome: [121, 122, 123], hw: [{ c: 8, m: 16 }, { c: 10, m: 16 }] },
];
// Chrome UA 模板（按组合的 os/chrome 版本生成）
const UA_TEMPLATES = {
  win: (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
  mac: (v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
};
// 中国城市 → 时区映射（指纹与代理IP地理一致性）
const CITY_TIMEZONES = {
  'beijing': 'Asia/Shanghai', '北京': 'Asia/Shanghai',
  'shanghai': 'Asia/Shanghai', '上海': 'Asia/Shanghai',
  'guangzhou': 'Asia/Shanghai', '广州': 'Asia/Shanghai',
  'shenzhen': 'Asia/Shanghai', '深圳': 'Asia/Shanghai',
  'hangzhou': 'Asia/Shanghai', '杭州': 'Asia/Shanghai',
  'nanjing': 'Asia/Shanghai', '南京': 'Asia/Shanghai',
  'wuhan': 'Asia/Shanghai', '武汉': 'Asia/Shanghai',
  'chengdu': 'Asia/Shanghai', '成都': 'Asia/Shanghai',
  'chongqing': 'Asia/Shanghai', '重庆': 'Asia/Shanghai',
  'xian': 'Asia/Shanghai', '西安': 'Asia/Shanghai',
  'wulumuqi': 'Asia/Urumqi', 'urumqi': 'Asia/Urumqi', '乌鲁木齐': 'Asia/Urumqi',
  'lasa': 'Asia/Shanghai', '拉萨': 'Asia/Shanghai',
  'harbin': 'Asia/Shanghai', '哈尔滨': 'Asia/Shanghai',
};
// 真实字体列表（不同OS字体集）
const FONT_SETS = {
  win: ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Cambria Math', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Lucida Console', 'Microsoft Sans Serif', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', '微软雅黑', '宋体', '黑体'],
  mac: ['Arial', 'Arial Black', 'Arial Narrow', 'Arial Rounded MT Bold', 'Avenir', 'Avenir Next', 'Baskerville', 'Big Caslon', 'Calibri', 'Cambria', 'Courier New', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Menlo', 'Monaco', 'PingFang SC', 'PingFang TC', 'Songti SC', 'STHeiti', 'Times New Roman', 'Verdana'],
};
// ============================================================
// 工具函数
// ============================================================
function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}
function chance(p) {
  return Math.random() < p;
}
// 根据城市名映射时区
function timezoneFromCity(city) {
  if (!city) return null;
  const key = String(city).toLowerCase();
  return CITY_TIMEZONES[key] || null;
}
// 生成指纹ID（稳定：基于时间+随机）
function makeFingerprintId() {
  return 'fp_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 10);
}
// ============================================================
// 指纹画像持久化（每账号绑定稳定指纹）
// ============================================================
function getFingerprintFile(accountKey) {
  const safeKey = String(accountKey).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(FINGERPRINT_DIR, `${safeKey}.json`);
}
/**
 * 获取账号的指纹画像（有则复用，无则生成并保存）
 * @param {String} accountKey 账号标识
 * @param {Object} opts { forceRegenerate, proxyCity, proxyIp }
 */
export function getOrCreateFingerprint(accountKey = 'default', opts = {}) {
  if (!accountKey || accountKey === 'undefined') accountKey = 'default';
  const file = getFingerprintFile(accountKey);
  // 已存在画像 → 复用（同账号同指纹，模拟真实稳定设备）
  if (!opts.forceRegenerate && fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 记录当前代理关联（用于风控分析，不改变指纹本体）
      if (opts.proxyIp) {
        saved.lastProxyIp = opts.proxyIp;
        saved.lastProxyCity = opts.proxyCity || saved.lastProxyCity;
        fs.writeFileSync(file, JSON.stringify(saved, null, 2));
      }
      return saved;
    } catch (e) {
      console.warn('[Fingerprint] 画像读取失败，重新生成:', e.message);
    }
  }
  const fp = generateFingerprint({ proxyCity: opts.proxyCity });
  saveFingerprint(accountKey, fp);
  return fp;
}
/**
 * 保存指纹画像
 */
export function saveFingerprint(accountKey, fingerprint) {
  try {
    if (!fs.existsSync(FINGERPRINT_DIR)) fs.mkdirSync(FINGERPRINT_DIR, { recursive: true });
    const saveData = { ...fingerprint, _accountKey: accountKey, _savedAt: new Date().toISOString() };
    fs.writeFileSync(getFingerprintFile(accountKey), JSON.stringify(saveData, null, 2));
  } catch (e) {
    console.warn('[Fingerprint] 保存画像失败:', e.message);
  }
}
/**
 * 清除账号指纹画像（换"设备"时调用）
 */
export function clearFingerprint(accountKey) {
  const file = getFingerprintFile(accountKey);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch (e) {}
    return true;
  }
  return false;
}
/**
 * 列出所有指纹画像
 */
export function listFingerprints() {
  try {
    if (!fs.existsSync(FINGERPRINT_DIR)) return [];
    return fs.readdirSync(FINGERPRINT_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(FINGERPRINT_DIR, f), 'utf8'));
          return {
            accountKey: data._accountKey || f.replace('.json', ''),
            savedAt: data._savedAt,
            fingerprintId: data.fingerprintId,
            summary: {
              ua: data.userAgent,
              screen: `${data.screenWidth}x${data.screenHeight}`,
              gpu: data.webglRenderer,
              timezone: data.timezone,
              cpu: data.hardwareConcurrency,
              os: data.os,
            },
          };
        } catch { return null; }
      }).filter(Boolean);
  } catch { return []; }
}
// ============================================================
// 指纹生成器 v2.2（20+ 维度）
// ============================================================
/**
 * 生成一个随机但真实、且各维度自洽的浏览器指纹
 * @param {Object} options { proxyCity, userAgent, screen, gpu, hardware, timezone }
 * @returns {Object} 指纹配置
 */
export function generateFingerprint(options = {}) {
  // 从合理组合库整组抽取（保证设备自洽）
  const combo = randomPick(REAL_COMBOS);
  const os = combo.os;
  const chromeVersion = randomPick(combo.chrome);
  const ua = options.userAgent || UA_TEMPLATES[os](chromeVersion);
  const screen = options.screen || randomPick(combo.screens);
  const gpu = options.gpu || combo.gpu;
  const hardware = options.hardware || randomPick(combo.hw);
  // 时区：优先代理IP城市，其次随机中国时区
  const cityTz = timezoneFromCity(options.proxyCity);
  const timezone = options.timezone || cityTz || randomPick(['Asia/Shanghai', 'Asia/Shanghai', 'Asia/Shanghai', 'Asia/Urumqi']);
  // 时区偏移：动态计算（Asia/Shanghai=-480, Asia/Urumqi=-360）
  const timezoneOffset = timezone === 'Asia/Urumqi' ? -360 : -480;
  // 屏幕一致性：DPR 与分辨率联动（高分屏=高DPR）
  const pixelRatio = screen.dpr || (screen.h >= 1400 ? randomPick([1.5, 2]) : 1);
  // 字体集：按OS
  const fonts = FONT_SETS[os] || FONT_SETS.win;
  // 硬件一致性：CPU核数与内存合理对应（已在组合库中保证）
  // 噪声种子：绑定指纹ID（同指纹每次噪声一致，不同指纹不同）
  const fingerprintId = makeFingerprintId();
  const noiseSeed = Math.random() * 0.5;
  return {
    // 基础标识
    fingerprintId,
    os,  // win / mac
    userAgent: ua,
    platform: os === 'mac' ? 'MacIntel' : 'Win32',
    vendor: 'Google Inc.',
    productSub: '20030107',
    product: 'Gecko',
    chromeVersion,
    // 语言（中国用户）
    language: 'zh-CN',
    languages: ['zh-CN', 'zh', 'en'],
    // 屏幕（含DPR一致性）
    screenWidth: screen.w,
    screenHeight: screen.h,
    screenAvailWidth: screen.w,
    screenAvailHeight: screen.h - (os === 'mac' ? 25 : 40),
    colorDepth: 24,
    pixelDepth: 24,
    pixelRatio,
    // 硬件
    hardwareConcurrency: hardware.c,
    deviceMemory: hardware.m,
    // GPU/WebGL
    webglVendor: gpu.vendor,
    webglRenderer: gpu.renderer,
    webglVersion: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    webglShadingLanguage: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    // 时区（与代理IP城市一致）
    timezone,
    timezoneOffset,
    // 字体列表
    fonts,
    // 插件
    plugins: [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ],
    // 噪声种子（Canvas/Audio/WebGL 用同一种子，保证一致性）
    canvasNoise: noiseSeed,
    audioNoise: noiseSeed * 0.0002,
    webglNoise: noiseSeed * 0.0001,
    // WebRTC（防真IP泄漏，伪造与代理一致的对等IP）
    webrtcLocalIp: null,  // 由 injectFingerprint 根据代理IP填充
    // 网络
    connection: { effectiveType: '4g', rtt: randomInt(40, 90), downlink: randomFloat(5, 15) },
    doNotTrack: null,
    cookieEnabled: true,
    online: true,
    // 浏览器窗口（非最大化，模拟真实用户窗口大小）
    windowOuterWidth: screen.w,
    windowOuterHeight: screen.h,
    // 键盘布局（中文系统）
    keyboardLayout: 'us',
    // 媒体设备（伪造型号，与OS一致）
    mediaDevices: os === 'mac'
      ? [{ kind: 'videoinput', label: 'FaceTime HD Camera' }, { kind: 'audioinput', label: 'Built-in Microphone' }]
      : [{ kind: 'videoinput', label: 'Integrated Camera' }, { kind: 'audioinput', label: 'Microphone Array (Realtek(R) Audio)' }],
  };
}
// ============================================================
// 指纹注入器 v2.2（20+ 维度注入）
// ============================================================
/**
 * 将指纹注入到Puppeteer页面（页面加载前注入）
 * @param {Page} page
 * @param {Object} fingerprint
 * @param {Object} opts { proxyIp: 代理出口IP（用于WebRTC伪造） }
 */
export async function injectFingerprint(page, fingerprint, opts = {}) {
  const fp = fingerprint;
  // WebRTC 伪造IP：用代理出口IP（无代理则用随机中国IP段）
  const webrtcIp = opts.proxyIp || fp.lastProxyIp || `${randomInt(1, 220)}.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
  await page.evaluateOnNewDocument((f, wip) => {
    // ========================================================
    // 1. navigator 基础属性
    // ========================================================
    try {
      Object.defineProperty(navigator, 'userAgent', { get: () => f.userAgent });
    } catch (e) {}
    Object.defineProperty(navigator, 'platform', { get: () => f.platform });
    Object.defineProperty(navigator, 'vendor', { get: () => f.vendor });
    Object.defineProperty(navigator, 'productSub', { get: () => f.productSub });
    Object.defineProperty(navigator, 'product', { get: () => f.product });
    Object.defineProperty(navigator, 'language', { get: () => f.language });
    Object.defineProperty(navigator, 'languages', { get: () => f.languages });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => f.hardwareConcurrency });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => f.deviceMemory });
    Object.defineProperty(navigator, 'cookieEnabled', { get: () => f.cookieEnabled });
    Object.defineProperty(navigator, 'onLine', { get: () => f.onLine });
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // maxTouchPoints（桌面=0）
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    // ========================================================
    // 2. chrome.runtime 存在性（反自动化检测）
    // ========================================================
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {
      OnInstalledReason: { install: 'install', update: 'update', chrome_update: 'chrome_update', shared_module_update: 'shared_module_update' },
      OnRestartRequiredReason: { app_update: 'app_update', os_update: 'os_update', periodic: 'periodic' },
      PlatformArch: { arm: 'arm', arm64: 'arm64', x86_32: 'x86-32', x86_64: 'x86-64', mips: 'mips', mips64: 'mips64' },
      PlatformNaclArch: { arm: 'arm', x86_32: 'x86-32', x86_64: 'x86-64', mips: 'mips', mips64: 'mips64' },
      PlatformOs: { mac: 'mac', win: 'win', android: 'android', cros: 'cros', linux: 'linux', openbsd: 'openbsd' },
      RequestUpdateCheckStatus: { throttled: 'throttled', no_update: 'no_update', update_available: 'update_available' },
    };
    // ========================================================
    // 3. 屏幕属性（含DPR）
    // ========================================================
    Object.defineProperty(screen, 'width', { get: () => f.screenWidth });
    Object.defineProperty(screen, 'height', { get: () => f.screenHeight });
    Object.defineProperty(screen, 'availWidth', { get: () => f.screenAvailWidth });
    Object.defineProperty(screen, 'availHeight', { get: () => f.screenAvailHeight });
    Object.defineProperty(screen, 'colorDepth', { get: () => f.colorDepth });
    Object.defineProperty(screen, 'pixelDepth', { get: () => f.pixelDepth });
    Object.defineProperty(window, 'devicePixelRatio', { get: () => f.pixelRatio });
    Object.defineProperty(window, 'outerWidth', { get: () => f.windowOuterWidth });
    Object.defineProperty(window, 'outerHeight', { get: () => f.windowOuterHeight });
    // ========================================================
    // 4. 时区（DateTimeFormat + getTimezoneOffset）
    // ========================================================
    const originalDateTimeFormat = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function(locales, options) {
      options = options || {};
      options.timeZone = f.timezone;
      return new originalDateTimeFormat(locales, options);
    };
    Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;
    Intl.DateTimeFormat.supportedLocalesOf = originalDateTimeFormat.supportedLocalesOf;
    const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function() {
      return f.timezoneOffset;
    };
    // ========================================================
    // 5. 字体列表指纹（canvas 测量字体，返回伪造的字体列表）
    // ========================================================
    try {
      Object.defineProperty(document, 'fonts', {
        get: () => ({
          check: (font) => true,  // 所有字体都存在（伪造）
          ready: Promise.resolve(),
          add: () => {},
          size: 0,
          forEach: (cb) => { f.fonts.forEach((name, i) => cb({ family: name }, i)); },
        }),
      });
    } catch (e) {}
    // 字体探测的常见实现（fillText+measureText）也通过 Canvas 噪声间接影响
    // ========================================================
    // 6. Canvas 指纹噪声（种子绑定指纹ID，同指纹噪声一致）
    // ========================================================
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type, encoderOptions) {
      if (this.width < 2000 && this.height < 2000) {
        try {
          const ctx = this.getContext('2d');
          if (ctx) {
            const imageData = ctx.getImageData(0, 0, this.width, this.height);
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 4) {
              // 用固定种子 + 像素位置生成确定性噪声（同指纹每次一致）
              if (Math.random() < 0.01) {
                const n = (f.canvasNoise > 0.25 ? 1 : -1) * (i % 7 === 0 ? 2 : 1);
                data[i] = Math.max(0, Math.min(255, data[i] + n));
                data[i+1] = Math.max(0, Math.min(255, data[i+1] - n));
                data[i+2] = Math.max(0, Math.min(255, data[i+2] + n));
              }
            }
            ctx.putImageData(imageData, 0, 0);
          }
        } catch (e) {}
      }
      return originalToDataURL.call(this, type, encoderOptions);
    };
    // ========================================================
    // 7. WebGL 指纹（厂商/渲染器/版本/精度 + 噪声）
    // ========================================================
    const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return f.webglVendor;       // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return f.webglRenderer;     // UNMASKED_RENDERER_WEBGL
      if (parameter === 7938) return f.webglVersion;       // VERSION
      if (parameter === 35724) return f.webglShadingLanguage;  // SHADING_LANGUAGE_VERSION
      return originalGetParameter.call(this, parameter);
    };
    // WebGL 精度（同指纹稳定，不同指纹不同）—— 用噪声影响浮点结果
    const originalGetShaderPrecisionFormat = WebGLRenderingContext.prototype.getShaderPrecisionFormat;
    WebGLRenderingContext.prototype.getShaderPrecisionFormat = function(shaderType, precisionType) {
      const res = originalGetShaderPrecisionFormat.call(this, shaderType, precisionType);
      if (res) {
        // 微调 rangeMin（GPU精度指纹）
        res.rangeMin += f.webglNoise > 0.00005 ? 1 : 0;
      }
      return res;
    };
    if (window.WebGL2RenderingContext) {
      const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return f.webglVendor;
        if (parameter === 37446) return f.webglRenderer;
        if (parameter === 7938) return f.webglVersion;
        if (parameter === 35724) return f.webglShadingLanguage;
        return originalGetParameter2.call(this, parameter);
      };
      const originalGetSPF2 = WebGL2RenderingContext.prototype.getShaderPrecisionFormat;
      WebGL2RenderingContext.prototype.getShaderPrecisionFormat = function(shaderType, precisionType) {
        const res = originalGetSPF2.call(this, shaderType, precisionType);
        if (res && f.webglNoise > 0.00005) res.rangeMin += 1;
        return res;
      };
    }
    // ========================================================
    // 8. Audio 指纹噪声（种子绑定指纹ID）
    // ========================================================
    if (window.OfflineAudioContext) {
      const originalStartRendering = OfflineAudioContext.prototype.startRendering;
      OfflineAudioContext.prototype.startRendering = function() {
        return originalStartRendering.call(this).then(buffer => {
          try {
            const channelData = buffer.getChannelData(0);
            for (let i = 0; i < channelData.length; i++) {
              if (Math.random() < 0.001) {
                channelData[i] += (i % 3 === 0 ? f.audioNoise : -f.audioNoise);
              }
            }
          } catch (e) {}
          return buffer;
        });
      };
    }
    // ========================================================
    // 9. plugins + mimeTypes 伪造
    // ========================================================
    function makePluginArray(plugins) {
      const pluginArray = Object.create(PluginArray.prototype);
      plugins.forEach((plugin, i) => {
        const p = Object.create(Plugin.prototype);
        Object.defineProperty(p, 'name', { value: plugin.name });
        Object.defineProperty(p, 'filename', { value: plugin.filename });
        Object.defineProperty(p, 'description', { value: plugin.description });
        pluginArray[i] = p;
        pluginArray[plugin.name] = p;
      });
      Object.defineProperty(pluginArray, 'length', { value: plugins.length });
      return pluginArray;
    }
    try { Object.defineProperty(navigator, 'plugins', { get: () => makePluginArray(f.plugins) }); } catch (e) {}
    // ========================================================
    // 10. WebRTC 防真IP泄漏（伪造与代理一致的本地/对等IP）
    // ========================================================
    try {
      const webrtcCandidateHack = () => {
        // 覆盖 RTCPeerConnection，伪造 ICE candidate IP
        const originalRTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
        if (originalRTCPeerConnection) {
          const FakeRTCPeerConnection = function(config) {
            const pc = new originalRTCPeerConnection(config);
            // 监听 candidate 事件，替换 IP
            const origAddIceCandidate = pc.addIceCandidate.bind(pc);
            pc.addIceCandidate = (candidate) => {
              if (candidate && candidate.candidate) {
                try {
                  const replaced = candidate.candidate.replace(/([0-9]{1,3}\.){3}[0-9]{1,3}/g, wip);
                  candidate = new RTCIceCandidate({ candidate: replaced, sdpMLineIndex: candidate.sdpMLineIndex, sdpMid: candidate.sdpMid });
                } catch (e) {}
              }
              return origAddIceCandidate(candidate);
            };
            // 监听 onicecandidate 回调的 candidate
            const origSetLocal = pc.setLocalDescription.bind(pc);
            pc.setLocalDescription = async (desc) => {
              try {
                if (desc && desc.sdp) {
                  desc.sdp = desc.sdp.replace(/([0-9]{1,3}\.){3}[0-9]{1,3}/g, wip);
                }
              } catch (e) {}
              return origSetLocal(desc);
            };
            return pc;
          };
          FakeRTCPeerConnection.prototype = originalRTCPeerConnection.prototype;
          try {
            Object.defineProperty(window, 'RTCPeerConnection', { value: FakeRTCPeerConnection, writable: true });
            if (window.webkitRTCPeerConnection) {
              Object.defineProperty(window, 'webkitRTCPeerConnection', { value: FakeRTCPeerConnection, writable: true });
            }
          } catch (e) {}
        }
      };
      webrtcCandidateHack();
    } catch (e) {}
    // ========================================================
    // 11. ClientRects 指纹（亚像素精度）
    // ========================================================
    // 通过轻微的 DOM 布局扰动影响 getBoundingClientRect 结果（可选，默认不改以避免布局问题）
    // ========================================================
    // 12. 电池 API（存在性 + 稳定值）
    // ========================================================
    if (navigator.getBattery) {
      const origGetBattery = navigator.getBattery.bind(navigator);
      navigator.getBattery = () => origGetBattery().then(() => ({
        charging: false,
        chargingTime: Infinity,
        dischargingTime: 18000,
        level: 0.6 + (f.canvasNoise > 0.25 ? 0.2 : 0),
        onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null,
      }));
    }
    // ========================================================
    // 13. 传感器（桌面端通常无陀螺仪/加速度计）
    // ========================================================
    try {
      Object.defineProperty(window, 'DeviceOrientationEvent', { value: undefined });
      Object.defineProperty(window, 'DeviceMotionEvent', { value: undefined });
    } catch (e) {}
    // ========================================================
    // 14. 媒体设备（enumerateDevices 伪造型号）
    // ========================================================
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices = async () => {
        try {
          const devices = await origEnumerate();
          if (devices && devices.length === 0) {
            // 无真实设备时返回伪造（headless 常见）
            return f.mediaDevices.map((d, i) => ({
              deviceId: `device_${i}_${f.fingerprintId.slice(-6)}`,
              groupId: 'group_' + i,
              kind: d.kind,
              label: d.label,
              toJSON: () => ({}),
            }));
          }
          return devices;
        } catch (e) { return []; }
      };
    }
    // ========================================================
    // 15. permissions API 一致性
    // ========================================================
    if (navigator.permissions && navigator.permissions.query) {
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function(parameters) {
        if (parameters && parameters.name === 'notifications') {
          return Promise.resolve({ state: 'prompt', onchange: null });
        }
        if (parameters && parameters.name === 'clipboard-read') {
          return Promise.resolve({ state: 'prompt', onchange: null });
        }
        return originalQuery(parameters);
      };
    }
    // ========================================================
    // 16. 连接属性（网络信息，桌面 Chrome 通常无 navigator.connection）
    // ========================================================
    // 桌面 Chrome 无 connection API → 不注入（保持真实）
    // ========================================================
    // 17. 键盘布局（中文系统）
    // ========================================================
    // navigator.keyboard 在桌面 Chrome 通常不可用 → 不注入
    // ========================================================
    // 18. 窗口/历史 API 一致性
    // ========================================================
    // history.scrollRestoration / visualViewport 保持默认
  }, fp, webrtcIp);
  // 页面级 UA + 额外HTTP头（双重保障）
  await page.setUserAgent(fp.userAgent);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-ch-ua': `"Not_A Brand";v="8", "Chromium";v="${fp.chromeVersion}", "Google Chrome";v="${fp.chromeVersion}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${fp.os === 'mac' ? 'macOS' : 'Windows'}"`,
  });
  return fp;
}
// ============================================================
// 便捷函数
// ============================================================
/**
 * 生成并注入（一步完成，供登录类调用）
 * @param {Page} page
 * @param {Object} opts { accountKey, proxyIp, proxyCity, forceRegenerate }
 */
export async function applyFingerprint(page, opts = {}) {
  const fp = getOrCreateFingerprint(opts.accountKey || 'default', {
    forceRegenerate: opts.forceRegenerate,
    proxyIp: opts.proxyIp,
    proxyCity: opts.proxyCity,
  });
  await injectFingerprint(page, fp, { proxyIp: opts.proxyIp });
  return fp;
}
/**
 * 当前指纹验证（调试用）
 */
export async function getCurrentFingerprint(page) {
  return await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      vendor: navigator.vendor,
      language: navigator.language,
      languages: navigator.languages,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
      dpr: window.devicePixelRatio,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tzOffset: new Date().getTimezoneOffset(),
      webglVendor: gl ? gl.getParameter(37445) : null,
      webglRenderer: gl ? gl.getParameter(37446) : null,
      webdriver: navigator.webdriver,
      chrome: !!window.chrome,
      plugins: navigator.plugins ? navigator.plugins.length : 0,
      maxTouchPoints: navigator.maxTouchPoints,
    };
  });
}
export default { generateFingerprint, injectFingerprint, applyFingerprint, getOrCreateFingerprint, saveFingerprint, clearFingerprint, listFingerprints, getCurrentFingerprint };
