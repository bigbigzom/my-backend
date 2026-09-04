/**
 * 指纹服务（v4.0 OOP重构）
 */
import { listFingerprints, clearFingerprint, getOrCreateFingerprint } from '../src/utils/browser-fingerprint.js';

export class FingerprintService {
  list() { return listFingerprints(); }
  clear(id) { return clearFingerprint(id); }
  getOrCreate(id, opts) { return getOrCreateFingerprint(id, opts); }
  regenerate(id) { clearFingerprint(id); return getOrCreateFingerprint(id); }
}
export default FingerprintService;
