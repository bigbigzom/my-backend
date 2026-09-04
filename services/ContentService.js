/**
 * 内容生成服务（v4.0 OOP重构）
 */
import {
  generateMainCopy, generateSubCopy, generateDialogue,
  generateNurtureCopy, semanticRewrite, generateWeakRelevanceCopy,
} from '../src/utils/content-rewriter.js';

export class ContentService {
  mainCopy(params) { return generateMainCopy(params); }
  subCopy(params) { return generateSubCopy(params); }
  dialogue(params) { return generateDialogue(params); }
  nurtureCopy(params) { return generateNurtureCopy(params); }
  semanticRewrite(text, opts) { return semanticRewrite(text, opts); }
  weakRelevance(params) { return generateWeakRelevanceCopy(params); }
}
export default ContentService;
