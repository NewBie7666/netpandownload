# NetPanDownload 公开搜索版部署

公开搜索版是一个独立的构建和运行单元，默认只监听 `127.0.0.1:3100`。它只提供搜索页面、搜索接口和复制结果链接所需的数据，不包含私有版的下载器、任务队列、下载目录、下载记录、登录状态或服务器文件浏览能力。

准确仓库名为 `NewBie7666/netpandownload`。本文中的命令应在公开搜索版工作树执行。部署到一台已经运行私有版的机器时，使用下面的全新 `/opt/netpan-public-search` 路径、独立 systemd unit 和独立 nginx server block；不要替换私有版的目录、环境文件、服务或站点配置。

## 构建和发布包

构建需要 Node.js 22 或更高版本：

```bash
npm ci
npm run build:public
npm run package:public
```

`build:public` 会生成 `dist-public/client` 和 `dist-public/server/public-search/server/index.js`。工作树中的模板位于 `public-search/deploy/`，`package:public` 会把它们复制为发布包根目录的 `deploy/`，并把本文复制为根目录的 `PUBLIC_SEARCH_DEPLOY.md`，最终生成 `release/netpandownload-public-search.zip` 及同名 `.sha256` 校验文件。发布包应包含隔离构建和最小运行时 `package.json`/lock 文件；它不应包含 `resources/aria2`、`resources/yt-dlp`、`resources/ffmpeg`、私有版 `dist-server`、`data/`、cookie 或 `.env` 文件。

打包步骤还需要构建机上的 Python 3 标准库来创建 ZIP；服务器运行公开版不需要 Python。发布后在构建机或交付通道核对：

```bash
sha256sum -c release/netpandownload-public-search.zip.sha256
```

在服务器上为每个版本创建新的目录，解压后只在发布包根目录安装最小运行依赖。示例使用明确版本目录，不覆盖已有版本或私有部署：

```bash
RELEASE=20261119-01
sudo install -d -o root -g root -m 0755 \
  /opt/netpan-public-search /opt/netpan-public-search/releases \
  /opt/netpan-public-search/releases/$RELEASE
sudo unzip -q release/netpandownload-public-search.zip \
  -d /opt/netpan-public-search/releases/$RELEASE
cd /opt/netpan-public-search/releases/$RELEASE
sudo npm ci --omit=dev --ignore-scripts
sudo ln -sfnT /opt/netpan-public-search/releases/$RELEASE \
  /opt/netpan-public-search/current
```

运行时依赖只应包含公开搜索服务需要的 Express（以及构建产物声明的必要运行时依赖）。发布包不需要 Electron、aria2、yt-dlp 或 FFmpeg。

## 首次安装

以下步骤只创建公开版资源，不会修改已有私有部署：

```bash
sudo useradd --system --home /opt/netpan-public-search --shell /usr/sbin/nologin netpan-public-search
sudo install -d -o root -g root -m 0755 \
  /opt/netpan-public-search/releases
sudo install -d -o root -g root -m 0755 /var/www/acme
```

如果 `/opt/netpan-public-search` 已由上一段创建，则不需要重复创建；发布版本目录和 `current` 符号链接必须由上一段的明确命令创建。发布树和符号链接由 root 管理，服务用户只需要读取权限。服务文件中的 `WorkingDirectory`、`ExecStart` 和用户均固定在这套新路径中。

## 环境变量和边界

从发布包根目录复制 `deploy/public-search.env.example` 到 `/etc/netpan-public-search.env`，修改域名和随机代理令牌：

```bash
sudo install -o root -g root -m 0600 \
  deploy/public-search.env.example /etc/netpan-public-search.env
sudoedit /etc/netpan-public-search.env
```

必须设置：

- `PUBLIC_SEARCH_ORIGIN=https://search.example.com`：必须是 HTTPS 的完整 origin，不能带路径、用户名或密码。
- `PUBLIC_SEARCH_PROXY_TOKEN`：至少 32 个字符的高熵 URL-safe 随机值。可用 `openssl rand -hex 24` 生成。
- `PUBLIC_SEARCH_PORT=3100`：只供本机反向代理访问。

