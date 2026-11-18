# 桌面版番号搜索与 BT 磁力下载

本功能仅集成到 Windows Electron 桌面版，Android APK 没有改动。

## 操作步骤

1. 打开 NetPanDownload 桌面版的“番号 / 关键词磁力搜索”。默认模式是“关键词 / 部分番号”，可输入中文、英文或部分番号，例如 `FPRE`、`FPRE-24`。
2. 点击“搜索”，显示 JavBus 首批匹配影片。选择具体影片，点击“查看磁力”；然后查看文件大小、高清及字幕标记。
3. 如需原有直接按完整番号获取磁力的流程，在搜索方式中选择“完整番号（精确）”，输入例如 `FPRE-249`。
4. 点击“下载”使用现有本机 aria2 RPC 引擎下载，也可复制磁力。在原有下载中心查看任务进度、暂停或继续下载。

请仅搜索和下载您有权获取的内容。索引站可能根据网络环境拒绝访问，搜索成功不代表有做种者。

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
