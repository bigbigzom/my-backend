/**
 * 应用配置管理（v4.0 OOP重构）
 *
 * 统一管理后端配置，支持环境变量和默认值。
 */
import { config as envConfig, getAllowedOrigins, validateConfig } from '../src/config.js';

export class AppConfig {
  constructor() {
    this._config = { ...envConfig };
    this._allowedOrigins = getAllowedOrigins();
  }

  get(key, defaultValue = null) {
    return this._config[key] ?? defaultValue;
  }

  set(key, value) {
    this._config[key] = value;
  }

  getAll() {
    return { ...this._config };
  }

  get allowedOrigins() {
    return this._allowedOrigins;
  }

  validate() {
    return validateConfig();
  }

  get port() {
    return parseInt(process.env.PORT || this._config.port || 3000, 10);
  }

  get adminToken() {
    return process.env.ADMIN_TOKEN || this._config.adminToken || '';
  }
}

export default AppConfig;
