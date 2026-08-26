/**
 * 浏览器指纹随机化工具
 *
 * 参考开源项目：
 * - puppeteer-extra-plugin-stealth (https://github.com/berstend/puppeteer-extra)
 *   17个evasion模块，隐藏自动化特征
 * - fingerprint-suite by Apify (https://github.com/apify/fingerprint-suite)
 *   fingerprint-generator + fingerprint-injector，贝叶斯网络生成真实指纹
 * - CloakBrowser (https://github.com/Robin-zero/CloakBrowser)
 *   源码级指纹补丁思路
 *
 * 本模块实现轻量级指纹随机化，覆盖B站反爬主要检测维度：
 * 1. User-Agent + 相关navigator属性
 * 2. Canvas指纹（像素噪声注入）
 * 3. WebGL指纹（厂商/渲染器随机化）
 * 4. Audio指纹（浮点噪声注入）
 * 5. 屏幕分辨率 + colorDepth
 * 6. 硬件信息（hardwareConcurrency / deviceMemory）
 * 7. 时区（根据代理IP所在中国城市）
 * 8. 语言 + navigator.languages
 * 9. plugins + mimeTypes（伪造Chrome真实插件）
 * 10. navigator.vendor / platform / productSub 等一致性
 */

// ============================================================
// 真实浏览器指纹数据库（从真实设备采集）
// ============================================================

// 真实User-Agent池（Chrome on Windows/Mac，2024-2025版本）
const REAL_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

// 真实屏幕分辨率池（中国用户常见）
const REAL_SCREENS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1200 },
];

// 真实GPU配置池（WebGL厂商+渲染器）
const REAL_GPUS = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB, OpenGL 4.5)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.5)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, OpenGL 4.5)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series, OpenGL 4.5)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650, OpenGL 4.5)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' },
];

// 中国主要城市时区（全部为Asia/Shanghai，但可微调）
const CHINA_TIMEZONES = [
  'Asia/Shanghai',   // 北京时间（标准）
  'Asia/Chongqing',  // 重庆时间（同北京时间）
  'Asia/Harbin',     // 哈尔滨时间（同北京时间）
  'Asia/Urumqi',     // 乌鲁木齐时间（同北京时间，但地理时差2小时）
];

// 硬件配置池
const REAL_HARDWARE = [
  { concurrency: 4, memory: 4 },
  { concurrency: 8, memory: 8 },
  { concurrency: 8, memory: 16 },
  { concurrency: 12, memory: 16 },
  { concurrency: 16, memory: 16 },
  { concurrency: 16, memory: 32 },
  { concurrency: 6, memory: 8 },
  { concurrency: 4, memory: 8 },
];

