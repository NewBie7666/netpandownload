# 通用 HTTP/HTTPS 下载

在 **下载任务 → HTTP/HTTPS 直链下载** 中输入公开直链，可选指定文件名，点击“添加 HTTP 下载任务”。任务进入现有 aria2 列表，可暂停、继续、移除以及打开下载目录。

## 要求与限制

- 仅在 Electron 启动 aria2 后可用；见 \`/api/downloads/health\`。缺少 \`aria2c.exe\` 时禁用输入。
- 直链不经过夸克、B站 Provider；网页详情页和需要登录、Cookies、动态签名、媒体提取的资源不保证能下载。
- 服务器是否支持 Range 决定是否能够断点续传。设置 \`continue=true\` 并不保证所有来源可续传。
- 新增 \`POST /api/downloads/direct\` 只接收 \`{ "url": "...", "fileName": "optional.ext" }\`；只使用应用当前配置下载目录，不允许单次请求覆盖路径。
- 仅允许 HTTP/HTTPS、无 URL 内嵌账号密码；检查目标域名的首次解析地址和 Windows 文件名，阻止明显的本地/私网地址。首次 DNS 检查无法防止后续解析变化或跳转。**不要把应用本地后端做端口映射或反向代理**。
- 后端现在仅监听 \`127.0.0.1\`，不再对所有来源返回宽松 CORS 头，增加了 Host/Origin 检查。
- 原 \`POST /api/downloads/add\` 保持 Provider 注册的 URL 授权校验，不改动其业务行为。
- 本次未修改 aria2 进程会话持久化，重启后的续传恢复需单独验证和改进。

## 测试

\`\`\`sh
npm ci
npm run test:direct
npm run build
npm run build:electron
\`\`\`

Windows 环境：

\`\`\`powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-aria2.ps1
npm run dev:desktop
\`\`\`

实际文件验收：普通 HTTP 和 HTTPS 直链正确保存并验证哈希；中途暂停/继续；恶意 URL、路径和跨站请求被拒绝；原夸克/B站解析下载回归；额外测试 HTTP 跳转、过期链接和不支持 Range 的服务器。

## 暂停/继续和重启恢复测试

- 下载中与排队中可以“暂停”；已暂停的任务可以“继续”。
- Electron 在 userData/aria2/downloads.session 读写 aria2 会话；每 10 秒更新会话与控制文件。
- 正常退出先执行 aria2.saveSession 和 aria2.shutdown；强制终止仅能使用最新自动保存进度。
- 已完成或已移除任务不会加入恢复队列。下载链接若已过期或服务器不支持 Range 仍可能无法续传。
- 测试请**更新到新版本后新建下载任务**，然后按：下载 → 暂停 → 继续 → 正常关闭软件 → 重开 → 核对进度 → 验证文件哈希。
