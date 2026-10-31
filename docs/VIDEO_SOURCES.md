# 独立 VideoSourceProvider：MacCMS JSON / TVBox 源

本模块与 Quark/Bilibili/Instagram 等 Provider 平行，不改变其原有契约和下载逻辑。

## 首版能力

- 在网页/桌面端添加、启停、删除 MacCMS JSON API 源；目录保存在本地配置文件。
- 粘贴 TVBox JSON 或输入 TVBox 配置 URL，通过服务端安全读取 sites；**只**导入 type=1 的 HTTP/HTTPS MacCMS API，不执行 Spider/jar/JS。非兼容项会计数并跳过。
- 按所选源搜索影视名称、分页，查看详情、播放线路及剧集。
- 仅 MP4 直链调用现有 aria2 下载与下载中心；私人云下载完成后通过原有“保存到此设备”回传。
- 源数据包含外部网址，请只添加信任、拥有相应使用授权的来源。

## 使用

1. 添加 JSON API，例如自建 MacCMS 的 /api.php/provide/vod/；或直接在“TVBox 配置 URL”输入 `https://api.hgyx.vip/hgyx.json` 试导入（不保证其中存在 type=1 源）。
2. 点击“测试源”，再搜索影片名称。
3. 点击“查看剧集”，选择标记为“下载 MP4”的剧集；进下载中心查看任务。
4. HLS/m3u8 会标注“待支持”，不把播放清单保存为伪 MP4。

## 接口

- GET /api/video-sources/sources
- POST /api/video-sources/sources {name,apiUrl,type:"maccms"}
- PATCH /api/video-sources/sources/:id {enabled:boolean}
- DELETE /api/video-sources/sources/:id
- POST /api/video-sources/import-tvbox {config:"{...}"}
- POST /api/video-sources/import-tvbox-url {url:"https://api.hgyx.vip/hgyx.json"}
- GET /api/video-sources/test?sourceId=...
- GET /api/video-sources/search?sourceId=...&keyword=...&page=1
- GET /api/video-sources/detail?sourceId=...&videoId=...
- POST /api/video-sources/download {sourceId,videoId,lineIndex,episodeIndex}

所有接口受已有本地限制或 PRIVATE_WEB token、HTTPS/Basic Auth 网关保护。服务器重新从保存的源解析视频，不接收前端任意视频下载 URL 或输出目录。源 API 连接前验证公网 DNS，并将已验证地址固定给 HTTP(S) 连接，限制响应大小、超时和跳转。**源页面中的媒体直链仍使用既有 aria2 安全边界；aria2 重定向/二次 DNS 绑定需要单独审计。**

配置路径通过 NETPAN_VIDEO_SOURCE_FILE 指定。未指定时：私人网页模式保存在 NETPAN_DOWNLOAD_DIR 下的隐藏 .video-sources.json；桌面端保存在 ~/.netpandownload/video-sources.json。生产建议为该路径挂独立受保护、可写的持久卷；文件权限 0600，原子替换。保留配置文件才可在重新部署后持续使用。

## 明确限制

- **不支持** MacCMS XML、动态 Spider/JS/jar、站点加密/签名、VIP/DRM/会员绕过、第三方播放器嗅探。
- 输入 TVBox 配置 URL 并成功获取 JSON，只能证明**配置下载/筛选**成功，不能代表 HG/饭太硬中的 Spider 项能搜索或播放。下载器不执行配置中的 jar、ext、parser、script。若返回 HTTP 403/HTML/地区限制或 DNS 失败，报告明确错误，不制造假成功。
- **不支持** HLS/m3u8 分片合并、DASH 音视频合并；不能把 m3u8 当 MP4 放到 aria2。
- 对片源服务器的 MP4 可下载性无法通过搜索结果推断；需要真实的合法源做集成验收。
- 不会自动部署到腾讯云。现有生产 PR #3 和磁力 PR #4 不受影响。
