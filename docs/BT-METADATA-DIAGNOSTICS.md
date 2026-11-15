# Windows 磁力下载诊断与修复

## 本次修复

原先的桌面端 aria2 侧车使用默认 BT 节点发现设置，且未配置可持续的 DHT 路由缓存、未完成任务恢复，也未展示 BT 节点信息。这会让 `[METADATA]` 任务长时间 0% 时难以区分是没有节点还是引擎问题。

改动包括：

- 启用 IPv4 DHT、Peer Exchange、Local Peer Discovery，并设置 TCP/UDP 监听端口范围。
- 使用当前 Windows 账号的 Electron userData 下 `bt-state` 保存 DHT 路由数据、aria2 会话与本地警告日志。不会放在便携 EXE 解包目录。
- 针对公开磁力附加固定的公共 Tracker 列表（来源：ngosang/trackerslist）；第三方 Tracker 会看到 Info Hash。**不适合私有 Tracker 资源**。
- 通过 BT Info Hash 去重，避免重复创建同一个资源的活动任务。
- 扩展 aria2 RPC 读取连接节点数、做种数、错误代码和文本，标明 Torrent 元数据阶段以及等待时长。3 分钟无连接会显示提示，10 分钟无连接明确显示等待超时，但不会自动删除用户任务。
- HTTP/视频下载继续沿用 aria2 的原有路径。
- 下载中心详情窗口会持续刷新，旧的选中任务也能实时更新状态。

## 验证边界

`tests/release/btMetadata.test.ts` 验证去重、元数据状态到文件字节状态转换、RPC 参数与 HTTP 隔离，但它是模拟 RPC。

`tests/e2e/btLocalSeeder.py` 与 `tests/e2e/btLocalIntegration.test.ts` 搭建一个**合法的本地合成 Torrent**，尝试实际获取元数据并传输文件、验证 SHA-256。Windows CI 与本机真实网络环境不同；如果本地 BT 做种器与下载器位于同一台主机，客户端可能过滤同主机对等节点，因此测试失败仍需查看 Tracker 是否收到 announce、实际连接数和 Windows 防火墙限制。

只有下载到实际文件字节并校验 SHA-256 才可称本地端到端验证通过。GitHub Actions 生成 EXE 并不等于你 qBittorrent 成功的 FPRE-249 那一条磁力链接已通过验收。由于没有取得该条磁力的完整 Info Hash，也不能访问用户的 Windows 网络环境，后者仍须用户本机实测。

## 仍需改进

若已成功做种的同一条磁力在 qBittorrent 可以下载而 aria2 仍保持 0 个连接，应考虑将 BT 后端改为 libtorrent，或者提供可明确选择的 qBittorrent 本地后端。与其反复添加 Tracker，不如收集两端连接日志及 Tracker 反馈后确认根因。

## 如何查看 BT 状态

进入「下载中心 → 任务详情」查看：
- 是否处于「获取种子元数据中」
- BT 节点连接数及做种者数
- 元数据等待时长
- aria2 错误代码/信息
- BT Info Hash
