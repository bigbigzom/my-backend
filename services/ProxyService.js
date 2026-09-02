/**
 * 代理服务（v4.0 OOP重构）
 *
 * 封装 proxy-pool，提供代理池管理、IP分配等功能。
 */
import {
  startProxyPool, getProxyPoolStats, refreshProxyPool, getProxy,
  acquireProxy, markProxyFailed, isProxyReady, getAvailableProxies,
  getOccupancyStats,
} from '../src/utils/proxy-pool.js';

export class ProxyService {
  constructor() {
    this._started = false;
  }

  start() {
    if (!this._started) {
      startProxyPool();
      this._started = true;
    }
  }

  getStats() { return getProxyPoolStats(); }
  async refresh() { return refreshProxyPool(); }
  get() { return getProxy(); }
  acquire() { return acquireProxy(); }
  markFailed(proxy) { return markProxyFailed(proxy); }
  isReady(proxy) { return isProxyReady(proxy); }
  getAvailable(limit = 100) { return getAvailableProxies(limit); }
  getOccupancy() { return getOccupancyStats(); }
}
export default ProxyService;
