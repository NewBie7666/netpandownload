# Type3 Android Gateway（Windows 可选执行后端）

本功能在 PR #23 的 Windows JVM、DEX 和 JavaScript Spider 运行时之上新增一个**可选** Android 原生执行后端。默认不启用，不更改现有 BT、Bilibili、HTTP 或 HLS 下载引擎。

## 什么时候使用

TVBox `csp_*` 的原始 JAR 如果包含 ARM Android ELF/JNI（例如 `csp_WexAiJianPianGuard` 的 `wexguard_v7.so` / `wexguard_v8.so`），它不能在 Windows x64 JVM 里直接加载。

本实现对接 [MTplayer Android-fish2018 SpiderGateway](https://github.com/meiyemeng/MTplayer/blob/main/android-fish2018/app/src/main/java/com/fongmi/android/tv/server/process/SpiderGateway.java) 的现有协议：`POST /v1/spider/home`、`search`、`detail`、`player`，并沿用其 `Bearer` token。Android 执行原始 Spider，Windows 收到 TVBox JSON 后使用现有下载链路。

**这是远程执行桥，不是 Windows ARM/JNI 模拟器。** MTplayer 是否真的能运行某个特定的 Guard 和后续播放代理，必须另行在 Android 真机验证。成功导入 JSON、HTTP 200 或取得搜索结果都不代表能完成媒体下载。

## Windows USB / ADB 部署（推荐）

1. 在 Android 手机上安装你确认来源可信的 MTplayer Android 版本，并在设置中启用 Spider Gateway；使用**独立随机令牌（至少 16 个字符）**，不可使用旧默认令牌 `mtplayer-local`。在 Android 端导入与 Windows 相同的 TVBox 配置并验证对应 Spider 可以调用。
2. 连接 USB，启用并授权手机的 USB 调试，在 Windows 安装 Android Platform Tools 后执行：

   ```powershell
   adb devices
   adb forward tcp:18777 tcp:9978
   Invoke-RestMethod http://127.0.0.1:18777/v1/spider/health
   ```

   `9978` 是示例 MTplayer Android 本机服务端口。若你的 Android 版本实际使用了其他端口，请按真实端口修改；`adb forward` 不会自动启动 Android 服务。

3. 在启动 **NetPanDownload EXE 之前**，于同一个 PowerShell 会话设置环境变量：

   ```powershell
   $env:NETPAN_TYPE3_GATEWAY_URL = 'http://127.0.0.1:18777'
   $env:NETPAN_TYPE3_GATEWAY_TOKEN = Read-Host '请输入 Android Spider Gateway 令牌'
   $env:NETPAN_TYPE3_GATEWAY_MODE = 'native'
   & '.\NetPanDownload-0.1.0-windows-x64.exe'
   ```

4. 配置模式：
   - `off`：完全关闭（默认未设置 URL 时）。
   - `native`：首选 Windows JVM；**仅**当本地明确报出 `type3_java_native_unsupported` 时调用 Android Gateway。不会将其它网络、规则或解析错误伪装成成功。
   - `always`：所有非 JavaScript 的 `csp_*` Type3 请求直接交给 Android（适合本机 JRE 不可用、或需要 Android 初始化状态的源）。

   Windows JavaScript 类型的 Type3 仍使用原 JS 引擎。Gateway 设置来自启动进程的环境变量，未写入源 JSON 或浏览器 localStorage。

## 与 MTplayer 对接的报文

```json
{
  "site": {
    "key": "wex-test",
    "name": "示例",
    "api": "csp_WexAiJianPianGuard",
    "type": 3,
    "jar": "https://example.org/spider.jar;md5;00000000000000000000000000000000",
    "ext": "",
    "searchable": 1
  },
  "keyword": "测试",
  "page": "1",
  "quick": false
}
```

POST 请求携带 `Authorization: Bearer <token>`。其中 `jar` 来自已导入的源，不由前端任意改写。搜索结果沿用 TVBox `list`，详情沿用 `vod_play_from` / `vod_play_url`，播放调用 `/player`，由现有 `VideoSourceProvider` 处理。

## 已知限制与安全边界

- Gateway 只允许 **127.0.0.1 / ::1 的 HTTP 明确端口**，通过 ADB 转发连接 Android。拒绝向公网/LAN HTTP 地址发送 token，以免明文泄漏；不会自动读取系统代理或向陌生域名转发。
- Android Gateway 若返回**手机本机或局域网的** `/media`、`proxy://`、`/v1/spider/native/` 或 `127.0.0.1:9978` URL，当前实现**不会**放松下载器的内网/SSRF 保护，而是明确报 `type3_gateway_media_proxy_required`（部分其它内网地址由下载器原有校验拦截）。这类源需要后续单独实现带认证、固定上游、Range/HLS 分片与密钥转发的安全媒体代理；目前**不能视为下载兼容**。
- 被导入的 Spider 是第三方代码，仍在 Android 宿主里执行；只运行可信配置。Windows 仅把 JSON 参数传给用户主动启用的本机 Gateway。不要把 Gateway HTTP 服务或其令牌开放给公网。
- 第三方协议的 `health` 不表示 Spider 一定可用。特别是 `newwex` 的 DNS 动态发现、`GoProxy` 和 `WexAiJianPianGuard` 尚需 Android 真机实际验证。
- 项目的公开搜索部署版不得将 Type3 Gateway、源执行和下载接口开放给访客。
- 本次独立编写的 TypeScript 适配器只参考了公开 API 协议，并**未复制** MTplayer 或 MarcoMovie 的实现代码；如果计划分发其 Android APK 或直接复用其源码，请单独审核许可。

## 验收

```powershell
npm run test:type3
npm run pre-release-check
```

`tests/downloads/type3Gateway.test.ts` 模拟真实 HTTP POST、Bearer token、站点参数、搜索→详情→线路→媒体解析、拒绝本机媒体代理和错误认证。**这是本地契约测试，不是已经在 Android 真机运行了 WexGuard。**

真实验收需要使用手机上的原生 Spider，在 Windows 界面完成同一个资源的搜索、详情、选线、媒体解析和实际文件下载，并检查输出文件的长度和解码。失败应记录准确阶段，不得用 NASA 测试或源导入作为替代。