代理令牌同时写入 nginx 模板的专用 server block。应用只在令牌验证通过后采用代理覆盖的 `X-Real-IP`；不要让客户端提供的 `X-Forwarded-For` 参与限流或身份判断。应用不启用 CORS，浏览器页面和 API 使用同一 origin。不要把 `QUARK_COOKIE`、私有版 token、下载目录或其他凭据放进这个环境文件。

默认限流是每 IP 每分钟 20 次、全局每分钟 120 次、全局并发 4、单 IP 并发 2；查询源请求超时为 12 秒。可在环境文件中调整 `PUBLIC_SEARCH_IP_LIMIT`（最大 100）、`PUBLIC_SEARCH_GLOBAL_LIMIT`（最大 1000）、`PUBLIC_SEARCH_CONCURRENCY`（最大 16）和 `PUBLIC_SEARCH_IP_CONCURRENCY`（最大 4），但 nginx 的请求限制仍是外层防线。

限流是单进程内存状态。多实例部署不能把它当作共享限流器；需要扩容时，应先增加统一网关/集中式限流，并确保每个实例仍只能绑定回环地址。

## systemd

安装独立 unit：

```bash
sudo install -o root -g root -m 0644 \
  deploy/systemd/netpan-public-search.service \
  /etc/systemd/system/netpan-public-search.service
sudo systemctl daemon-reload
sudo systemctl enable --now netpan-public-search.service
sudo systemctl status netpan-public-search.service
```

该 unit 使用 `netpan-public-search` 专用用户、只读的发布树、`PrivateTmp`、`ProtectHome`、`NoNewPrivileges` 和空能力集合，并设置 `MemoryMax=384M`、`TasksMax=64`、`CPUQuota=100%`。它不挂载下载目录，也没有下载器二进制、私有环境文件或私有数据目录。若服务器已有 `netpan-web.service` 或其他私有 unit，它们应保持原样运行。

## nginx 和 HTTPS

从发布包根目录复制 `deploy/nginx-public-search.conf.in` 到 nginx 的新站点文件，替换以下占位符：

- `search.example.com`：公开搜索版的新域名。
- `/etc/letsencrypt/live/search.example.com/...`：该域名自己的证书路径。
- `CHANGE_ME_32_OR_MORE_RANDOM_CHARACTERS`：与环境文件完全相同的代理令牌。

模板有独立的 80 端口 ACME challenge 和 HTTP→HTTPS 跳转，并在 443 站点中只代理 `/api/search`、`/api/health` 和静态页面。`/api` 及 `/api/` 下面的其他路径由 nginx 直接返回 404；不会转发到私有 API。查询和健康请求禁用请求体、限制请求体为 1 KiB，并拒绝非 GET 方法。模板关闭该 hostname 的 nginx access log，避免 URL 查询参数写入访问日志；应用也不记录查询值。`limit_req_zone`、`limit_conn_zone` 位于 nginx 的 `http` 包含上下文，适用于 Debian 的 `sites-enabled` 加载方式，超限状态码固定为 429。

申请证书和 DNS 由运维按域名策略完成；证书路径是模板占位符，不会自动改动已有证书。启用前检查：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

不要把该站点配置合并到私有版的 server block，也不要删除私有站点。nginx 会覆盖传给上游的 `X-Real-IP`、`X-Forwarded-For` 和 `X-Public-Search-Token`，因此客户端不能伪造这些值。应用的查询上游超时不超过 12 秒，nginx 查询读超时为 40 秒。

## API 和直接验证

应用只实现以下公开接口：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 返回服务状态 |
| GET | `/api/search?q=...&mode=auto&category=all&source=all` | 搜索并返回可复制的结果链接数据 |

`mode` 支持 `auto`、`general`、`fuzzy`、`exact`。`auto` 会根据输入选择精确番号或关键词/通用检索；精确模式仍保留完整番号查找能力，模糊模式仍支持部分番号。搜索源状态可能显示暂时不可用；这是真实上游网络状态，不应在生产环境开启 mock 数据。

