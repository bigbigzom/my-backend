/**
 * B站运营平台应用主类（v4.0 OOP重构）
 *
 * 组装所有Service，提供统一的启动/停止接口。
 * 依赖注入：各Service通过构造函数接收依赖。
 *
 * 架构：
 *   server.js (入口) → BiliApp (组装) → Services (业务逻辑) → bili-api/utils (底层)
 *                                                  → api/ (路由，薄)
 */
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { AppConfig } from '../config/AppConfig.js';
import { AccountService } from '../services/AccountService.js';
import { CommentService } from '../services/CommentService.js';
import { VideoService } from '../services/VideoService.js';
import { MonitorService } from '../services/MonitorService.js';
import { StrategyService } from '../services/StrategyService.js';
import { NurtureService } from '../services/NurtureService.js';
import { ProxyService } from '../services/ProxyService.js';
import { ContentService } from '../services/ContentService.js';
import { RiskService } from '../services/RiskService.js';
import { TaskService } from '../services/TaskService.js';
import { FingerprintService } from '../services/FingerprintService.js';
import { TrendTrackerService } from '../services/TrendTrackerService.js';
import { createApiRouter } from '../api/index.js';
import requireAdmin, { requireAdminForWrites } from '../src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class BiliApp {
  constructor() {
    this.config = new AppConfig();

    // 基础Service（无依赖）
    this.accountService = new AccountService();
    this.proxyService = new ProxyService();
    this.contentService = new ContentService();
    this.riskService = new RiskService();
    this.taskService = new TaskService();
    this.fingerprintService = new FingerprintService();
    this.strategyService = new StrategyService();
    this.nurtureService = new NurtureService();

    // 依赖注入的Service
    this.commentService = new CommentService({ accountService: this.accountService });
    this.videoService = new VideoService({ accountService: this.accountService });
    this.monitorService = new MonitorService({ commentService: this.commentService });
    this.trendTrackerService = new TrendTrackerService({
      videoService: this.videoService,
      commentService: this.commentService,
      monitorService: this.monitorService,
      accountService: this.accountService,
    });

    this._express = null;
    this._server = null;
  }

  async start() {
    const app = express();
    this._express = app;

    // 中间件
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // CORS
    const corsOptions = {
      origin: (origin, cb) => {
        if (!origin || this.config.allowedOrigins.includes('*') || this.config.allowedOrigins.includes(origin)) {
          cb(null, true);
        } else {
          cb(new Error('不允许的来源'));
        }
      },
      credentials: true,
    };
    app.use(cors(corsOptions));

    // 管理员鉴权（写操作）
    app.use(['/api/v2/accounts', '/api/accounts', '/api/bili', '/api/monitor', '/api/strategy', '/api/nurture', '/api/trend'], requireAdminForWrites);

    // 限流
    const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, message: { code: -1, message: '请求过于频繁' } });
    const publishLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { code: -1, message: '发布操作过于频繁' } });
    app.use('/api', generalLimiter);
    app.use('/api/bili/add-reply', publishLimiter);
    app.use('/api/bili/reply-action', publishLimiter);

    // 注册API路由
    const apiRouter = createApiRouter(this);
    app.use('/api', apiRouter);

    // 健康检查
    app.get('/health', (req, res) => {
      res.json({ code: 0, data: { status: 'ok', version: '4.0.0', service: 'bilibili-ops-platform' } });
    });
    app.get('/api/health', (req, res) => {
      res.json({ code: 0, data: { status: 'ok', version: '4.0.0', uptime: process.uptime() } });
    });

    // 404
    app.use((req, res) => {
      res.status(404).json({ code: -1, message: '接口不存在: ' + req.path });
    });

    // 错误处理
    app.use((err, req, res, next) => {
      console.error('[BiliApp] 未捕获错误:', err.message);
      res.status(500).json({ code: -1, message: err.message });
    });

    // 启动代理池
    this.proxyService.start();

    // 启动监控引擎
    try { this.monitorService.start(); } catch (e) { console.warn('[BiliApp] 监控引擎启动失败:', e.message); }

    // v5.1 链式2：Render作为第二层HTTP代理（处理CONNECT，经地区IP转发到目标）
    app.on('connect', (req, clientSocket, head) => {
      const target = req.url; // "host:port"
      const region = req.headers['x-proxy-region'] || 'CN';
      const [host, portStr] = target.split(':');
      const port = parseInt(portStr, 10) || 443;
      const proxy = this.proxyService.get(region);
      if (!proxy) {
        clientSocket.end('HTTP/1.1 503 No Proxy Available\r\n\r\n');
        return;
      }
      // 经地区IP连接目标
      const net = require('net');
      const [ph, pp] = proxy.proxy.split(':');
      const upstream = net.connect(parseInt(pp, 10), ph, () => {
        upstream.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      });
      let established = false;
      let buf = Buffer.alloc(0);
      upstream.on('data', (chunk) => {
        if (!established) {
          buf = Buffer.concat([buf, chunk]);
          const idx = buf.indexOf('\r\n\r\n');
          if (idx >= 0) {
            const statusLine = buf.slice(0, idx).toString().split('\r\n')[0];
            if (statusLine.includes(' 200 ')) {
              established = true;
              clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
              const rest = buf.slice(idx + 4);
              if (rest.length > 0) clientSocket.write(rest);
            } else {
              clientSocket.end(`HTTP/1.1 502 Upstream Error\r\n\r\n`);
              upstream.destroy();
            }
          }
        } else {
          clientSocket.write(chunk);
        }
      });
      upstream.on('error', () => { try { clientSocket.destroy(); } catch {} });
      upstream.on('close', () => { try { clientSocket.destroy(); } catch {} });
      clientSocket.on('data', (chunk) => { if (established) upstream.write(chunk); });
      clientSocket.on('error', () => { try { upstream.destroy(); } catch {} });
      clientSocket.on('close', () => { try { upstream.destroy(); } catch {} });
      if (head && head.length > 0) {
        // 等待established后再发送
        const sendHead = () => { if (established) upstream.write(head); else setTimeout(sendHead, 10); };
        sendHead();
      }
    });

    // 监听
    const port = this.config.port;
    this._server = app.listen(port, () => {
      console.log('');
      console.log('╔══════════════════════════════════════════════════════════╗');
      console.log('║  B站内容互动管理平台后端 v5.1.0（全球多地区+链式2）       ║');
      console.log('╠══════════════════════════════════════════════════════════╣');
      console.log(`║  端口: ${port}                                                ║`);
      console.log('║  架构: OOP分层 (API→Service→bili-api/utils)             ║');
      console.log('║  新增: 热度追踪模块 (TAG发现/视频抓取/自动评论/监控轮询)  ║');
      console.log('╚══════════════════════════════════════════════════════════╝');
      console.log('');
    });

    return this;
  }

  async stop() {
    if (this._server) {
      await new Promise(resolve => this._server.close(resolve));
      this._server = null;
    }
    console.log('[BiliApp] 已停止');
  }
}

export default BiliApp;