// Chrome真实插件描述
const CHROME_PLUGINS = [
  { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
  { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
];

// ============================================================
// 工具函数
// ============================================================
function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ============================================================
// 指纹生成器
// ============================================================

/**
 * 生成一个随机但真实的浏览器指纹
 * @param {Object} options - 约束条件
 * @returns {Object} 指纹配置对象
 */
export function generateFingerprint(options = {}) {
  const ua = options.userAgent || randomPick(REAL_USER_AGENTS);
  const isMac = ua.includes('Macintosh');
  const screen = options.screen || randomPick(REAL_SCREENS);
  const gpu = options.gpu || randomPick(REAL_GPUS);
  const hardware = options.hardware || randomPick(REAL_HARDWARE);
  const timezone = options.timezone || randomPick(CHINA_TIMEZONES);

  // 从UA解析Chrome主版本
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const chromeVersion = chromeMatch ? parseInt(chromeMatch[1]) : 120;

  return {
    // 基础标识
    userAgent: ua,
    platform: isMac ? 'MacIntel' : 'Win32',
    vendor: 'Google Inc.',
    productSub: '20030107',
    product: 'Gecko',

    // 语言
    language: 'zh-CN',
    languages: ['zh-CN', 'zh', 'en'],

    // 屏幕
    screenWidth: screen.width,
    screenHeight: screen.height,
    screenAvailWidth: screen.width,
    screenAvailHeight: screen.height - (isMac ? 25 : 40),  // 减去任务栏/菜单栏
    colorDepth: 24,
    pixelRatio: randomPick([1, 1, 1, 1.25, 1.5, 2]),  // 大多数是1

    // 硬件
    hardwareConcurrency: hardware.concurrency,
    deviceMemory: hardware.memory,

    // GPU/WebGL
    webglVendor: gpu.vendor,
    webglRenderer: gpu.renderer,

    // 时区
    timezone: timezone,
    timezoneOffset: -480,  // UTC+8，中国标准时间

    // 插件
    plugins: CHROME_PLUGINS,

    // Canvas噪声种子（每次不同）
    canvasNoise: Math.random() * 0.5,
    audioNoise: Math.random() * 0.0001,

    // Chrome版本一致性
    chromeVersion,

    // 其他
    doNotTrack: null,
    cookieEnabled: true,
    online: true,

    // 生成时间戳（用于指纹唯一性）
    fingerprintId: Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
  };
}

// ============================================================
// 指纹注入器（核心）
// ============================================================

/**
 * 将指纹注入到Puppeteer页面
 * 在页面加载前通过 evaluateOnNewDocument 注入
 *
 * @param {Page} page - Puppeteer页面对象
 * @param {Object} fingerprint - generateFingerprint()生成的指纹
 */
export async function injectFingerprint(page, fingerprint) {
  await page.evaluateOnNewDocument((fp) => {
    // ========================================================
    // 1. navigator 属性覆盖
    // ========================================================
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    if (navigatorDescriptor && navigatorDescriptor.configurable) {
      Object.defineProperty(navigator, 'userAgent', { get: () => fp.userAgent });
    }
    Object.defineProperty(navigator, 'platform', { get: () => fp.platform });
    Object.defineProperty(navigator, 'vendor', { get: () => fp.vendor });
    Object.defineProperty(navigator, 'productSub', { get: () => fp.productSub });
    Object.defineProperty(navigator, 'product', { get: () => fp.product });
    Object.defineProperty(navigator, 'language', { get: () => fp.language });
    Object.defineProperty(navigator, 'languages', { get: () => fp.languages });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => fp.hardwareConcurrency });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => fp.deviceMemory });
    Object.defineProperty(navigator, 'cookieEnabled', { get: () => fp.cookieEnabled });
    Object.defineProperty(navigator, 'onLine', { get: () => fp.online });

    // 隐藏webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // chrome.runtime（Chrome扩展API存在性检测）
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
    // 2. 屏幕属性覆盖
    // ========================================================
    Object.defineProperty(screen, 'width', { get: () => fp.screenWidth });
    Object.defineProperty(screen, 'height', { get: () => fp.screenHeight });
    Object.defineProperty(screen, 'availWidth', { get: () => fp.screenAvailWidth });
    Object.defineProperty(screen, 'availHeight', { get: () => fp.screenAvailHeight });
    Object.defineProperty(screen, 'colorDepth', { get: () => fp.colorDepth });
    Object.defineProperty(screen, 'pixelDepth', { get: () => fp.colorDepth });

    // window.innerWidth/innerHeight 一致性（视口大小）
    // 注意：这两个由视口决定，不强制覆盖，避免布局异常

    // ========================================================
    // 3. 时区覆盖
    // ========================================================
    const originalDateTimeFormat = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function(locales, options) {
      options = options || {};
      options.timeZone = fp.timezone;
      return new originalDateTimeFormat(locales, options);
    };
    Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;
    Intl.DateTimeFormat.supportedLocalesOf = originalDateTimeFormat.supportedLocalesOf;

    // Date.prototype.getTimezoneOffset 覆盖
    const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function() {
      return fp.timezoneOffset;
    };

    // ========================================================
    // 4. Canvas指纹噪声注入
    // 参考：puppeteer-extra-plugin-stealth 的 canvas.fingerprint evasion
    // 在 toDataURL 和 getImageData 中添加微小像素噪声
    // ========================================================
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type, encoderOptions) {
      // 只对小尺寸canvas添加噪声（大canvas添加噪声性能差且易被检测）
      if (this.width < 2000 && this.height < 2000) {
        try {
          const ctx = this.getContext('2d');
          if (ctx) {
            const imageData = ctx.getImageData(0, 0, this.width, this.height);
            const data = imageData.data;
            // 添加微小噪声（±1-2像素值，人眼不可见但改变指纹哈希）
            for (let i = 0; i < data.length; i += 4) {
              if (Math.random() < 0.01) {  // 1%的像素添加噪声
                data[i] = Math.max(0, Math.min(255, data[i] + (Math.random() < 0.5 ? -1 : 1) * fp.canvasNoise));
                data[i+1] = Math.max(0, Math.min(255, data[i+1] + (Math.random() < 0.5 ? -1 : 1) * fp.canvasNoise));
                data[i+2] = Math.max(0, Math.min(255, data[i+2] + (Math.random() < 0.5 ? -1 : 1) * fp.canvasNoise));
              }
            }
            ctx.putImageData(imageData, 0, 0);
          }
        } catch (e) { /* 忽略跨域canvas错误 */ }
      }
      return originalToDataURL.call(this, type, encoderOptions);
    };

    // ========================================================
    // 5. WebGL指纹覆盖
    // 参考：puppeteer-extra-plugin-stealth 的 webgl.vendor evasion
    // ========================================================
    const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      // UNMASKED_VENDOR_WEBGL = 37445
      if (parameter === 37445) return fp.webglVendor;
      // UNMASKED_RENDERER_WEBGL = 37446
      if (parameter === 37446) return fp.webglRenderer;
      // VERSION = 7938
      if (parameter === 7938) return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
      // SHADING_LANGUAGE_VERSION = 35724
      if (parameter === 35724) return 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
      return originalGetParameter.call(this, parameter);
    };

    // WebGL2 同样处理
    if (window.WebGL2RenderingContext) {
      const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return fp.webglVendor;
        if (parameter === 37446) return fp.webglRenderer;
        return originalGetParameter2.call(this, parameter);
      };
    }

    // ========================================================
    // 6. Audio指纹噪声注入
    // 参考：puppeteer-extra-plugin-stealth 的 audio.fingerprint evasion
    // ========================================================
    if (window.OfflineAudioContext) {
      const originalStartRendering = OfflineAudioContext.prototype.startRendering;
      OfflineAudioContext.prototype.startRendering = function() {
        return originalStartRendering.call(this).then(buffer => {
          try {
            const channelData = buffer.getChannelData(0);
            // 添加微小浮点噪声
            for (let i = 0; i < channelData.length; i++) {
              if (Math.random() < 0.001) {
                channelData[i] += (Math.random() - 0.5) * fp.audioNoise;
              }
            }
          } catch (e) {}
          return buffer;
        });
      };
    }

    // ========================================================
    // 7. plugins + mimeTypes 伪造
    // 参考：puppeteer-extra-plugin-stealth 的 plugins.iframe evasion
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

    try {
      Object.defineProperty(navigator, 'plugins', {
        get: () => makePluginArray(fp.plugins),
      });
    } catch (e) {}

    // ========================================================
    // 8. permissions API 一致性
    // ========================================================
    if (navigator.permissions && navigator.permissions.query) {
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function(parameters) {
        if (parameters && parameters.name === 'notifications') {
          return Promise.resolve({ state: 'prompt', onchange: null });
        }
        return originalQuery(parameters);
      };
    }

    // ========================================================
    // 9. 连接属性（网络信息）
    // ========================================================
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
      Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
      Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 });
    }

    // ========================================================
    // 10. 窗口属性一致性
    // ========================================================
    // outerWidth/outerHeight 与 screen 一致
    Object.defineProperty(window, 'outerWidth', { get: () => fp.screenWidth });
    Object.defineProperty(window, 'outerHeight', { get: () => fp.screenHeight });

    // devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', { get: () => fp.pixelRatio });

  }, fingerprint);

  // 设置页面级UA（双重保障）
  await page.setUserAgent(fingerprint.userAgent);

  // 设置额外HTTP头（语言等）
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-ch-ua': `"Not_A Brand";v="8", "Chromium";v="${fingerprint.chromeVersion}", "Google Chrome";v="${fingerprint.chromeVersion}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${fingerprint.platform === 'MacIntel' ? 'macOS' : 'Windows'}"`,
  });

  return fingerprint;
}

// ============================================================
// 便捷函数：生成并注入（一步完成）
// ============================================================
export async function applyRandomFingerprint(page, options = {}) {
  const fingerprint = generateFingerprint(options);
  await injectFingerprint(page, fingerprint);
  return fingerprint;
}

// ============================================================
// 指纹验证：检测当前页面的指纹信息（用于调试）
// ============================================================
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
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      webglVendor: gl ? gl.getParameter(37445) : null,
      webglRenderer: gl ? gl.getParameter(37446) : null,
      webdriver: navigator.webdriver,
      chrome: !!window.chrome,
      plugins: navigator.plugins ? navigator.plugins.length : 0,
    };
  });
}

export default { generateFingerprint, injectFingerprint, applyRandomFingerprint, getCurrentFingerprint };
