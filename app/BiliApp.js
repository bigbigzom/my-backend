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
import crypto from 'crypto';
import net from 'net';
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

    // 修复 express-rate-limit ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
    app.set('trust proxy', 1);

    // 启动代理池
    this.proxyService.start();

    // 启动监控引擎
    try { this.monitorService.start(); } catch (e) { console.warn('[BiliApp] 监控引擎启动失败:', e.message); }

    // v5.1 链式2 CONNECT代理（在server创建后绑定）
    const _self = this;
    const setupConnectProxy = (server) => {
server.on('connect', (req, clientSocket, head) => {
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
    };

    // v5.3 链式2：WebSocket隧道（Render LB不支持CONNECT，改用WS）
    const setupWsTunnel = (server, appRef) => {
      const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

      server.on('upgrade', (req, socket, head) => {
        if (!req.url || !req.url.startsWith('/api/proxy/ws-tunnel')) return;
        const url = new URL(req.url, 'http://localhost');
        const region = url.searchParams.get('region') || 'CN';

        // WebSocket握手
        const key = req.headers['sec-websocket-key'];
        if (!key) { socket.destroy(); return; }
        const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
        );


        console.log(`[WsTunnel] 客户端连接, region=${region}`);

        // 状态机：等待第一条文本帧（目标地址），然后建立上游连接
        let buf = Buffer.alloc(0);
        let targetConnected = false;
        let upstream = null;

        const parseFrame = () => {
          if (buf.length < 2) return null;
          const b0 = buf[0], b1 = buf[1];
          const fin = (b0 & 0x80) !== 0;
          const opcode = b0 & 0x0f;
          const masked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let offset = 2;
          if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
          else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
          let maskKey = null;
          if (masked) {
            if (buf.length < offset + 4) return null;
            maskKey = buf.slice(offset, offset + 4); offset += 4;
          }
          if (buf.length < offset + len) return null;
          let payload = buf.slice(offset, offset + len);
          if (masked && maskKey) {
            for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
          }
          buf = buf.slice(offset + len);
          return { fin, opcode, payload };
        };

        const sendFrame = (data, isBinary = true) => {
          const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
          const len = payload.length;
          let header;
          if (len < 126) header = Buffer.from([0x80 | (isBinary ? 2 : 1), len]);
          else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | (isBinary ? 2 : 1); header[1] = 126; header.writeUInt16BE(len, 2); }
          else { header = Buffer.alloc(10); header[0] = 0x80 | (isBinary ? 2 : 1); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
          socket.write(Buffer.concat([header, payload]));
        };

        const connectUpstream = (targetHost, targetPort) => {
          if (region === 'direct') {
            // v5.6 直连模式：Render服务器直接连接目标，出口IP为Render本身
            console.log('[WsTunnel] 直连模式: Render→' + targetHost + ':' + targetPort);
            upstream = net.connect(targetPort, targetHost, () => {
              targetConnected = true;
              sendFrame(JSON.stringify({ connected: true }), false);
            });
            upstream.on('data', (chunk) => { if (targetConnected) sendFrame(chunk, true); });
            upstream.on('error', (e) => { console.warn('[WsTunnel] 直连上游错误:', e.message); try { socket.destroy(); } catch {} });
            upstream.on('close', () => { try { socket.destroy(); } catch {} });
          } else {
            const proxy = appRef.proxyService.get(region);
            if (!proxy) {
              sendFrame(JSON.stringify({ error: '无' + region + '地区可用IP' }), false);
              socket.destroy();
              return;
            }
            const [ph, pp] = proxy.proxy.split(':');
            upstream = net.connect(parseInt(pp, 10), ph, () => {
              upstream.write('CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\nHost: ' + targetHost + ':' + targetPort + '\r\n\r\n');
            });
            let established = false;
            let upBuf = Buffer.alloc(0);
            upstream.on('data', (chunk) => {
              if (!established) {
                upBuf = Buffer.concat([upBuf, chunk]);
                const idx = upBuf.indexOf('\r\n\r\n');
                if (idx >= 0) {
                  const statusLine = upBuf.slice(0, idx).toString().split('\r\n')[0];
                  if (statusLine.includes(' 200 ')) {
                    established = true;
                    targetConnected = true;
                    sendFrame(JSON.stringify({ connected: true }), false);
                    const rest = upBuf.slice(idx + 4);
                    if (rest.length > 0) sendFrame(rest, true);
                  } else {
                    sendFrame(JSON.stringify({ error: '上游代理CONNECT失败: ' + statusLine }), false);
                    upstream.destroy();
                  }
                }
              } else {
                sendFrame(chunk, true);
              }
            });
            upstream.on('error', (e) => { console.warn('[WsTunnel] 上游错误:', e.message); try { socket.destroy(); } catch {} });
            upstream.on('close', () => { try { socket.destroy(); } catch {} });
          }
        };
        socket.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          let frame;
          while ((frame = parseFrame())) {
            if (frame.opcode === 0x8) { socket.destroy(); break; } // close
            if (frame.opcode === 0x1 && !targetConnected) {
              // 第一条文本帧：目标地址 "host:port"
              const target = frame.payload.toString().trim();
              const [host, portStr] = target.split(':');
              connectUpstream(host, parseInt(portStr, 10) || 443);
            } else if (frame.opcode === 0x2 && targetConnected && upstream) {
              // 二进制帧：转发到上游
              upstream.write(frame.payload);
            }
          }
        });
        socket.on('error', () => { try { upstream && upstream.destroy(); } catch {} });
        socket.on('close', () => { try { upstream && upstream.destroy(); } catch {} });
      });
      console.log('[WsTunnel] WebSocket隧道已启用: /api/proxy/ws-tunnel?region=XX');
    };

    // 监听
    const port = this.config.port;
    this._server = app.listen(port, () => {
      setupConnectProxy(this._server);
      setupWsTunnel(this._server, _self);
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
