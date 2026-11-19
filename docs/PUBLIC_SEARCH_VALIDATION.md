# 公开搜索版验证记录

日期：2026-11-19（北京时间）。基于 `NewBie7666/netpandownload` 的 `main` 提交 `fad8d59`，在独立工作树和 `codex/public-search-20261119` 分支实现。原有工作目录及私人部署未改动。

## 已验证

| 检查 | 结果 |
| --- | --- |
| 原完整版本 `npm run build` | Vue 类型检查、前端和服务端构建通过 |
| 原搜索回归 | `magnetSearch.test.ts`、`magnetGeneralSearch.test.ts` 通过 |
| 原接口/产品数据约定回归 | `contractRegression.test.ts` 通过 |
| `npm run test:public` | 11 项通过，覆盖搜索、路由白名单、输入、限流、并发、来源、DNS、重定向、响应上限和错误脱敏 |
| 完整版本下载授权 | 纯搜索不授权下载；原本地适配层在缓存命中后仍正确授权并向模拟 aria2 提交任务 |
| 拿到结果后直调下载 API | POST `/api/downloads/tasks`、`/api/download-engine/tasks`、`/api/providers/download`、`/api/quark/download` 均为 404 |
| 独立发布包安装 | 仅安装锁定的最小 Express 运行依赖，真实启动编译入口；页面、静态资源、健康检查通过 |
| 发布包隔离 | 不含下载器、任务、认证、私人配置和数据模块；所有清单文件 SHA256 匹配；私有环境变量哨兵未泄漏 |
| 运行依赖审计 | 公开版 Express 4.22.3 运行依赖审计为 0 项已知漏洞；完整版本依赖未改动 |
| 浏览器验证 | Edge 无头浏览器桌面与 390px 手机布局通过；复制内容、模糊→精确获取、部分源失败、标题转义、无私人控件、无横向溢出、无页面错误 |

## 当前网络实测

使用公开版的受限网络访问路径，不使用 mock 或私人 cookie：

- BitSearch：`Ubuntu` 返回 40 条结果。
- Nyaa：`Ubuntu` 返回 1 条结果。
- Academic Torrents：索引成功获取；`Ubuntu` 无匹配结果。
- JavBus：部分代码查询返回 8 条条目，完整代码查询返回 9 个链接。公开版保留原有请求头和静态源 cookie，不读取用户登录凭据。

这些数字是测试时的上游快照，不保证其他地区或未来时刻仍可访问。生产环境上游失败时返回真实错误或部分结果。

## 部署边界

提供独立目录、独立用户、独立 systemd unit、HTTPS nginx 模板和构建工作流。CI 包含 Linux nginx 配置检查、systemd unit 检查及已安装发布包检查；运行结果见该分支的 GitHub Actions。

未连接或覆盖现有私人服务器，未配置真实域名/DNS/证书，未启动公网部署。多实例集中限流和公网容量测试未包含在本次单实例交付中；部署前仍需按指南填写域名、随机代理令牌并在目标服务器执行 `nginx -t`。
