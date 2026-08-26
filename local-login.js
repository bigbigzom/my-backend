#!/usr/bin/env node
/**
 * B站本地登录工具（命令行交互式）
 *
 * ════════════════════════════════════════════════════════════
 *  使用方法：
 *    node local-login.js                    # 交互式菜单
 *    node local-login.js --phone 138xxxx    # 手机号验证码登录
 *    node local-login.js --account xxx --pass xxx  # 账号密码登录
 *    node local-login.js --smart --phone 138xxxx --account xxx --pass xxx  # 智能登录
 *    node local-login.js --list             # 列出本地信任设备
 *    node local-login.js --clear <账号>     # 清除指定信任设备
 *    node local-login.js --backend https://xxx.onrender.com  # 指定后端地址
 *    node local-login.js --no-proxy        # 禁用中国IP代理（默认开启）
 *    node local-login.js --no-fingerprint  # 禁用浏览器指纹随机化（默认开启）
 * ════════════════════════════════════════════════════════════
 *
 *  信任设备逻辑：
 *  - 首次登录必须用手机号+验证码，建立信任设备（保存在 .trusted-devices/）
 *  - 后续同一账号可用账号密码登录（无需短信验证）
 *  - 信任设备失效时自动回退到手机号验证码模式
 *  - 登录成功后Cookie自动上传到Render后端保存
 */
import { BilibiliLogin } from './src/accounts/bilibili-login.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TRUSTED_DEVICE_DIR = path.join(__dirname, '.trusted-devices');
const CONFIG_FILE = path.join(__dirname, '.login-config.json');

// 命令行参数解析
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf('--' + name);
  return idx >= 0 ? args[idx + 1] : null;
}
const hasFlag = (name) => args.includes('--' + name);

// 配置加载/保存
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {}
  return { backendUrl: '', accounts: [] };
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// 交互式输入
function question(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, answer => { rl.close(); resolve(answer.trim()); }));
}

// 列出信任设备
function listTrustedDevices() {
  console.log('\n📱 本地信任设备列表:');
  console.log('═══════════════════════════════════════');
  if (!fs.existsSync(TRUSTED_DEVICE_DIR)) {
    console.log('  (暂无信任设备)');
    return;
  }
  const dirs = fs.readdirSync(TRUSTED_DEVICE_DIR).filter(d => fs.statSync(path.join(TRUSTED_DEVICE_DIR, d)).isDirectory());
  if (dirs.length === 0) {
    console.log('  (暂无信任设备)');
    return;
  }
  dirs.forEach((d, i) => {
    const stat = fs.statSync(path.join(TRUSTED_DEVICE_DIR, d));
    console.log(`  ${i+1}. ${d}  (最后修改: ${stat.mtime.toLocaleString()})`);
  });
  console.log(`═══════════════════════════════════════`);
  console.log(`共 ${dirs.length} 个信任设备\n`);
}

// 清除信任设备
function clearTrustedDevice(accountKey) {
  const dir = path.join(TRUSTED_DEVICE_DIR, String(accountKey).replace(/[^a-zA-Z0-9]/g, '_'));
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`✅ 已清除信任设备: ${accountKey}`);
  } else {
    console.log(`❌ 未找到信任设备: ${accountKey}`);
  }
}

// 执行登录
async function doLogin(options) {
  const { mode, phone, account, password, backendUrl, headless, useProxy, useFingerprint } = options;
  const login = new BilibiliLogin({
    headless: headless !== 'true',
    backendUrl,
    useProxy: useProxy !== false,        // 默认开启代理
    useFingerprint: useFingerprint !== false,  // 默认开启指纹随机化
  });

  console.log('\n' + '═'.repeat(50));
  console.log('🚀 B站本地登录工具');
  console.log('═'.repeat(50));
  console.log(`登录模式: ${mode === 'phone' ? '手机号+验证码（建立信任设备）' : mode === 'password' ? '账号密码（信任设备）' : '智能登录（自动选择）'}`);
  console.log(`后端地址: ${backendUrl || '(未配置，Cookie仅本地保存)'}`);
  console.log(`浏览器模式: ${headless === 'true' ? '无头（后台）' : '有头（可见窗口）'}`);
  console.log(`中国IP代理: ${useProxy !== false ? '✅ 开启（每次登录随机选IP）' : '❌ 禁用'}`);
  console.log(`指纹随机化: ${useFingerprint !== false ? '✅ 开启（Canvas/WebGL/Audio/屏幕/硬件/时区）' : '❌ 禁用'}`);
  console.log('═'.repeat(50) + '\n');

  let result;
  if (mode === 'phone') {
    result = await login.loginByPhoneCode(phone, {
      onCodeRequired: (p) => console.log(`\n📱 请在弹出的浏览器中输入短信验证码（手机号: ${p}）\n`),
      onCaptchaRequired: () => console.log(`\n🧩 请在弹出的浏览器中完成滑块验证\n`),
    });
  } else if (mode === 'password') {
    result = await login.loginByPassword(account, password);
  } else {
    result = await login.smartLogin({ phone, account, password });
  }

  await login.close();

  console.log('\n' + '═'.repeat(50));
  if (result.success) {
    console.log('✅ 登录成功！');
    console.log(`  UID: ${result.account.username}`);
    console.log(`  登录模式: ${result.loginMode}`);
    console.log(`  CSRF: ${result.account.csrf.substring(0, 16)}...`);
    console.log(`  Cookie上传后端: ${result.upload?.uploaded ? '✅ 成功' : '⚠️ 跳过/失败'}`);
    if (result.loginMode === 'phone_code') {
      console.log(`  🔐 信任设备已建立，后续可用账号密码登录（无需短信验证）`);
    }
    // 保存到配置
    const cfg = loadConfig();
    cfg.backendUrl = backendUrl || cfg.backendUrl;
    const existing = cfg.accounts.find(a => a.username === result.account.username);
    if (existing) {
      existing.phone = result.account.phone || existing.phone;
      existing.account = result.account.account || existing.account;
      existing.lastLogin = new Date().toISOString();
    } else {
      cfg.accounts.push({
        username: result.account.username,
        phone: result.account.phone,
        account: result.account.account,
        lastLogin: new Date().toISOString(),
      });
    }
    saveConfig(cfg);
  } else {
    console.log('❌ 登录失败');
    console.log(`  原因: ${result.error}`);
    if (result.trustFailed) {
      console.log(`  💡 建议: 使用手机号验证码模式重新建立信任设备`);
    }
  }
  console.log('═'.repeat(50) + '\n');

  return result;
}

