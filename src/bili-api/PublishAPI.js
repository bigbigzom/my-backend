/**
 * PublishAPI - B站视频投稿接口封装（v7.1 新增）
 *
 * 只封装B站投稿相关API，不包含业务逻辑。
 * 被 VideoPublishService 调用。
 *
 * 投稿流程：
 * 1. 获取上传凭证 → 2. 分片上传到OSS → 3. 提交投稿 → 4. 查询审核状态
 */

export class PublishAPI {
  constructor(client) {
    this.client = client;
  }

  /**
   * 获取投稿上传凭证
   * @returns {Promise<Object>} { auth, endpoint, urls }
   */
  async getUploadCredential() {
    return this.client.get('https://member.bilibili.com/preupload');
  }

  /**
   * 提交投稿
   * @param {Object} params
   * @param {string} params.title - 标题
   * @param {number} params.tid - 分区ID
   * @param {string} params.tag - 标签（逗号分隔）
   * @param {string} params.desc - 简介
   * @param {string} params.filename - 上传后的文件名
   * @param {string} [params.cover] - 封面URL
   * @param {number} [params.copyright=1] - 1=自制 2=转载
   * @param {string} [params.source] - 转载来源
   */
  async submitArchive({
    title, tid, tag, desc, filename,
    cover = '', copyright = 1, source = '',
  }) {
    const data = {
      copyright: String(copyright),
      title,
      tid: String(tid),
      tag,
      desc,
      cover,
      videos: JSON.stringify([{ filename, desc: '', title }]),
      ...(source && { source }),
    };
    return this.client.postForm('https://member.bilibili.com/x/vu/web/add', data);
  }

  /**
   * 查询投稿审核状态
   * @param {string|number} aid - 视频aid
   */
  async getArchiveStatus(aid) {
    return this.client.get('https://member.bilibili.com/x/vu/web/view', { aid: String(aid) });
  }

  /**
   * 编辑已投稿视频
   * @param {Object} params - 同submitArchive，额外需要aid
   */
  async updateArchive(params) {
    const { aid, ...rest } = params;
    const data = {
      aid: String(aid),
      ...rest,
      videos: JSON.stringify(rest.videos || []),
    };
    return this.client.postForm('https://member.bilibili.com/x/vu/web/edit', data);
  }

  /**
   * 获取投稿分区列表
   */
  async getArchiveTypeList() {
    return this.client.get('https://member.bilibili.com/x/vu/web/archive/type');
  }

  /**
   * 获取预上传信息（用于获取上传URL和auth）
   * @param {Object} params
   * @param {number} params.size - 文件大小
   * @param {string} params.name - 文件名
   * @param {number} [params.r=2] - 上传线路
   */
  async getPreUpload({ size, name, r = 2 }) {
    return this.client.get('https://member.bilibili.com/preupload', {
      size: String(size),
      name,
      r: String(r),
      profile: 'ugcupos/bup',
    });
  }
}

export default PublishAPI;
