# 抖音 / 小红书分享链接下载

在现有“资源链接”输入框直接粘贴 App 的完整分享文案，或粘贴作品链接，点击解析。解析成功后可筛选图片/视频、勾选所需文件并加入任务；任务实际完成后点击“保存到此设备”。Electron 的本地下载与云端固定目录模式均保留。

支持入口：

- 抖音 `v.douyin.com` 分享短链、`douyin.com/video/<ID>`、`douyin.com/note/<ID>`、浏览器带 `modal_id` 的单作品地址。
- 小红书 `xhslink.com` 分享短链、`xiaohongshu.com/explore/<ID>`、`xiaohongshu.com/discovery/item/<ID>`。
- 小红书分享中的 `xsec_token` 等查询参数必须完整保留；不要只复制笔记 ID。请勿把有签名的原链接写到公开日志、Issue 或 PR。

不支持用户主页、直播、合集批量抓取、私密作品、付费/DRM、验证码自动处理或 HLS/DASH 分片合并。对于需要登录或平台拒绝访问的内容，明确显示限制，不会返回模拟成功数据。

## 解析和下载

首先读取公开分享页的内嵌 JSON 状态：抖音移动分享页的 `_ROUTER_DATA` / `RENDER_DATA`，以及小红书的 `__INITIAL_STATE__`。仅解析数据，不执行页面 JavaScript。图文笔记按作品顺序返回图片；单视频只返回一个可下载视频，封面与备用 CDN 地址不作为额外文件重复列出。

公开网页没有可用媒体时，尝试安装的 yt-dlp 平台专用提取器，仅允许渐进式完整 MP4/WebM；不启用通用站点提取器，不把封面伪装为视频。yt-dlp 路径仍使用 `YTDLP_PATH`，可使用已有安装与 Electron sidecar。平台工具实现参考 [yt-dlp 抖音提取器](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py) 与 [小红书提取器](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/xiaohongshu.py)。

抖音已通过本下载器扫码登录时，公开页解析失败后会先在独立 Chromium 中复用托管登录态打开固定的官方作品页，让官方页面自然加载作品详情，再按作品 ID 和媒体 CDN 规则校验结果。该步骤会运行官方网站本身的脚本；内嵌 JSON 解析器仍只读数据。一次只读取一个作品，限时关闭浏览器；遇到官方验证或超时会明确报错，不自动处理验证码，也不把浏览器作为任意网址代理。没有托管登录态或浏览器组件不可用时继续尝试 yt-dlp。

所有短链跳转限定在同一平台的明确域名列表，并检查连接实际解析的 IP，最多四跳。返回的媒体必须属于受信任 CDN、没有内嵌凭据或任意端口。文件名由平台、作品 ID 和序号生成，不能用客户端文件元数据注入路径。原有私人认证、固定目录、完整文件校验及流式浏览器下载继续生效。媒体请求附带平台 Referer/User-Agent，内部服务 token 不会发给平台。

平台签名与访问策略可能变化。解析记录最多保留八分钟；点击下载时，超过一分钟的媒体会从原始分享地址刷新，保留小红书签名。记录过期、签名失效、403 或作品变化时，需要重新复制分享文案并解析；解析成功不代表文件已经下载完成。

## 可选登录态

公开作品通常不需要额外配置。确实需要平台登录态时，管理员可在服务机器上准备自己获授权的 Netscape 格式 Cookie 文件，并配置：

```dotenv
DOUYIN_COOKIE_FILE=/srv/netpandownload/data/douyin.cookies.txt
XIAOHONGSHU_COOKIE_FILE=/srv/netpandownload/data/xiaohongshu.cookies.txt
```

文件只给服务运行账户读取/必要时更新（例如 netpan:netpan、0600），不得放仓库、网页静态目录或日志。网页没有 Cookie 上传接口，不会自动读取用户浏览器的 Cookie。没有提供文件时只尝试公开访问；无法登录的内容如实报错。修改腾讯云的管理员配置仍需要已核验的连接权限，当前云部署状态见 [部署说明](TENCENT_DEPLOYMENT.md)。

抖音也支持网页内的官方扫码登录。点击“登录抖音”后使用抖音 App 扫描并确认，托管登录态会优先用于抖音解析和下载；退出、过期或损坏后不会回退到旧 Cookie 文件。扫码流程、浏览器安装、云端验证限制和加密保存边界见[抖音扫码登录说明](DOUYIN_QR_LOGIN.md)。

## 验证

`npm run test:social` 检查复制文案、短链、受信任跳转、签名保留、内嵌元数据、图片/视频、错误处理和过期刷新；浏览器测试同时覆盖桌面及手机尺寸的识别与媒体筛选。自动化使用可控 fixture，不代表所有线上作品均可下载。用户实际提供的链接应单独记录解析、下载字节、文件 SHA-256 和解码结果，报告中不回显签名参数或 Cookie。
