# NetPan 独立腾讯云发布

当前集成分支：`feat/private-web-unified-download-20261023`，Draft PR #3。禁止从旧 main 重建、未经审核合并或改动 Immune Arena。**本文件和成功的 CI 都不代表服务器已经部署。**

## 发布边界

- 应用：`/opt/netpandownload/{releases,.staging,logs}`，`current` 和 `previous` 原子符号链接。
- 运行账户 `netpan`；部署账户 `netpan-deploy`，独立 SSH 密钥。`netpan-release` 组仅让运行账户读取发布文件。部署账户不能直接读运行配置或下载文件。
- 数据：容量受限的独立挂载 `/srv/netpandownload`，下载和持久化分别在 `downloads/`、`data/`。默认剩余空间不足 1 GiB 时拒绝新任务；独立文件系统提供下载总量硬上限。下载运行到空间耗尽会失败，不能把失败结果当成完整文件。
- 配置：`/etc/netpandownload/web.env` 和 `aria2.conf`，root:netpan 0640。不要将完整配置、Cookie 或 Nginx 配置转储到 CI 日志。
- Express `127.0.0.1:3300`，aria2 RPC `127.0.0.1:16801`，外部只经过独立 Nginx HTTPS 站点和 Basic Auth。
- HTTP 80 仅公开本应用独立目录的 ACME 验证文件，其余请求跳转 HTTPS；网页和 API 继续经过私人认证。ACME 目录为 root:root 0755 的 `/var/lib/netpandownload-acme`，与下载文件及 Immune Arena 发布目录分开。
- `netpan-web.service` 依赖 `netpan-aria2.service`。非 root 运行、系统目录只读、限制内存/进程数。
- 不写 `/var/www/immune-arena`，不修改其用户、Secrets、服务和站点，也不替换 `nginx.conf`。

## 当前已确认与未确认

