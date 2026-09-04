/**
 * AccountDiagnosticService（v6.0 账号诊断服务）
 *
 * 对云端同步的账号进行完整的前置可用性检测，输出详细日志用于排错。
 *
 * 检测项：
 * 1. 账号存在性 & 凭证完整性（SESSDATA/bili_jct/DedeUserID/refresh_token）
 * 2. IP可用性（注册IP→同地区回退）
 * 3. nav接口验证（真实访问B站个人主页）
 * 4. Cookie刷新能力（refresh_token是否存在）
 * 5. 设备环境完整性
 *
 * 设计：纯诊断，不修改账号状态。所有步骤独立try-catch，确保输出完整报告。
 */
import { BiliAuthAPI } from '../src/accounts-v2/BiliAuthAPI.js';
import { getProxyForAccount, isProxyReady } from '../src/utils/proxy-pool.js';

export class AccountDiagnosticService {
  constructor({ accountService }) {
    this.accountService = accountService;
  }

  /**
   * 诊断单个账号
   * @param {string} id - 账号ID（支持cloud_前缀）
   * @returns {Promise<{accountId:string, steps:Array, overall:string, summary:string}>}
   */
  async diagnose(id) {
    const cleanId = String(id || '').replace(/^cloud_/, '');
    const account = this.accountService.get(cleanId);
    const report = { accountId: cleanId, steps: [], overall: 'unknown', summary: '' };
    const log = (name, ok, detail) => {
      report.steps.push({ name, ok: !!ok, detail: detail || '' });
      console.log(`[Diagnostic] [${cleanId}] ${ok ? '✅' : '❌'} ${name}: ${detail || ''}`);
    };

    // ===== 步骤1：账号存在性 =====
    if (!account) {
      log('账号存在', false, `ID=${cleanId} 未找到。前端可能传了cloud_前缀但后端无此账号`);
      report.overall = 'failed'; report.summary = '账号不存在';
      return report;
    }
    log('账号存在', true, `uid=${account.uid}, username=${account.username || ''}, status=${account.status}`);

    // ===== 步骤2：凭证完整性 =====
    const cookieStr = account.cookieStr || '';
    const hasSessdata = cookieStr.includes('SESSDATA=');
    const hasBiliJct = cookieStr.includes('bili_jct=');
    const hasDedeUid = cookieStr.includes('DedeUserID=');
    const hasRefresh = !!account.refreshToken || !!account.acTimeValue;
    const credOk = hasSessdata && hasBiliJct && hasDedeUid;
    log('凭证完整性', credOk,
      `SESSDATA=${hasSessdata}, bili_jct=${hasBiliJct}, DedeUserID=${hasDedeUid}, refresh_token=${hasRefresh}` +
      (hasRefresh ? ` (${(account.refreshToken || account.acTimeValue || '').substring(0, 10)}...)` : ''));
    if (!credOk) {
      report.overall = 'failed'; report.summary = '凭证不完整，无法执行任务';
      return report;
    }

    // ===== 步骤3：IP可用性 =====
    let proxyToUse = null;
    try {
      const sticky = account.getStickyProxy((addr) => isProxyReady(addr));
      if (sticky) {
        proxyToUse = sticky;
        log('IP可用性', true, `使用粘性IP: ${sticky} (注册IP或最后使用IP)`);
      } else {
        const newProxy = getProxyForAccount(account);
        if (newProxy) {
          proxyToUse = newProxy.proxy;
          log('IP可用性', true, `粘性IP不可用，分配同地区新IP: ${newProxy.proxy} (${account.region || '未知'})`);
        } else {
          log('IP可用性', false, `无${account.region || '未知'}地区可用IP，账号将静默等待`);
        }
      }
    } catch (e) {
      log('IP可用性', false, `IP解析异常: ${e.message}`);
    }

    // ===== 步骤4：nav接口验证（真实访问B站） =====
    try {
      const api = new BiliAuthAPI({
        userAgent: account.userAgent || undefined,
        proxy: proxyToUse || undefined,
        deviceProfile: account.deviceProfile || null,
      });
      const navResult = await api.verifyLogin(cookieStr);
      if (navResult.isLogin) {
        log('nav接口验证', true, `isLogin=true, mid=${navResult.mid || '?'}, uname=${navResult.uname || '?'}`);
      } else {
        log('nav接口验证', false, `isLogin=false, code=${navResult.code || '?'}, message=${navResult.message || 'cookies已失效'}`);
      }
    } catch (e) {
      log('nav接口验证', false, `请求异常: ${e.message} (可能是代理不可达或网络问题)`);
    }

    // ===== 步骤5：设备环境 =====
    const hasDeviceProfile = !!account.deviceProfile;
    const hasUserAgent = !!account.userAgent;
    log('设备环境', hasDeviceProfile || hasUserAgent,
      `deviceProfile=${hasDeviceProfile}, userAgent=${hasUserAgent ? (account.userAgent || '').substring(0, 50) : '无'}`);

    // ===== 汇总 =====
    const failedSteps = report.steps.filter(s => !s.ok);
    report.overall = failedSteps.length === 0 ? 'healthy' : (failedSteps.length <= 1 ? 'degraded' : 'failed');
    report.summary = failedSteps.length === 0 ? '账号健康，可执行任务' :
      `存在${failedSteps.length}个问题: ${failedSteps.map(s => s.name).join(', ')}`;

    console.log(`[Diagnostic] [${cleanId}] 汇总: ${report.overall} - ${report.summary}`);
    return report;
  }

  /** 批量诊断 */
  async batchDiagnose(ids) {
    const results = [];
    for (const id of ids) {
      results.push(await this.diagnose(id));
      await new Promise(r => setTimeout(r, 500));
    }
    return { total: ids.length, results };
  }
}

export default AccountDiagnosticService;
