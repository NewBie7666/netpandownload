# NetPanDownload 私人网页版 / Debian 13

> 状态：集成分支供手工验收，**尚未部署到用户的云服务器**。此分支基于
> `feat/http-direct-download-20261019`，保留 HTTP/HTTPS 直链、静态网页扫描、
> Electron 交互式网页/弹窗扫描、夸克与 B站，并增加 Instagram、YouTube 单视频解析与浏览器文件下载。
> 不要直接覆盖现有桌面版生产部署或在公网开放端口 3000/16800。

## 1. 使用方式

在手机或电脑浏览器打开有 HTTPS 和访问密码的私人网址：

1. 粘贴 Instagram 单帖 / YouTube 单视频 / B站 / 夸克 URL，点击解析。
2. 在媒体列表中选择文件并加入 aria2 任务。直接文件 URL 则使用页面下方 **HTTP/HTTPS 直链下载**。
3. 等待任务显示 **Complete**，点击 **保存到此设备**；浏览器通过 `GET /api/downloads/file/:gid` 读取**已完成**的任务文件，按附件下载到当前设备。
4. “从网页筛选文件下载”继续提供静态 HTML 扫描、类型复选框、批次勾选。**交互式弹窗扫描属于 Electron 本地功能**，不在普通云端浏览器里运行；原桌面版代码仍保留。

文件先进入服务器 `NETPAN_DOWNLOAD_DIR`，随后通过 HTTPS 再传给手机/电脑。
服务器原始任务文件不会在浏览器保存后自动删除，需通过页面删除任务及文件来清理，或另行配置定期清理策略。不要对下载目录启用无审核的递归自动删除。

YouTube 使用安装的 yt-dlp 解析 **单个含音频的渐进式视频**（优先 MP4）；
不支持音视频分离格式合并、DRM、会员或需要登录的视频。B站和 Instagram 在 Linux
实际环境仍需网络实测，CDN 限制 / HTTP 403 / Cookie / ffmpeg 等问题会导致失败。
“解析成功”不等于“文件已完整下载”。

## 2. Debian 13 依赖及检出

以下示例的用户名 `netpan`、域名 `downloads.example.com`、口令均为占位符。

```bash
sudo apt update
sudo apt install -y git nginx apache2-utils aria2 python3 python3-pip pipx
# 安装 Node.js 22 LTS（可以从官方 NodeSource 或已可信的 Node.js 安装源安装）
node --version  # 要求 Node 22+
sudo useradd --system --create-home --shell /usr/sbin/nologin netpan
sudo mkdir -p /opt/netpandownload /srv/netpandownload/downloads /etc/netpandownload
sudo chown -R netpan:netpan /opt/netpandownload /srv/netpandownload
sudo -u netpan git clone -b feat/private-web-unified-download-20261023 \
  https://github.com/NewBie7666/netpandownload.git /opt/netpandownload/app
cd /opt/netpandownload/app
sudo -u netpan npm ci
sudo -u netpan npm run build
# Linux 上，避免仅使用 Windows .exe sidecar
sudo pipx install yt-dlp
sudo pipx install gallery-dl
```

如果 pipx 安装的工具在 `~/.local/bin`，在服务环境用绝对路径设置
`YTDLP_PATH` 与 `GALLERY_DL_PATH`，不要假设 systemd 的 PATH 与交互式 shell 相同。
`ffmpeg` 可按需要安装，但当前 YouTube 单视频 Provider 不依赖合并功能。

## 3. 启动独立的 aria2c 任务引擎

将下列配置保存到 `/etc/netpandownload/aria2.conf`（root 可写，服务账户可读），
并**将 SECRET_FROM_PASSWORD_MANAGER 更换为独立随机长字符串**：

```ini
enable-rpc=true
rpc-listen-all=false
rpc-listen-port=16800
rpc-secret=SECRET_FROM_PASSWORD_MANAGER
dir=/srv/netpandownload/downloads
continue=true
max-concurrent-downloads=3
max-connection-per-server=8
auto-file-renaming=true
allow-overwrite=false
```

`/etc/systemd/system/netpan-aria2.service`：

