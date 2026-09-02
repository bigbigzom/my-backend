/**
 * 代理服务（v4.0 OOP重构）
 *
 * 封装 proxy-pool，提供代理池管理、IP分配等功能。
 */
import {
  startProxyPool, getProxyPoolStats, refreshProxyPool, getProxy,
  acquireProxy, markProxyFailed, isProxyReady, getAvailableProxies,
  getOccupancyStats, waitForProxy, getProxyForAccount, SUPPORTED_REGIONS,
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
  get(region = null) { return getProxy(region); }
  acquire(accountKey, preferredProxy = null, opts = {}) { return acquireProxy(accountKey, preferredProxy, opts); }
  markFailed(proxy) { return markProxyFailed(proxy); }
  isReady(proxy) { return isProxyReady(proxy); }
  getAvailable(limit = 100, region = null) { return getAvailableProxies(limit, region); }
  getOccupancy() { return getOccupancyStats(); }
  async waitForProxy(timeoutMs = 15000, region = null) { return waitForProxy(timeoutMs, region); }
  getProxyForAccount(account, opts = {}) { return getProxyForAccount(account, opts); }
  getSupportedRegions() { return SUPPORTED_REGIONS; }
}
export default ProxyService;
