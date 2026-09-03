/**
 * API 路由注册器（v4.0 OOP重构）
 *
 * 薄API层：只做参数解析和调用 Service，不包含业务逻辑。
 * 所有路由按模块分组，便于维护和扩展。
 *
 * 新增模块：/api/trend/* （热度追踪）
 */
import { Router } from 'express';

export function createApiRouter(app) {
  const router = Router();
  const {
    accountService, commentService, videoService, monitorService,
    strategyService, nurtureService, proxyService, contentService,
    riskService, taskService, fingerprintService, trendTrackerService,
  } = app;

  const ok = (res, data) => res.json({ code: 0, data });
  const fail = (res, message, code = -1) => res.json({ code, data: { message } });
  const handle = async (res, fn) => {
    try { const data = await fn(); ok(res, data); }
    catch (e) { console.error('[API]', e.message); fail(res, e.message); }
  };

  // ==================== 账号管理 v2 ====================
  router.get('/v2/accounts', (req, res) => ok(res, accountService.list(req.query)));
  router.get('/v2/accounts/stats', (req, res) => ok(res, accountService.getStats()));
  router.get('/v2/accounts/:id', (req, res) => {
    const a = accountService.get(req.params.id);
    a ? ok(res, a) : fail(res, '账号不存在');
  });
  router.post('/v2/accounts/:id/refresh', (req, res) => handle(res, () => accountService.refresh(req.params.id)));
  router.post('/v2/accounts/refresh-all', (req, res) => handle(res, () => accountService.refreshAll()));
  router.post('/v2/accounts/health-check', (req, res) => ok(res, accountService.healthCheck()));
  router.post('/v2/accounts/:id/verify', (req, res) => handle(res, () => accountService.verify(req.params.id)));
  router.post('/v2/accounts/import', (req, res) => {
    const count = accountService.importBatch(req.body.accounts || []);
    ok(res, { imported: count });
  });
  router.delete('/v2/accounts/:id', (req, res) => {
    accountService.delete(req.params.id);
    ok(res, { success: true });
  });
  router.get('/v2/accounts/:id/usage-policy', (req, res) => ok(res, accountService.getUsagePolicy(req.params.id)));
  router.get('/v2/usage-policies', (req, res) => ok(res, accountService.listUsagePolicies()));
  router.post('/v2/accounts/:id/warmup/reset', (req, res) => ok(res, accountService.resetWarmup(req.params.id)));
  router.post('/v2/accounts/refresh-due', (req, res) => handle(res, () => accountService.refreshDue()));
  router.put('/accounts/:id/active-hours', (req, res) => ok(res, accountService.setActiveHours(req.params.id, req.body.hours)));
  router.put('/accounts/:id/ip-role', (req, res) => ok(res, accountService.setIpRole(req.params.id, req.body.role)));
  router.put('/accounts/:id/social-separation', (req, res) => ok(res, accountService.setSocialSeparation(req.params.id, req.body.enabled)));
  router.get('/accounts/publisher-ips', (req, res) => ok(res, accountService.getPublisherIps()));
  router.get('/accounts/:id/risk-detail', (req, res) => ok(res, accountService.getRiskDetail(req.params.id)));

  // 旧版账号API（兼容）
  router.get('/accounts', (req, res) => ok(res, accountService.list(req.query)));
  router.post('/accounts/import', (req, res) => {
    const count = accountService.importBatch(req.body.accounts || []);
    ok(res, { imported: count });
  });
  router.put('/accounts/:id', (req, res) => ok(res, accountService.update(req.params.id, req.body)));
  router.post('/accounts/proxy-batch', (req, res) => ok(res, accountService.proxyBatch(req.body.ids, req.body.proxy)));
  router.delete('/accounts/:id', (req, res) => { accountService.delete(req.params.id); ok(res, { success: true }); });
  router.post('/accounts/sync-cookie', (req, res) => handle(res, async () => {
    return accountService.update(req.body.id, { cookieStr: req.body.cookieStr, csrf: req.body.csrf });
  }));
  router.post('/accounts/health', (req, res) => handle(res, () => accountService.healthCheck()));

  // ==================== 养号/培育 ====================
  router.get('/cultivation/status/:accountId', (req, res) => ok(res, accountService.getCultivationStatus(req.params.accountId)));
  router.post('/cultivation/daily', (req, res) => handle(res, () => accountService.dailyCultivation(req.body.accountId)));
  router.post('/cultivation/advance', (req, res) => ok(res, accountService.advanceCultivation(req.body.accountId, req.body.stage)));
  router.post('/cultivation/set-type', (req, res) => ok(res, accountService.setAccountType(req.body.accountId, req.body.type)));
  router.get('/cultivation/isolation/:accountId', (req, res) => ok(res, accountService.getIsolation(req.params.accountId)));

  // 视频发布者
  router.get('/video-publisher/list', (req, res) => ok(res, accountService.listPublishers()));
  router.post('/video-publisher/set', (req, res) => ok(res, accountService.setPublisher(req.body.id, req.body.isPublisher)));

  // ==================== B站API操作 ====================
  router.post('/bili/comment/check', (req, res) => handle(res, () => commentService.checkCommentExists(req.body)));
  router.get('/bili/video/info', (req, res) => handle(res, () => videoService.getInfo(req.query)));
  router.get('/bili/video-info', (req, res) => handle(res, () => videoService.getInfo(req.query)));
  router.get('/bili/user/videos', (req, res) => handle(res, () => videoService.getUpperVideos(req.query)));
  router.get('/bili/upper-videos', (req, res) => handle(res, () => videoService.getUpperVideos(req.query)));
  router.get('/bili/comment/subject', (req, res) => handle(res, () => commentService.getCommentList(req.query)));
  router.get('/bili/reply-list', (req, res) => handle(res, () => commentService.getCommentList(req.query)));
  router.post('/bili/add-reply', (req, res) => handle(res, () => commentService.addReply(req.body)));
  router.post('/bili/reply-action', (req, res) => handle(res, () => commentService.replyAction(req.body)));
  router.post('/bili/comment/like', (req, res) => handle(res, () => commentService.likeComment(req.body)));
  router.post('/bili/nurture', (req, res) => handle(res, () => commentService.addComment(req.body)));
  router.post('/bili/check-login', (req, res) => handle(res, async () => {
    const account = accountService.get(req.body.accountId);
    return { valid: !!(account && account.cookieStr), account };
  }));

  // ==================== v5.9 双通道验证：Render远程验证 ====================
  // 本地登录采集关闭浏览器时，将cookies+注册IP发送到此端点
  // Render用注册IP访问nav接口验证，验证通过则直接保存账号
  router.post('/auth/verify', (req, res) => handle(res, async () => {
    const { cookies, phone, remark, region, registeredProxyIp, userAgent, deviceProfile, refreshToken, localStorage } = req.body;
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return { valid: false, error: '无cookies数据' };
    }

    // 构造cookie字符串
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const csrf = cookies.find(c => c.name === 'bili_jct')?.value || '';
    const uid = cookies.find(c => c.name === 'DedeUserID')?.value || '';

    if (!cookieStr.includes('SESSDATA=') || !csrf) {
      return { valid: false, error: '缺少SESSDATA或bili_jct' };
    }

    // 用注册IP验证（通过BiliClient + ProxyAgent）
    const { BiliClient } = await import('../src/bili-api/BiliClient.js');
    const client = new BiliClient({
      cookieStr,
      csrf,
      proxy: registeredProxyIp || undefined,  // 使用注册时的IP
      deviceProfile: deviceProfile || undefined,
    });

    try {
      const result = await client.get('/x/web-interface/nav');
      if (result.ok && result.data?.data?.isLogin) {
        const navData = result.data.data;
        const finalUid = uid || String(navData.mid || '');
        const username = navData.uname || '';

        // 验证通过，直接保存账号
        const accountData = {
          type: 'cookie',
          username: finalUid ? `user_${finalUid}` : `user_${Date.now()}`,
          phone: phone || '',
          remark: remark || '',
          cookieStr,
          csrf,
          refreshToken: refreshToken || '',
          acTimeValue: refreshToken || '',
          region: region || 'CN',
          registeredProxyIp: registeredProxyIp || '',
          userAgent: userAgent || '',
          deviceProfile: deviceProfile || null,
          localStorage: localStorage || {},
          trustedDevice: true,
          canRefresh: !!refreshToken,
        };
        const imported = accountService.importBatch([accountData]);

        return {
          valid: true,
          uid: finalUid,
          username,
          avatar: navData.face || '',
          vipStatus: navData.vipStatus || 0,
          imported: imported > 0,
          message: '验证通过并已保存',
        };
      }
      return { valid: false, error: result.data?.message || 'nav返回未登录', code: result.data?.code };
    } catch (e) {
      return { valid: false, error: e.message };
    } finally {
      try { client.close(); } catch {}
    }
  }));

  // ==================== 监控引擎 ====================
  router.get('/monitor/tasks', (req, res) => ok(res, monitorService.list()));
  router.post('/monitor/tasks', (req, res) => ok(res, monitorService.add(req.body)));
  router.put('/monitor/tasks/:id', (req, res) => ok(res, monitorService.update(req.params.id, req.body)));
  router.delete('/monitor/tasks/:id', (req, res) => ok(res, monitorService.remove(req.params.id)));
  router.post('/monitor/start', (req, res) => ok(res, monitorService.start()));
  router.post('/monitor/stop', (req, res) => ok(res, monitorService.stop()));
  router.post('/monitor/run-now', (req, res) => handle(res, () => monitorService.runNow(req.body.id)));
  router.post('/monitor/check', (req, res) => handle(res, () => monitorService.checkComment(req.body)));
  router.get('/monitor/config', (req, res) => ok(res, monitorService.getConfig()));
  router.post('/monitor/config', (req, res) => ok(res, monitorService.updateConfig(req.body)));

  // ==================== 策略引擎 ====================
  router.post('/strategy/execute', (req, res) => handle(res, () => strategyService.execute(req.body)));
  router.get('/strategy/config', (req, res) => ok(res, strategyService.getConfig()));
  router.post('/strategy/config', (req, res) => ok(res, strategyService.updateConfig(req.body)));
  router.post('/strategy/template', (req, res) => ok(res, strategyService.applyTemplate(req.body)));

  // ==================== 养号引擎 ====================
  router.get('/nurture/stats', (req, res) => ok(res, nurtureService.getStats()));
  router.get('/nurture/plans', (req, res) => ok(res, nurtureService.getPlans()));
  router.get('/nurture/history', (req, res) => ok(res, nurtureService.getHistory()));
  router.post('/nurture/run', (req, res) => handle(res, () => nurtureService.run(req.body)));
  router.post('/nurture/start', (req, res) => ok(res, nurtureService.start()));
  router.post('/nurture/stop', (req, res) => ok(res, nurtureService.stop()));
  router.put('/nurture/plan/:accountId', (req, res) => ok(res, nurtureService.updatePlan(req.params.accountId, req.body)));

  // ==================== 代理池 ====================
  router.get('/proxy/stats', (req, res) => ok(res, proxyService.getStats()));
  router.get('/proxy/available', (req, res) => ok(res, { proxies: proxyService.getAvailable(parseInt(req.query.limit) || 100, req.query.region || null) }));
  router.get('/proxy/regions', (req, res) => ok(res, proxyService.getSupportedRegions()));
  router.get('/proxy/random', (req, res) => {
    const region = req.query.region || null;
    const p = proxyService.get(region);
    ok(res, p ? { proxy: p } : { proxy: null, message: region ? `${region}地区暂无可用IP` : '暂无可用IP' });
  });
  router.post('/proxy/refresh', (req, res) => handle(res, () => proxyService.refresh()));
  router.get('/proxy/global', (req, res) => ok(res, { globalProxy: proxyService.get() }));
  router.post('/proxy/global', (req, res) => ok(res, { success: true }));
  router.get('/proxy/occupancy', (req, res) => ok(res, proxyService.getOccupancy()));

  // ==================== 内容生成 ====================
  router.post('/rewrite/semantic', (req, res) => ok(res, contentService.semanticRewrite(req.body.text, req.body)));
  router.post('/rewrite/main-copy', (req, res) => ok(res, contentService.mainCopy(req.body)));
  router.post('/rewrite/dialogue', (req, res) => ok(res, contentService.dialogue(req.body)));
  router.post('/rewrite/nurture', (req, res) => ok(res, contentService.nurtureCopy(req.body)));
  router.get('/copy/weak-relevance', (req, res) => ok(res, contentService.weakRelevance(req.query)));

  // ==================== 风控 ====================
  router.get('/risk/dashboard', (req, res) => ok(res, riskService.getDashboard()));
  router.get('/risk/events', (req, res) => ok(res, riskService.getLogs(req.query)));
  router.get('/risk/accounts', (req, res) => ok(res, riskService.getAccounts()));
  router.post('/risk/mute', (req, res) => ok(res, riskService.muteAccount(req.body.id, req.body.reason)));
  router.post('/risk/recompute', (req, res) => ok(res, riskService.recompute()));

  // ==================== 任务队列 ====================
  router.get('/tasks', (req, res) => ok(res, taskService.list()));
  router.delete('/tasks/:id', (req, res) => ok(res, taskService.remove(req.params.id)));

  // ==================== 指纹 ====================
  router.get('/fingerprints', (req, res) => ok(res, fingerprintService.list()));
  router.post('/fingerprints/regenerate', (req, res) => ok(res, fingerprintService.regenerate(req.body.id)));
  router.post('/fingerprints/clear', (req, res) => ok(res, fingerprintService.clear(req.body.id)));

  // ==================== 审计 ====================
  router.get('/audit/logs', (req, res) => ok(res, riskService.getLogs(req.query)));

  // ==================== Personas ====================
  router.get('/personas', (req, res) => ok(res, []));

  // ==================== 登录（后端本地登录，兼容旧端点）====================
  router.post('/login/start', (req, res) => ok(res, { message: '请使用本地登录服务', localLogin: true }));
  router.get('/login/status/:sessionId', (req, res) => ok(res, { sessionId: req.params.sessionId, status: 'not-supported' }));
  router.post('/login/close/:sessionId', (req, res) => ok(res, { success: true }));

  // ==================== 热度追踪（v4.0 新增）====================
  // 热度TAG发现
  router.post('/trend/discover-tags', (req, res) => handle(res, () => trendTrackerService.discoverHotTags(req.body)));
  router.get('/trend/hot-tags', (req, res) => ok(res, trendTrackerService.getHotTags()));

  // 热度视频抓取
  router.post('/trend/fetch', (req, res) => handle(res, () => trendTrackerService.fetchVideos(req.body)));
  router.get('/trend/tasks', (req, res) => ok(res, trendTrackerService.listTasks()));
  router.get('/trend/tasks/:id', (req, res) => {
    const t = trendTrackerService.getTask(req.params.id);
    t ? ok(res, t) : fail(res, '任务不存在');
  });
  router.delete('/trend/tasks/:id', (req, res) => ok(res, { success: trendTrackerService.deleteTask(req.params.id) }));

  // 人工筛选
  router.post('/trend/tasks/:id/remove-video', (req, res) => ok(res, {
    success: trendTrackerService.removeVideoFromTask(req.params.id, req.body.aid),
  }));
  router.post('/trend/tasks/:id/remove-videos', (req, res) => ok(res, {
    success: trendTrackerService.removeVideosFromTask(req.params.id, req.body.aids || []),
  }));

  // 自动评论发布
  router.post('/trend/publish-comments', (req, res) => handle(res, () => trendTrackerService.publishComments(req.body)));

  // 监控轮询
  router.get('/trend/monitored', (req, res) => ok(res, trendTrackerService.listMonitored()));
  router.delete('/trend/monitored/:id', (req, res) => ok(res, { success: trendTrackerService.removeMonitored(req.params.id) }));
  router.post('/trend/monitored/:id/check', (req, res) => handle(res, () => trendTrackerService.runMonitorNow(req.params.id)));

  // 热度追踪统计
  router.get('/trend/stats', (req, res) => ok(res, trendTrackerService.getStats()));

  return router;
}

export default createApiRouter;
