/**
 * RankAnalyticsService - 排行榜数据分析服务（v7.1 新增）
 *
 * 职责：定时采集排行榜 + 数据分析 + 灰色关联度 + 引流机会挖掘
 * 调用 RankAPI / VideoAPI，不重复造轮子。
 */
import fs from 'fs';
import path from 'path';

export class RankAnalyticsService {
  constructor({ rankApiFactory, videoService }) {
    this.rankApiFactory = rankApiFactory; // () => RankAPI实例（无cookies）
    this.videoService = videoService;
    this.storagePath = path.join(process.cwd(), 'data', 'rank-snapshots.json');
    this.snapshots = [];
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        this.snapshots = JSON.parse(fs.readFileSync(this.storagePath, 'utf-8'));
      }
    } catch { this.snapshots = []; }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      // 只保留最近100个快照
      const toSave = this.snapshots.slice(-100);
      fs.writeFileSync(this.storagePath, JSON.stringify(toSave, null, 2));
    } catch (e) { console.error('[RankAnalytics] 保存失败:', e.message); }
  }

  /**
   * 采集排行榜快照
   * @param {Object} params
   * @param {number} [params.rid=0] - 分区ID
   * @param {string} [params.type='all'] - 类型
   */
  async fetchRanking({ rid = 0, type = 'all' } = {}) {
    const rankApi = this.rankApiFactory();
    const data = await rankApi.getRanking({ rid, type });
    const snapshot = {
      snapshotId: `rank_${Date.now()}`,
      rid, type,
      fetchedAt: new Date().toISOString(),
      count: data.list.length,
      videos: data.list,
    };
    this.snapshots.push(snapshot);
    this._save();
    return snapshot;
  }

  /** 获取最新快照 */
  getLatest(rid = 0) {
    return this.snapshots.filter(s => s.rid === rid).slice(-1)[0] || null;
  }

  /** 获取所有快照列表 */
  listSnapshots(limit = 20) {
    return this.snapshots.slice(-limit).reverse().map(s => ({
      snapshotId: s.snapshotId, rid: s.rid, type: s.type,
      fetchedAt: s.fetchedAt, count: s.count,
    }));
  }

  /**
   * 综合得分灰色关联度分析
   * 分析播放/弹幕/评论/收藏/投币/分享/点赞与综合得分的关联度
   */
  grayRelationAnalysis(snapshotId) {
    const snapshot = this.snapshots.find(s => s.snapshotId === snapshotId) || this.getLatest();
    if (!snapshot || snapshot.videos.length === 0) return { error: '无数据' };

    const videos = snapshot.videos.slice(0, 50);
    // 母序列：综合得分
    const mom = videos.map(v => v.score || 0);
    // 子序列：各因素
    const factors = {
      view: videos.map(v => v.view),
      danmaku: videos.map(v => v.danmaku),
      reply: videos.map(v => v.reply),
      favorite: videos.map(v => v.favorite),
      coin: videos.map(v => v.coin),
      share: videos.map(v => v.share),
      like: videos.map(v => v.like),
    };

    // 归一化
    const normalize = (arr) => {
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length || 1;
      return arr.map(v => v / mean);
    };
    const momNorm = normalize(mom);
    const results = {};
    for (const [name, arr] of Object.entries(factors)) {
      const arrNorm = normalize(arr);
      const diffs = arrNorm.map((v, i) => Math.abs(v - momNorm[i]));
      const min = Math.min(...diffs);
      const max = Math.max(...diffs);
      const cors = diffs.map(d => (min + 0.5 * max) / (d + 0.5 * max));
      const meanCor = cors.reduce((a, b) => a + b, 0) / cors.length;
      results[name] = { correlation: meanCor, rank: 0 };
    }
    // 排名
    const sorted = Object.entries(results).sort((a, b) => b[1].correlation - a[1].correlation);
    sorted.forEach(([name], i) => { results[name].rank = i + 1; });

    return {
      snapshotId: snapshot.snapshotId,
      videoCount: videos.length,
      factors: results,
      ranking: sorted.map(([name, val]) => ({ factor: name, correlation: val.correlation, rank: val.rank })),
      conclusion: `综合得分与${sorted[0][0]}关联度最高(${sorted[0][1].correlation.toFixed(3)})，其次是${sorted[1][0]}(${sorted[1][1].correlation.toFixed(3)})`,
    };
  }

  /**
   * 互动率分析（高播放低评论 = 引流机会）
   */
  findFunnelOpportunities(snapshotId, minView = 100000, maxReplyRatio = 0.001) {
    const snapshot = this.snapshots.find(s => s.snapshotId === snapshotId) || this.getLatest();
    if (!snapshot) return [];
    return snapshot.videos
      .filter(v => v.view >= minView)
      .map(v => ({
        ...v,
        replyRatio: v.view > 0 ? v.reply / v.view : 0,
        interactionRate: v.view > 0 ? (v.like + v.coin + v.favorite + v.reply) / v.view : 0,
      }))
      .filter(v => v.replyRatio <= maxReplyRatio)
      .sort((a, b) => b.view - a.view)
      .slice(0, 20);
  }

  /** 视频时长分布分析 */
  durationAnalysis(snapshotId) {
    const snapshot = this.snapshots.find(s => s.snapshotId === snapshotId) || this.getLatest();
    if (!snapshot) return { error: '无数据' };
    const buckets = { '0-3min': 0, '3-8min': 0, '8-13min': 0, '13-20min': 0, '20min+': 0 };
    const scoreByBucket = {};
    for (const v of snapshot.videos) {
      const min = v.duration / 60;
      let bucket;
      if (min < 3) bucket = '0-3min';
      else if (min < 8) bucket = '3-8min';
      else if (min < 13) bucket = '8-13min';
      else if (min < 20) bucket = '13-20min';
      else bucket = '20min+';
      buckets[bucket]++;
      if (!scoreByBucket[bucket]) scoreByBucket[bucket] = [];
      scoreByBucket[bucket].push(v.score || 0);
    }
    const avgScore = {};
    for (const [b, scores] of Object.entries(scoreByBucket)) {
      avgScore[b] = scores.reduce((a, b) => a + b, 0) / scores.length;
    }
    return { buckets, avgScore, total: snapshot.videos.length };
  }

  /** 白嫖比例分析（点赞/投币/收藏 vs 播放） */
  freeRiderAnalysis(snapshotId) {
    const snapshot = this.snapshots.find(s => s.snapshotId === snapshotId) || this.getLatest();
    if (!snapshot) return { error: '无数据' };
    const top20 = snapshot.videos.slice(0, 20);
    return top20.map(v => {
      const total = v.view || 1;
      return {
        title: v.title, bvid: v.bvid,
        likeRatio: (v.like / total * 100).toFixed(2),
        coinRatio: (v.coin / total * 100).toFixed(2),
        favRatio: (v.favorite / total * 100).toFixed(2),
        freeRiderRatio: (100 - (v.like + v.coin + v.favorite) / total * 100).toFixed(2),
      };
    });
  }
}

export default RankAnalyticsService;
