# 桌面版通用磁力聚合搜索、番号搜索与 BT 下载

本功能仅集成到 Windows Electron 桌面版，Android APK 没有改动。

## 操作步骤

1. 打开 NetPanDownload 桌面版的“BT 磁力聚合搜索”。默认模式是“通用磁力搜索”，可输入电影、电视剧、书籍、动漫等关键词（中英文均可）。
2. 可选资源分类（电影、电视剧、电子书、动漫、课程学术）与来源（默认综合、BitSearch、Nyaa、Academic Torrents）。点击“搜索”后自动汇总、按 Info Hash 去重；查看每个源的实际成功/失败状态。
3. 结果中选择“复制磁力”或“下载”，仍通过内置 aria2 RPC 下载；任务真正获取 BT 元数据、有 peer 传输数据才算下载有效。
4. 原有 JavBus 的“番号关键词 / 部分番号”模式和“完整番号（精确）”模式依然保留，与默认通用来源隔离。
5. 在原有下载中心查看任务进度、暂停或继续下载。

请仅搜索和下载您有权获取的内容。索引站可能根据网络环境拒绝访问，搜索成功不代表有做种者。

## 通用搜索源与边界

- **BitSearch**：综合 BT 索引；使用其声明的免密钥公开 JSON 搜索 API（按 IP 每日 200 次额度），中文与英文命中率以实际索引数据为准。默认过滤站点明确标注的成人分类，不等于审核了所有内容。
- **Nyaa**：通过站点 RSS 获取动漫资源。只查普通 Nyaa，不使用独立成人子站。
- **Academic Torrents**：首次请求数据库 XML 索引，解析 Info Hash，缓存 6 小时并在本地匹配书籍、课程、科研数据；首次加载会稍慢。
- **Internet Archive**：官方搜索返回的通常是 Archive Torrent 文件，必须读取 .torrent 的 bencoded `info` 字典计算准确 Info Hash；本次尚未作为直接磁力源接入，避免生成无效磁力。
- 三源采用并发查询、单源超时和单源失败独立反馈；只在全部失败时返回总错误。磁力按 Info Hash 去重，仅展示最多 60 条。
- “返回的种子数”只是索引数据，不意味着当前能连接 peers；未提供的做种数显示为“未知”，不会伪装成 0。
- 本功能仅为搜索与下载合法授权的资源，不表示站点资源都具备可转载/下载权限。

## 已知边界

- 单一搜索源：关键词使用 JavBus 搜索列表（含一般/无码检索），精确番号继续使用详情页面及磁力列表 AJAX 接口；不涉及外部服务部署，使用本机网络直接访问。
- 模糊搜索指关键词、片名或部分番号匹配，不包含拼写纠错、全网 BT 索引搜索或资源活跃度保证。只显示首批最多 40 个可识别标准番号的影片结果；选择影片之后才请求磁力链接。
- 并非独立离线搜索：索引源可能封禁网络、要求登录或更改页面结构；遇到这种情况会显示错误。
- 目前 BT 下载由 aria2 承担。磁力需经过本次搜索才允许进入下载队列，避免绕过已有的下载地址授权检查。
- 多文件 BT 任务不能通过现有“删除本地文件”按钮批量删盘；只能删除任务记录，再通过资源管理器自行管理文件。
- 运行中暂停/恢复复用已有下载中心。**跨应用重启的 BT 会话恢复与下载文件选择暂未实现**，不应视为支持。
- 无法从文件名准确得知做种者数量；结果列表不会编造活跃度数据。

## 构建

GitHub Actions 的 [Windows Desktop EXE](../../actions/workflows/desktop-windows.yml) 在 Windows 环境安装依赖、准备 aria2/yt-dlp、执行磁力解析回归测试、构建 portable EXE，并发布 Actions artifact。

本地 Windows 构建：

```powershell
npm ci
./scripts/prepare-aria2.ps1
./scripts/prepare-ytdlp.ps1
npx tsx tests/release/magnetSearch.test.ts
npm run build:desktop
```

输出位于 `release/*.exe`。本功能参考 `ovnrain/javbus-api` 的公开网页解析方案，未将其服务直接嵌入应用；原项目软件信息见 https://github.com/ovnrain/javbus-api 。
