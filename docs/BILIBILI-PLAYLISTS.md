# B站合集及多P修复说明

问题复现输入：
`https://www.bilibili.com/video/BV1bYcMzdEgS/?p=9`

旧版错误现象：只显示 `Bilibili Episode 1`；部分分集 URL 还可能丢失 `p=9`，造成第九集下载时错用第一集 CID。

## 修复策略（Windows Electron）

- 参考仍在维护的 [yt-dlp Bilibili extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)，理解「多P共用同一个BV号，但由不同 page/CID 定位」的语义。
- 参考 BBDownNext 的「展开合集再批量选择」流程，不引入额外 .NET 程序。
- 解析器按完整性选择：yt-dlp playlist、HTML `videoData.pages` / `ugc_season.sections[].episodes`、公开 `/x/player/pagelist` 元数据；不将缺失分集目录的单项占位符当作完整合集。
- 每集使用独立 `BV号?p=N`、独立 fid、独立 CID。下载首选对应 CID，缺失时按 `p` 查询对应页；缺失后报错，不会错误使用第一页。
- App 现有「全选 → 下载选中」可用于批量加入下载队列，无需另做第二套批量 UI。
- 不绕过账号、付费、DRM 或平台访问控制；仅处理用户有权下载的公开视频。

## 测试与局限

`npx tsx server/providers/bilibili/resolver/resolver.test.ts` 包括 12P、第9P、独立 BV 合集、目录获取失败时拒绝假数据。

`npx tsx tests/release/bilibiliPartMedia.test.ts` 检查直链使用第9P的 CID、后备元数据查询按第9P选 CID，以及不能回退到第一页。

单元测试基于模拟网页和接口数据；并不证明线上 `BV1bYcMzdEgS` 已可访问，也不保证 B站当前风控条件下能下载。若页面需要登录、API 有地区/权限限制、或者媒体采用多轨 DASH，原有媒体下载能力仍可能受到限制。

**安全提示：** 对本人有权保存的内容使用功能；第三方平台或受版权保护内容并不因解析成功而自动获得下载许可。
