/**
 * 中国IP代理源配置（共享模块 v1.5.3）
 *
 * 本文件同时部署在：
 *   - local-login-service/lib/proxy-sources.js（本地登录服务）
 *   - backend/src/utils/proxy-sources.js（Render 后端）
 * 两处内容必须完全一致，保证代理源列表统一。
 *
 * 所有源均为公开免费代理，抓取后通过 ip-api.com 验证出口国家=CN，
 * 非中国IP会被过滤剔除。
 *
 * 源分类：
 *   A. GitHub raw 纯文本源（量大、稳定，优先）
 *   B. API 源（支持 country=CN 筛选）
 *   C. 国内代理网站（HTML 解析）
 *   D. GitHub 镜像/CDN 源（国内可直连，备选）
 */

export const CN_PROXY_SOURCES = [
  // ============================================================
  // A. GitHub raw 纯文本源（量大、稳定，优先）
  // ============================================================
  {
    name: 'MuRongPIG/Proxy-Master',
    getUrl: () => 'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
    pages: 1,
  },
  {
    name: 'officialputuid/KangProxy',
    getUrl: () => 'https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/http/http.txt',
    pages: 1,
  },
  {
    name: 'monosans/proxy-list',
    getUrl: () => 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    pages: 1,
  },
  {
    name: 'TheSpeedX/PROXY-List',
    getUrl: () => 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    pages: 1,
  },
  {
    name: 'ShiftyTR/Proxy-List',
    getUrl: () => 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
    pages: 1,
  },
  {
    name: 'prxchk/proxy-list',
    getUrl: () => 'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
    pages: 1,
  },
  {
    name: 'vakhov/fresh-proxy-list',
    getUrl: () => 'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt',
    pages: 1,
  },
  {
    name: 'roosterkid/openproxylist',
    getUrl: () => 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
    pages: 1,
  },
  {
    name: 'Anonym0usWork1221/Free-Proxies',
    getUrl: () => 'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/http_proxies.txt',
    pages: 1,
  },
  {
    name: 'elliottophellia/yakumo',
    getUrl: () => 'https://raw.githubusercontent.com/elliottophellia/yakumo/master/results/http/global/http_checked.txt',
    pages: 1,
  },
  {
    name: 'proxifly/free-proxy-list',
    getUrl: () => 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt',
    pages: 1,
  },
  {
    name: 'zloi-user/hideip.me',
    getUrl: () => 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt',
    pages: 1,
  },
  {
    name: 'ALIILAPRO/Proxy',
    getUrl: () => 'https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt',
    pages: 1,
  },
  {
    name: 'yemixzy/proxy-list',
    getUrl: () => 'https://raw.githubusercontent.com/yemixzy/proxy-list/main/proxy-list/data.txt',
    pages: 1,
  },
  {
    name: 'hendrikbgr/Free-Proxy-Repo',
    getUrl: () => 'https://raw.githubusercontent.com/hendrikbgr/Free-Proxy-Repo/master/proxy-list/http.txt',
    pages: 1,
  },
  {
    name: 'mmpx12/proxy-list',
    getUrl: () => 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
    pages: 1,
  },
  {
    name: 'rdavydov/proxy-list',
    getUrl: () => 'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt',
    pages: 1,
  },
  {
    name: 'sunny9577/proxy-scraper',
    getUrl: () => 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
    pages: 1,
  },
  {
    name: 'yoannchb-pro/Free-proxy',
    getUrl: () => 'https://raw.githubusercontent.com/yoannchb-pro/Free-proxy/main/http.txt',
    pages: 1,
  },
  {
    name: 'saschazesiger/Free-Proxies',
    getUrl: () => 'https://raw.githubusercontent.com/saschazesiger/Free-Proxies/master/proxies/http.txt',
    pages: 1,
  },

  // ============================================================
  // B. API 源（支持 country=CN 筛选）
  // ============================================================
  {
    name: 'proxyscrape(CN)',
    getUrl: () => 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=CN&ssl=all&anonymity=all',
    pages: 1,
  },
  {
    name: 'geonode(CN)',
    getUrl: () => 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&country=CN&protocols=http',
    pages: 1,
    isJson: true,
  },
  {
    name: 'proxy-list.download(CN)',
    getUrl: () => 'https://www.proxy-list.download/api/v1/get?type=http&country=CN',
    pages: 1,
  },
  {
    name: 'freeproxy(CN)',
    getUrl: () => 'https://free-proxy-list.net/',
    pages: 1,
    isHtml: true,
  },
  {
    name: 'spys(CN)',
    getUrl: () => 'https://spys.one/free-proxy-list/CN/',
    pages: 1,
    isHtml: true,
  },

  // ============================================================
  // C. 国内代理网站（HTML 解析）
  // ============================================================
  {
    name: '快代理(免费)',
    getUrl: (page) => `https://www.kuaidaili.com/free/inha/${page}/`,
    pages: 3,
    isHtml: true,
  },
  {
    name: '云代理',
    getUrl: (page) => `http://www.ip3366.net/free/?stype=1&page=${page}`,
    pages: 3,
    isHtml: true,
  },
  {
    name: '66免费代理',
    getUrl: () => 'http://www.66ip.cn/mo.php?tqsl=100',
    pages: 1,
  },

  // ============================================================
  // D. GitHub 镜像/CDN 源（国内可直连，备选）
  // ============================================================
  {
    name: 'TheSpeedX(jsdelivr镜像)',
    getUrl: () => 'https://cdn.jsdelivr.net/gh/TheSpeedX/PROXY-List@master/http.txt',
    pages: 1,
  },
  {
    name: 'monosans(jsdelivr镜像)',
    getUrl: () => 'https://cdn.jsdelivr.net/gh/monosans/proxy-list@main/proxies/http.txt',
    pages: 1,
  },
  {
    name: 'MuRongPIG(ghproxy镜像)',
    getUrl: () => 'https://ghproxy.com/https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
    pages: 1,
  },
];

export default CN_PROXY_SOURCES;
