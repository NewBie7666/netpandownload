# NetPanDownload Spider Gateway（独立 Android APK）

这是独立的 **Android 7.0+** TVBox `csp_*` 解析宿主，不是 NetPanDownload 既有 yt-dlp 下载 App。APK 不打包 FFmpeg、yt-dlp 或影片资源；纯 Java/Kotlin-free Android 应用，不绑定 arm64-v8a，Android 32 位和 64 位系统都可以安装。支持斐讯 N1 等低内存 Android 电视盒。

> 重要：**运行 Armbian/Linux 的 N1 不能安装 Android APK。** 需要使用另一台刷有 Android 系统的 N1 或安卓手机。APK 的安装成功仅证明基本运行，不证明 WexGuard 可用。

## 实现状态

- 基于 Android `DexClassLoader` 真正加载 DEX/JAR、调用常见 CatVod `homeContent/searchContent/detailContent/playerContent` 方法、尝试提取插件中与当前 ABI 相容的 ELF `.so`。不运行 Windows JVM 仿真，也不需要 Root。
- 精简宿主仅实现最小 CatVod SPI（干净实现，没有复制 MTplayer/FongMi/MarcoMovie 的 GPL 源码）。复杂插件依赖的 `com.github.catvod.net.*`、全局 `Init`、原生 Guard 解包、专有 JNI 和本机 `GoProxy` 等宿主能力**不保证可用**。缺少能力时应返回明确错误，不能宣传成全量 TVBox 兼容。
- **HTTP API 与 Windows PR #23 的 `type3-gateway.ts` 一致**：`GET /v1/spider/health`、`POST /v1/spider/home|search|detail|player`；POST 必须携带 `Authorization: Bearer <随机令牌>`。每次请求传入 TVBox 的 `site`（含 `api`、`jar`、`ext`），无需提前手工导入配置。
- 默认 HTTPS 下载 JAR；HTTP JAR 必须在 APP 中显式勾选许可，禁止 HTTPS→HTTP 降级，且拒绝解析到本地/私有 IP 的下载目标；可选校验声明的 MD5；单包限 20 MiB，响应限 2 MiB，请求限 256 KiB；同一个 Spider 串行执行，处理超时；本地仅缓存四个活动实例。
- Android 前台 Service、启动/停止按钮、令牌复制和轮换、默认仅 `127.0.0.1:18778` 监听、可手工允许可信局域网访问。
- **目前没有 Android 端本机媒体字节代理**。Windows 收到 `127.0.0.1:9978/media` 之类地址仍应报告不支持；公网直链才可以继续 Windows 下载。
- **仍需实机验证**：N1 具体 Android ROM 与 CPU ABI、WexGuard 的搜索/详情/播放解析、插件实际 `System.load` 及网络动态域名、媒体字节下载。

## APK 获取

新工作流：`GitHub → Actions → Spider Gateway Android APK`。在成功运行中下载 `NetPan-Spider-Gateway-N1-debug` artifact，解压得到 `app-debug.apk`。这是开发签名测试包，不是正式签名发行版。

本地使用 JDK 17 / Android SDK 35 / Gradle 8.11.1：

```bash
gradle -p android-spider-gateway :app:testDebugUnitTest :app:assembleDebug --no-daemon
```

## 设备端操作

1. 在**Android** 手机或 N1 安装 `app-debug.apk`；首次启动显示 `NetPan Spider Gateway`。
2. 点击「启动 Spider Gateway」。启动后前台通知显示监听端口 `18778`。
3. 复制页面显示的 48 位十六进制 Token。不要使用示例或默认共享令牌。
4. 建议保留「允许局域网连接」为**关闭**，让 Windows 使用 ADB 本地转发。如果开启 LAN，令牌会在局域网内通过明文 HTTP 传送，只适用于隔离且可信网络；现有 Windows Gateway 客户端为安全起见不允许直接填写 LAN HTTP 地址。

### 连接 Windows

若 USB 调试可用：

```powershell
adb devices
adb forward tcp:18777 tcp:18778
Invoke-RestMethod http://127.0.0.1:18777/v1/spider/health
$env:NETPAN_TYPE3_GATEWAY_URL='http://127.0.0.1:18777'
$env:NETPAN_TYPE3_GATEWAY_MODE='always'
$env:NETPAN_TYPE3_GATEWAY_TOKEN=Read-Host 'Android Gateway token'
& '.\NetPanDownload-0.1.0-windows-x64.exe'
```

斐讯 N1 若系统已开启 **ADB over TCP**，可以先 `adb connect N1_IP:5555`，再 `adb -s N1_IP:5555 forward tcp:18777 tcp:18778`。请勿擅自开放 5555 到互联网；不同 N1 ROM 的 ADB 设置方式并不统一。

