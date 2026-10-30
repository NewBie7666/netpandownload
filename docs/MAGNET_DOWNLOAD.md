# 磁力链接下载（BitTorrent）

本模块复用现有 **aria2 RPC**，不替换网盘、B站、YouTube、Instagram、抖音、小红书、HTTP 下载能力。

## 使用

1. 在私人网页或 Electron 客户端的「下载任务」下找到「磁力链接下载」。
2. 粘贴 `magnet:?xt=urn:btih:...` 并提交。资源的元数据要通过 Tracker/DHT 和其他节点获取，可能需要等待；没有做种节点时不能保证可下载。
3. 在同一个任务列表查看进度、暂停、恢复、删除记录。下载完成后，**单文件**使用原「保存到此设备」；**多文件**展开任务内「文件列表」，逐个保存。手机端和桌面浏览器均经现有带认证的流式文件接口保存。

仅支持 BT v1 BTIH（40 位 hex / 32 位 Base32）和最多 20 个公开的 HTTP/HTTPS/UDP Tracker。忽略磁力中的其他参数（例如不接受 web seed、任意 output path、私网 Tracker）。不支持 BT v2-only、种子文件上传、整个目录自动 ZIP、从网页选择性下载子文件或一键删除 BT 本地文件。

## 部署与流量

- **本机桌面**：由本机 aria2 下载，占用本机带宽与磁盘。
- **私有云网页**：服务器上的 aria2 下载到固定隔离文件系统；在手机点击保存时，服务器再向手机下载一遍。**BT 下载及 BT 上传流量（即使不持续做种）和文件回传均计入服务器流量**，手机接收同时消耗自身网络流量。
- 新的 BT 任务使用 `seed-time=0` 和 `seed-ratio=0.0`，下载完成后不再持续做种。**下载期间仍可能向同伴上传**。磁力下载的可行性与服务器防火墙、提供商条款、DHT/Tracker 可达性有关。
- 私人 Web 模式不得指定下载目录，只能使用 `NETPAN_DOWNLOAD_DIR` 指向的独立容量受限挂载点。新任务提交前沿用剩余空间检查；若元数据揭示的大文件超过分区容量，aria2 仍可能因空间不足失败。**磁力链接不是容量预估**。
- 新安装的 Debian 配置由 `deploy/bootstrap.sh` 写入 `seed-time=0`、`bt-enable-lpd=false`、`bt-max-peers=32`。**现有腾讯云安装不会因代码更新而自动修改** `/etc/netpandownload/aria2.conf`；管理员应在维护窗口审核并人工添加这三项、确认端口和运营商条款，再重启 netpan-aria2。不要重新运行全套 bootstrap 覆盖已有凭据。
- 不开放 aria2 RPC 到公网，保持私人 HTTPS Basic Auth + 反向代理 Token + 127.0.0.1 监听。不要将服务器改造成公开 BT 下载服务。

## 安全与限制

- API: `POST /api/downloads/magnet`，请求体 `{"magnet":"magnet:?xt=urn:btih:..."}`；返回 `{"ok":true,"result":{"gid":"..."}}`。
- 复用现有 `/api/downloads/active`、`/api/downloads/status/:gid`、暂停/继续/删除路由。已完成单文件仍使用 `GET /api/downloads/file/:gid`，多文件使用 `GET /api/downloads/file/:gid/:fileIndex`（aria2 从 1 开始的索引），文件必须属于已完成的任务且通过下载目录内真实路径与文件大小校验。
- BT 多文件任务只允许从 Web 删除任务记录，不会误将第一个文件当作整个目录删除。文件仍占用云端磁盘，需由管理员检查后清理；目录打包、受控批量清理和 torrent 文件子项选择留待后续版本。
- 仅下载有权获取的内容；BitTorrent 节点可观察参与下载的 IP，使用前确认版权、隐私风险及 VPS 服务商相关条款。
- Tracker 地址验证会拒绝明显的本机、私网 IP 和本地域名，但域名可以在校验后变更解析结果，**不是完整的 DNS 重绑定防护**。不要在服务器上提交来源不可信的磁力链接。

## 验证

```bash
npm ci --ignore-scripts
npm run build
npm run build:electron
npm run test:magnet
npm run test:all-preserved
```

其中 `test:magnet` 为磁力校验 + 仿真 aria2 RPC 与多文件安全回传测试；**不是真实互联网 Tracker/DHT 的下载验收**。实际 BT 下载需要在拥有授权的测试资源、允许 P2P 的网络和有剩余空间的部署上另行验证。