```ini
[Unit]
Description=NetPan private aria2
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=netpan
Group=netpan
ExecStart=/usr/bin/aria2c --conf-path=/etc/netpandownload/aria2.conf
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/netpandownload/downloads
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

禁止对公网放行 16800 端口。

## 4. 启动 Node.js 服务端（仅回环地址）

在 `/etc/netpandownload/netpan.env` 写入（root 拥有，`netpan` 用户可读，
权限建议 0640，不要提交进 Git）：

```ini
NODE_ENV=production
PORT=3000
NETPAN_PRIVATE_WEB=true
NETPAN_PUBLIC_ORIGIN=https://downloads.example.com
NETPAN_DOWNLOAD_DIR=/srv/netpandownload/downloads
NETPAN_DATA_DIR=/srv/netpandownload/data
ARIA2_ENABLED=true
ARIA2_RPC_URL=http://127.0.0.1:16800/jsonrpc
ARIA2_RPC_SECRET=SECRET_FROM_PASSWORD_MANAGER
YTDLP_PATH=/home/netpan/.local/bin/yt-dlp
GALLERY_DL_PATH=/home/netpan/.local/bin/gallery-dl
QUARK_MOCK=false
```

`/etc/systemd/system/netpan-web.service`：

```ini
[Unit]
Description=NetPan private web frontend/backend
After=network-online.target netpan-aria2.service
Wants=network-online.target
Requires=netpan-aria2.service

[Service]
Type=simple
User=netpan
Group=netpan
WorkingDirectory=/opt/netpandownload/app
EnvironmentFile=/etc/netpandownload/netpan.env
ExecStart=/usr/bin/node /opt/netpandownload/app/dist-server/server/index.js
Restart=on-failure
RestartSec=4
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/netpandownload
ProtectHome=false
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

创建 `/srv/netpandownload/data`、检查 Node 二进制的实际路径，并启动：

```bash
sudo mkdir -p /srv/netpandownload/data
sudo chown -R netpan:netpan /srv/netpandownload
sudo chmod 750 /etc/netpandownload
sudo systemctl daemon-reload
sudo systemctl enable --now netpan-aria2 netpan-web
curl -sS http://127.0.0.1:3000/api/health
sudo journalctl -u netpan-web -n 80 --no-pager
```

## 5. Nginx HTTPS + 私人认证

先为 `downloads.example.com` 配置 DNS A 记录，并取得正规 TLS 证书
（例如 certbot）。**配置 HTTPS 前不要把 Basic Auth 服务开放到公网。**
生成仅用于私有网站的账户（命令会交互要求输入密码）：

```bash
sudo htpasswd -c /etc/nginx/.netpan-htpasswd owner
```

Nginx 站点配置（SSL 路径和域名以实际证书为准）：

```nginx
server {
    listen 443 ssl;
    server_name downloads.example.com;
    ssl_certificate /etc/letsencrypt/live/downloads.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/downloads.example.com/privkey.pem;

    auth_basic "Private NetPan";
    auth_basic_user_file /etc/nginx/.netpan-htpasswd;
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        # 仅向受保护的本机后端传递回环 Host，客户端不能直连该 API。
        proxy_set_header Host 127.0.0.1:3000;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
    }
}
```

`NETPAN_PUBLIC_ORIGIN` 必须与浏览器访问时的 Origin 完全相同
（协议、域名、端口）。不要使用 `proxy_set_header Host $host`，
否则完整后端的回环 Host 校验会拒绝访问。
只开放 SSH、80(用于证书签发重定向)、443；**不要开放 3000 或 16800**。
如果使用 Tailscale/私网入口，仍建议 HTTPS、私人认证与严格访问控制。

## 6. 回归测试 / TestBot 验证

```bash
npm run build
npm run build:electron
npm run test:direct
npm run test:page-scan
npm run test:page-selection
npm run test:interactive-page
npm run test:pause
npm run test:unified-actions
npm run test:contracts
npm run test:instagram
npm run test:youtube
npm run test:private-web
```

GitHub Actions 在模拟环境下执行这些回归，不会下载 Instagram/YouTube 实时内容。
验收时另需在**拥有下载权限的内容**上手工确认单图、Reel、轮播、B站、
YouTube 以及普通 HTTPS 文件的文件大小、媒体可播放性与浏览器保存。
真实弹窗流程仍需 Windows Electron 验收。

## 7. 已知边界与安全

- 后端只在 `127.0.0.1:3000` 监听；aria2 RPC 也只能绑定回环地址。
- 浏览器端无操作系统目录选择权限；用服务器固定目录和“保存到此设备”代替。
- `GET /api/downloads/file/:gid` 只读取**已完成**的 aria2 任务，并校验文件真实路径
  必须位于固定目录。不存在访问任意路径的公开接口。
- Nginx Basic Auth 应覆盖所有 URL，包括 /api、媒体文件与静态资源。
  仅 localhost 监听不等于有用户认证。
- 云端直接 HTTP 下载仍可能遭遇重定向、DNS rebinding、恶意内容或资源消耗；
  **仅供受认证的个人访问**，不要开放为公共下载服务。
- 文件会占用云服务器磁盘与出站流量。没有实现全自动清理、共享账号、
  多用户隔离或通用受保护内容下载。
