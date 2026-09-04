/**
 * B站内容互动管理平台后端入口（v4.0 OOP重构）
 *
 * 精简入口：只负责创建 BiliApp 并启动。
 * 所有业务逻辑在 app/、services/、api/ 中。
 *
 * 旧版 server.js (1339行) 已重构为分层架构：
 *   server.js (30行入口) → app/BiliApp.js (组装) → services/ (12个Service) → api/ (薄路由)
 */
import { BiliApp } from '../app/BiliApp.js';

const app = new BiliApp();

app.start().catch(err => {
  console.error('[Server] 启动失败:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\n[Server] 收到关闭信号...');
  await app.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await app.stop();
  process.exit(0);
});