在服务器本机，使用环境文件中的令牌验证 API 边界：

```bash
PUBLIC_SEARCH_TOKEN='从环境文件读取的令牌'
curl -i http://127.0.0.1:3100/api/health \
  -H "Host: search.example.com" \
  -H "X-Real-IP: 127.0.0.1" \
  -H "X-Public-Search-Token: $PUBLIC_SEARCH_TOKEN"

curl -G -i http://127.0.0.1:3100/api/search \
  -H "Host: search.example.com" \
  -H "Origin: https://search.example.com" \
  -H "X-Real-IP: 127.0.0.1" \
  -H "X-Public-Search-Token: $PUBLIC_SEARCH_TOKEN" \
  --data-urlencode 'q=示例关键词' \
  --data-urlencode 'mode=auto' \
  --data-urlencode 'category=all' \
  --data-urlencode 'source=all'
```

健康检查和有效搜索应返回 200。没有令牌时应用返回 403；错误 origin、超出并发/速率限制或 nginx 方法限制也会返回 403/429（具体取决于触发层）。可以用下面的请求确认下载能力没有被“隐藏按钮”伪禁用，而是服务端根本没有这些路由：

```bash
for path in \
  /api/downloads \
  /api/downloads/tasks \
  /api/download-engine/tasks \
  /api/providers/resolve \
  /api/providers/download \
  /api/quark/parse \
  /api/product/dashboard \
  /api/auth/douyin/status; do
  curl -sS -o /dev/null -w "$path -> %{http_code}\n" \
    "http://127.0.0.1:3100$path" \
    -H "Host: search.example.com" \
    -H "X-Real-IP: 127.0.0.1" \
    -H "X-Public-Search-Token: $PUBLIC_SEARCH_TOKEN"
done
```

上述旧接口应全部返回 404；经过 nginx 时，未列入 allowlist 的 `/api/` 路径也应由 nginx 返回 404。公开页面每条结果只有复制链接动作，不提供下载按钮、任务添加、下载目录、下载记录或外链打开动作。

还应直接验证非 GET 的任务/下载请求不会被路由到任何私有处理器：

```bash
for path in /api/downloads/tasks /api/providers/download /api/quark/parse /api/product/dashboard; do
  curl -sS -o /dev/null -w "$path POST -> %{http_code}\n" \
    -X POST -H 'Content-Type: application/json' \
    -d '{"url":"https://example.invalid"}' \
    "http://127.0.0.1:3100$path" \
    -H "Host: search.example.com" \
    -H "X-Real-IP: 127.0.0.1" \
    -H "X-Public-Search-Token: $PUBLIC_SEARCH_TOKEN"
done
```

这些请求应返回 404（nginx allowlist）或服务端的统一 404，不应创建任务。精确番号检索会顺序访问两个 JavBus 页面，最坏约 24 秒；`auto` 的候选搜索并行执行但同样受每个源 12 秒上限约束。主前端请求应使用 30 秒超时，nginx 的 40 秒读超时只作为服务端余量。

## 日常检查和故障边界

```bash
sudo journalctl -u netpan-public-search.service -n 100 --no-pager
sudo systemctl restart netpan-public-search.service
curl -fsS https://search.example.com/api/health
```

如果只看到某个搜索源不可用，先查看返回中的 `sources` 状态；公开服务会在其他源成功时保留部分结果。若所有源不可用，接口会返回上游不可用错误，不能用 mock 结果掩盖问题。若大量用户共享同一个出口 IP，单 IP 限流会把他们视为同一来源，可能更早得到 429；这是保护公开服务的预期行为。不要通过信任任意转发头来绕过该限制。

该部署方案不改变、不覆盖、不迁移任何现有私人部署。需要撤销公开版时，先停止 `netpan-public-search.service` 和新 nginx 站点，再处理专用 `/opt/netpan-public-search` 路径与 systemd 用户。