2026-10-24 检查：Immune Arena [Actions 40101671001](https://github.com/NewBie7666/immune-arena/actions/runs/40101671001) 真实完成 SSH/SCP 和远端版本切换。其成功说明旧项目当时可发布；GitHub 不允许读取其 Secret 值，也不能据此推定两个仓库共享凭据。

初次本机 SSH 探针遇到主机密钥冲突时已严格拒绝连接，没有绕过校验。2026-10-25 只读 HTTP 检查确认 Immune Arena 首页和 version.json 均为200，线上 SHA 为 `869c78c6e0877243e53002b3cfe39d836accf011`，与其成功部署记录一致。后续连接使用用户通过控制台核验的主机公钥，并保存到本项目专用 known_hosts，不改写其他项目记录。

2026-10-26 控制台补充核验：用户提供的 ED25519 指纹与 `152.136.33.189:22` 实时公钥一致，已保存本项目专用 known_hosts。控制台只读输出确认 Debian 13.7 trixie、x86_64、内存总量约3.6 GiB/可用3.1 GiB、根盘剩余37 GB，Nginx 1.26.3 监听80/443，已启用两个 Immune Arena 配置。Node 和媒体工具未在当前 PATH 找到，专用部署账户认证仍未就绪。用户已新增 `download.aielfhub.com` A 记录，Google/Cloudflare DNS 均返回上述服务器地址。现有 Certbot 4.0.0，原证书仅覆盖 `aielfhub.com`，不能代替下载器的新证书。这些证据仍不代表生产应用已经部署。

同日后续初始化：已用本项目 TLS 助手为 `download.aielfhub.com` 签发独立证书，证书目录 `/etc/letsencrypt/live/netpan-download.aielfhub.com/`，到期日2027-01-24，临时站点已按助手校验清理。用户完成 aria2 1.37.0、Chromium 156.0.8078.47 和 Node 22.23.4 安装；Node 官方归档 SHA-256 已核验，入口为 `/usr/bin/node`，实际文件在 `/opt/netpan-node-22.23.4/`。yt-dlp 2026.10.21（含默认依赖）与 gallery-dl 1.32.18 位于独立 `/opt/netpan-media-tools/` venv，入口是 `/usr/local/bin/`，pip依赖检查通过。独立容量挂载、账号/服务/私人认证、默认分支发布入口与实际生产发布仍待完成。

## 一次性管理员初始化

可以在腾讯云控制台执行，不需要以后每次更新都用 XShell。以下脚本要先审核；当前自动化不持有服务器管理员凭据。

1. 通过控制台核验 `/etc/ssh/ssh_host_ed25519_key.pub` 的指纹与真实主机。为新仓库准备准确的 `KNOWN_HOSTS` 行。不要运行未经核验的 `ssh-keyscan` 并直接信任结果，不要复用旧项目私钥。
2. 在目标主机执行只读 `bash deploy/audit-server.sh`。检查实际 OS/架构、已有 Nginx 域名/监听、Immune 当前发布及网页可用性、依赖和磁盘。审计脚本不打印完整 Nginx 配置；管理员私下核对所有域名和 TLS 路由。
3. 本实现目标为 **Linux x86_64、Debian/Ubuntu、systemd**。若审计发现其他架构/发行版，应先调整构建和初始化，不能强行使用此包。按发行版包管理器安装 aria2、nginx、apache2-utils、openssl、python3、sudo、util-linux；不要运行远程下载后直接 pipe 到 root shell 的安装脚本。
4. 在 `/usr/bin/node` 安装并验证固定 **Node 22.23.4**。用 [Node 官方下载与校验](https://nodejs.org/en/download/archive/v22.23.4) 获取对应 Linux x64 文件及签名校验清单。
5. 用管理员维护的独立 Python venv 安装审核过且固定版本的 yt-dlp、gallery-dl；入口位于 `/usr/local/bin/yt-dlp`、`/usr/local/bin/gallery-dl`。不要覆盖已有项目的 venv 或系统 Python 依赖。配置变量名称是 `YTDLP_PATH` 与 `GALLERY_DL_PATH`。工具版本和真实平台网络测试应记入管理员验收记录；升级单独审核。
6. 准备新的域名、DNS 和已获信任的有效 TLS fullchain/private key，期限至少还有七天。证书续期仍由管理员的既有 ACME 机制负责；下载器工作流不申请证书或修改其他站点。初始化会拒绝已被其他站点 `server_name` 覆盖的域名；遇到现有正则域名需先人工核对。
7. 准备容量固定的独立 `/srv/netpandownload` 挂载并持久写入 fstab。可用新分区/独立卷或预分配文件加 loop 文件系统；容量由管理员根据实际剩余磁盘选择。不能在未知磁盘上执行 mkfs，也不能使用无容量限制的根分区目录来假装配额。
8. 使用本次新生成的 NetPan **公钥**，以及本地交互式 `htpasswd -cB /root/netpan.htpasswd <用户名>` 创建的认证文件（不要将密码放命令行或聊天）。运行下面的一次性命令，参数均为文件路径，不是密钥内容：

```bash
sudo bash deploy/bootstrap.sh downloads.your-domain.example \
  /etc/letsencrypt/live/downloads.your-domain.example/fullchain.pem \
  /etc/letsencrypt/live/downloads.your-domain.example/privkey.pem \
  /root/netpan-tencent-ci.pub /root/netpan.htpasswd /srv/netpandownload
```

初始化自动生成私有应用 token 和 aria2 RPC token，不打印它们；只新增 netpan 文件和一个新 Nginx site。脚本拒绝覆盖既有账户/目录/unit/config。仅在 `nginx -t` 成功后 reload。失败时检查提示和 NetPan 专属半初始化状态后人工修复，不要盲目重跑或递归删除系统目录。旧 Nginx 配置和 Immune 文件始终不覆盖。

### 独立域名证书准备

域名 DNS 指向本机、Certbot 已安装后，可在 root 控制台运行已审核的助手：

```bash
python3 deploy/prepare-tls.py download.aielfhub.com
```

助手先检查域名未被现有 Nginx 站点覆盖，再创建本应用独立的临时 HTTP 验证站点，仅提供 `/var/lib/netpandownload-acme/.well-known/acme-challenge/` 中的 ACME 文件，其余路径返回404。随后调用 Certbot `certonly --webroot`，以 `netpan-download.aielfhub.com` 为独立证书名称。不会选用 Nginx 自动安装插件，也不停止 Nginx。

成功后证书路径为 `/etc/letsencrypt/live/netpan-download.aielfhub.com/fullchain.pem` 和同目录 `privkey.pem`。助手在成功或失败时都检查并移除自己本次创建的临时站点；若文件被第三方改变，则保留并要求人工核查。已有站点文件、旧证书和其续期配置不覆盖。ACME webroot 保留供正式配置复用，bootstrap 只接受其安全的 root:root 0755 目录。

新证书保存固定的续期 deploy hook：先 `nginx -t`，成功后 reload Nginx。正式站点建立后，检查现有 Certbot 调度，并单独验收新证书续期：

```bash
systemctl is-enabled certbot.timer
systemctl is-active certbot.timer
certbot renew --cert-name netpan-download.aielfhub.com --dry-run
```

临时站点清理后、正式站点尚未建立时，ACME 路由还未启用，因此该阶段不能宣称续期验收完成。若本机既有证书由其他调度机制维护，先核对实际机制，不创建重复续期任务。不要在日志或聊天中粘贴证书私钥。

### 有容量上限的数据挂载

已确认根盘空间充足时，可在 root 控制台运行已审核的助手，为本应用新建10 GiB数据区：

```bash
python3 deploy/prepare-storage.py --size-gib 10
```

助手只创建固定的新普通文件 `/var/lib/netpandownload-data.img`，实际预分配空间后才格式化该文件，并以 `loop,nodev,nosuid,noexec` 挂载到 `/srv/netpandownload`。它拒绝已有镜像、非空/符号链接挂载目录、已有挂载或冲突的 fstab 条目；操作前分别检查镜像所在文件系统和系统配置所在文件系统的可用空间，至少留出额外10 GiB系统余量。不会向现有系统块设备执行格式化。

确认挂载确实来自该镜像的 loop 设备、类型为 ext4 且限制选项齐全后，助手才备份 `/etc/fstab` 并原子追加本应用挂载条目，保留全部原有内容。备份是 `/etc/fstab.netpan-before-storage`，不会覆盖旧备份。失败时保留已创建状态供检查，不自动卸载未知文件系统或删除镜像；不要盲目重跑或删除已有数据。

fstab 使用 `nofail`，使下载镜像故障不阻止其他站点的系统启动。两个 NetPan unit 均要求该挂载，并在启动前检查挂载点；Web launcher 也在读取发布版本前重复检查。挂载不可用时仅本应用拒绝启动，防止回退到无容量限制的系统目录。

完成后用 `df -h /srv/netpandownload` 和 `findmnt --mountpoint /srv/netpandownload` 验收独立容量，再运行 bootstrap。10 GiB是本次依据实际可用空间选择的初始上限，并不保证任意大文件均可容纳；运行时仍保留剩余空间门限和下载失败状态。

本地 Linux 验证包含19项隔离检查、2项启动拒绝测试，以及真实32 MiB临时 ext4 loop镜像的挂载、容量、读写和限制选项测试。真实挂载测试使用临时 fstab 文件，不读写主机 `/etc/fstab`；CI 在无生产凭据的临时 Linux runner 中重复该测试。

`sudoers` 只允许新部署账户重启/停止 **netpan-web**，以及以 netpan 运行 root 拥有的固定健康脚本。没有 shell、包管理、任意 systemctl 或修改 Nginx 的 sudo 权限。健康脚本只接收完整 SHA，不输出 token。安装后的三个 `/usr/local/libexec/netpan-*` 文件必须保持 root 拥有；后续修改这些控制脚本需要一次管理员审核安装。

## GitHub Environment 与凭据

`production` 必须配置 required reviewer，并将自定义 branch policy 精确限定为该集成分支；不允许通配符或任意 PR 分支。发布 job 在 Environment 审批完成后才能获取凭据。参见 [GitHub Environment 保护规则](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)。

| Environment Secret | 值 |
| --- | --- |
| `DEPLOY_HOST` | 本次核验的腾讯云主机名/IP |
| `DEPLOY_PORT` | 本次核验的 SSH 端口 |
| `DEPLOY_USER` | 固定 `netpan-deploy` |
| `SSH_KEY` | 本仓库独立部署私钥（由安全输入导入，不打印） |
| `KNOWN_HOSTS` | 经控制台核验的主机密钥行；非标准端口使用 `[host]:port` 格式 |
| `PUBLIC_ORIGIN` | 完整 `https://域名`，不带尾部斜杠 |
| `SMOKE_USER` | 只用于发布后验收的有效私人 Basic Auth 用户 |
| `SMOKE_PASSWORD` | 该用户口令 |

不要把生产密钥放普通仓库 Secrets 来绕过 Environment。GitHub Secret 不能被读取或复制到另一个仓库；本次独立密钥需将对应公钥安装到新账户。网页 Basic Auth 口令与部署 SSH 密钥、后端 token 是三套不同凭据。

## 首次与以后发布

`.github/workflows/deploy-tencent.yml` **只支持 workflow_dispatch**。推送分支只跑 CI，不修改服务器。触发必须选择该集成分支，并输入与所选 ref 完全一致的 40 位已审核 `release_sha`。

**GitHub 的 workflow_dispatch 要求工作流先存在于默认分支。** 本项目已在用户明确授权后，仅将发布工作流文件加入默认 main；Draft PR 保持未合并。发布仍选择已审核的集成分支完整 SHA，不使用 main 的旧版应用代码。不能通过修改旧项目工作流或不受保护事件绕过保护规则。

无密钥 job 检出精确 SHA，固定 Node，`npm ci --ignore-scripts`，编译 Vue/Express/Electron，运行全部回归、真实 aria2 HTTP TestBot、Nginx TLS 认证与回滚 fixture。运行依赖从锁文件产生、prune devDependencies、生产高危依赖审计通过后封装 Linux 包；发布包包含版本身份和覆盖全部文件的 SHA-256 清单。外部归档 SHA 同时传到独立 deploy job，后者只下载**同一个工作流运行**的确切 artifact。

Environment 审批后，严格校验账号/主机/端口/主机密钥，SSH/SCP 上传固定 staging；root 安装的非特权发布助手检查归档 SHA、路径、完整清单、Linux 架构与提交 SHA，禁止符号链接/硬链接/任意路径，原子切换 current 并重启服务。包内代码不作为 root 执行，服务器无需 npm install。

传输使用四个并行 SCP 连接，将已校验的归档分块上传到本次运行独有的私有暂存目录；所有块成功后按顺序合并并再次校验完整归档 SHA-256，才原子移入发布助手使用的固定路径。拒绝覆盖已有归档和符号链接；失败及正常退出只清理本次固定文件和空目录。生产 job 时限30分钟，以容纳跨境链路波动；上传失败不会切换 current 或启动首发服务。

本地健康检查验证真实 release SHA、私有模式、禁用 mock 和实际 aria2 RPC。外部 smoke 再验证受信 TLS、未认证 `401`、Basic Auth 网页/API、真实下载固定 Node 22.23.4 官方校验文件、轮询完成、浏览器流式下载及固定长度和 SHA-256。该文件原始副本位于 `deploy/fixtures/node-v22.23.4-SHASUMS256.txt`，生产从官方 HTTPS 来源实际下载，fixture 仅用于离线失败路径测试。分步诊断只记录固定阶段与安全错误类别，不输出凭据或响应正文。失败自动恢复旧 current 并重启验证；首次无旧版时停止新服务并撤销 current。

## 回滚与保留

```bash
# 以 netpan-deploy 登录后
/usr/local/libexec/netpan-release.py verify-current
/usr/local/libexec/netpan-release.py rollback
```

回滚要求 current/previous 均为本应用已校验 release；回滚版本自身不健康时恢复原 current。锁阻止并发发布/回滚。外部 smoke 失败的 `undo --sha` 只撤销该运行发布的 SHA，不动别人后续版本。

保留最近五个 release，另保留 current/previous；staging 最多保留三个旧归档；远端日志最多三十份。成功发布移除其上传归档。清理只允许本应用固定目录中合法命名、没有符号链接的文件/目录。下载数据不自动删除，用户可删除任务及文件；独立挂载硬容量和 1 GiB admission 门限共同限制磁盘风险。发布还要求解压后至少留 512 MiB 余量。不要在日志中打印配置或 Cookie。

测试证据在 Actions artifacts（30天），发布日志（90天）和 `/opt/netpandownload/logs/`。清单不匹配时在切换前失败；任何失败都要保留对应 run 链接和回滚日志。

## 功能与真实限制

浏览器：粘贴链接→识别平台→选择媒体→加入任务→等实际 complete→“保存到此设备”。单文件由流返回，文件名和扩展名来自实际媒体。请求只接受任务 GID；只提供真实下载目录内、已完成、实际长度符合任务记录的单文件。不能用任意文件路径读取服务器。混合轮播保留类型筛选及单项选择。

- Windows Electron 的本地下载、交互式弹窗扫描保留。普通云端浏览器无法等同操作任意跨域弹窗，仍提供静态 HTML 扫描；不能把扫描/解析成功当成媒体下载完成。
- YouTube 仅支持 yt-dlp 返回的含音视频渐进式 MP4/WebM 直链；不支持 DASH/HLS、音视频分离合并、DRM、需要登录的内容。播放器支持取决于设备编解码器。
- Instagram 支持单帖图片、Reels 和混合轮播解析；签名链接失效、403、登录限制等会导致真实下载失败，应重新解析。没有实现后台自动刷新所有失效链接。
- B站网页模式不再把真实解析失败回退为模拟成功。登录、地区、高清音视频分离等限制必须实测；不冒充已经合并音轨。
- 夸克可能要求登录/转存/会员权限；本地代理下载通过内部认证，网页不会拿到后端 token。Cookie 仅管理员配置，禁止写进仓库和报告。
- HTTP/HTTPS 与静态网页扫描保留 DNS/私网地址检查。直链提交的首次 DNS 检查不能彻底消除 aria2 后续 DNS 变化/重定向的 SSRF 风险；本服务只供可信私人用户。不得去掉认证作为公共下载服务。
- 实际 Instagram/YouTube/B站/夸克、手机 Safari/Chrome 和 Windows Electron UI 验收，必须与 fixture/Mock CI 分开记录。没有真实运行证据的项目标为“未验证”。
- aria2 会话主要恢复未完成任务；aria2 自身重启后完成任务记录未实现独立持久化，已下载文件仍占空间。应用更新只重启 web，不重启 aria2；服务器重启后的孤立文件需管理员核查清理，不能声称完成任务历史永久保留。