Windows 的 TVBox 源从现有配置中导入，选择 `csp_*` 源后执行搜索。手机端收到的是 site JSON 和参数，由 Android DexClassLoader 加载插件。注意：如果 N1 运行的是 Armbian，则应该使用另一台 Android N1；不要修改 PS5 服务器的系统。

## 修复：Spider JAR 不是 HTTPS

v0.1.0 对任何非 HTTPS 的 JAR 地址直接返回 `Spider jar requires an HTTPS URL without credentials`，即使该源是正常的 `http://` TVBox JAR。这是 Android Gateway 的兼容性限制，不是 ADB 或 Windows JVM 报错。

v0.1.1 在界面添加「**允许 HTTP Spider JAR（仅用于明确可信的源）**」，默认关闭。只有当确知源地址为 HTTP、且信任源的发布者时才勾选；不用重建 ADB 转发。升级 APK 保留原有 Token，但应核对 Windows 启动参数。开启该选项有真实的远程代码篡改风险：HTTP 不能提供来源真实性，即使有 MD5 字段也不能替代 HTTPS。

Windows 侧保持 `NETPAN_TYPE3_GATEWAY_MODE=always`。如果错误从 HTTPS 校验改为 `Spider jar is missing classes.dex`、`ClassNotFoundException`、`NoClassDefFoundError` 或 `UnsatisfiedLinkError`，说明已跨过 URL 校验，需要进一步完善 Android CatVod Host 或对应 JNI 的加载流程；不能声称这些插件已兼容。

## v0.1.2：修复 Guard 构造期间空 Context

真实设备错误：
```
InvocationTargetException
Caused by: ExceptionInInitializerError
  at com.github.catvod.spider.DexNative.getSpider
Caused by: NullPointerException:
  Context.getCacheDir() on null
  at com.github.catvod.spider.DexNative.<clinit>
```
原因是 v0.1.1 在 `new WexAiJianPianGuard()` 之后才执行实例 `Spider.init(Context, ext)`，但 Guard 构造函数已经调用了 `DexNative`。根据 TVBox 传统 JarLoader 流程，必须在创建任何 `csp_*` 对象之前，调用同一个 `DexClassLoader` 加载的 **静态** `com.github.catvod.spider.Init.init(Context)`，然后再构造并执行实例 init。

v0.1.2 修正初始化顺序并展开反射异常的底层原因。不要把此修复等同于完成 WexGuard 兼容：Guard 可能还需要二级 DexClassLoader、厂商 JNI、本机代理或其他宿主服务。如果出现 native 级别 SIGABRT，日志可能不再以 Java 异常形式出现，应抓取 AndroidRuntime/DEBUG 日志并停止反复重试。

更新 APK 后确认 Gateway 仍在运行；Windows 端继续使用原来的 `127.0.0.1:18777` ADB 转发和令牌设置，只需从已设置环境变量的 PowerShell 重新启动 Windows EXE 进行搜索。

## 失败诊断

- **无法连接 Gateway**：先测 health，再确认 APK 前台服务和 ADB forward 的设备与端口。
- **HTTP 401**：Windows 令牌与 APP 页面所示不一致；轮换令牌会立即使旧令牌失效。
- **HTTP 502 / ClassNotFoundException / NoClassDefFoundError**：Spider 依赖的 Android/CatVod 宿主类缺失。简化宿主不等于成熟影视仓。
- **UnsatisfiedLinkError / 32/64 位不匹配**：系统 ABI、native .so 或其依赖不匹配；N1 的 ARM64 CPU 并不保证 Android 用户空间是 64 位。
- **搜索成功但不能下载**：需要同时核对最终媒体 URL、headers、Cookie、Android localhost proxy 与 HLS Range/分片处理。

## 安全与许可证

这个网关将可信第三方 JAR/DEX 作为代码运行，可访问应用自身权限范围内的网络与文件；Android 应用沙盒不是安全的插件沙盒。仅导入信任的源。默认限制回环连接；局域网需要用户显式打开，且仅使用私有可信网络。第三方 Spider/JNI 的授权与行为由使用者自行核查。本项目没有复制上游 MTplayer/MarcoMovie 的实现代码，只复用了公开的 TVBox 方法名和 Gateway JSON 协议。

**验收定义**：APK 构建成功 → N1 真机启动/health → Bearer 认证 → 真实 csp_* 搜索 → 详情 → player 解析 → Windows 发起 MP4/HLS 下载，检查文件字节及解码。前几项成功不能代替后面几项。