// 交互式菜单
async function interactiveMenu() {
  const cfg = loadConfig();
  console.log('\n' + '═'.repeat(50));
  console.log('🚀 B站本地登录工具 - 交互式菜单');
  console.log('═'.repeat(50));
  console.log('1. 手机号+验证码登录（首次登录/建立信任设备）');
  console.log('2. 账号密码登录（需已有信任设备）');
  console.log('3. 智能登录（自动选择最佳模式）');
  console.log('4. 查看本地信任设备列表');
  console.log('5. 清除指定信任设备');
  console.log('6. 设置/修改后端地址（Render）');
  console.log('0. 退出');
  console.log('═'.repeat(50));

  const choice = await question('请选择操作 [0-6]: ');

  switch (choice) {
    case '1': {
      const phone = await question('请输入手机号: ');
      if (!/^1[3-9]\d{9}$/.test(phone)) { console.log('❌ 手机号格式错误'); break; }
      const backend = await question(`后端地址 [${cfg.backendUrl || '留空仅本地保存'}]: `) || cfg.backendUrl;
      await doLogin({ mode: 'phone', phone, backendUrl: backend });
      break;
    }
    case '2': {
      const account = await question('请输入账号（手机号/邮箱/UID）: ');
      const password = await question('请输入密码: ');
      const backend = await question(`后端地址 [${cfg.backendUrl || '留空仅本地保存'}]: `) || cfg.backendUrl;
      await doLogin({ mode: 'password', account, password, backendUrl: backend });
      break;
    }
    case '3': {
      const phone = await question('手机号（用于回退）: ');
      const account = await question('账号: ');
      const password = await question('密码: ');
      const backend = await question(`后端地址 [${cfg.backendUrl || '留空仅本地保存'}]: `) || cfg.backendUrl;
      await doLogin({ mode: 'smart', phone, account, password, backendUrl: backend });
      break;
    }
    case '4':
      listTrustedDevices();
      break;
    case '5': {
      const key = await question('请输入要清除的账号标识: ');
      clearTrustedDevice(key);
      break;
    }
    case '6': {
      const url = await question(`请输入Render后端地址 [${cfg.backendUrl || '当前未设置'}]: `);
      if (url) { cfg.backendUrl = url; saveConfig(cfg); console.log('✅ 后端地址已保存'); }
      break;
    }
    case '0':
      console.log('👋 再见！');
      process.exit(0);
    default:
      console.log('❌ 无效选择');
  }
}

// ============================================================
// 主入口
// ============================================================
async function main() {
  // 列出设备
  if (hasFlag('list')) { listTrustedDevices(); return; }
  // 清除设备
  if (hasFlag('clear')) { clearTrustedDevice(getArg('clear')); return; }
  // 命令行直接登录
  if (getArg('phone') && !getArg('account')) {
    await doLogin({
      mode: 'phone',
      phone: getArg('phone'),
      backendUrl: getArg('backend') || '',
      headless: getArg('headless') || 'false',
      useProxy: !hasFlag('no-proxy'),
      useFingerprint: !hasFlag('no-fingerprint'),
    });
    return;
  }
  if (getArg('account') && getArg('pass')) {
    await doLogin({
      mode: 'password',
      account: getArg('account'),
      password: getArg('pass'),
      backendUrl: getArg('backend') || '',
      headless: getArg('headless') || 'false',
      useProxy: !hasFlag('no-proxy'),
      useFingerprint: !hasFlag('no-fingerprint'),
    });
    return;
  }
  if (hasFlag('smart')) {
    await doLogin({
      mode: 'smart',
      phone: getArg('phone'),
      account: getArg('account'),
      password: getArg('pass'),
      backendUrl: getArg('backend') || '',
      headless: getArg('headless') || 'false',
      useProxy: !hasFlag('no-proxy'),
      useFingerprint: !hasFlag('no-fingerprint'),
    });
    return;
  }
  // 默认交互式菜单
  await interactiveMenu();
}

main().catch(e => { console.error('❌ 运行错误:', e); process.exit(1); });
