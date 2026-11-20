# Type3 原生包拒绝：文件清单与实际调用栈

核查日期：2026-11-20。目标为 `csp_WexAiJianPianGuard`。以下两份栈来自不同实验，不能拼接成一次产品运行。路径已去标识，方法名、顺序、异常及行号保留。

## 被拒绝的原始 JAR/ZIP

- 配置：`https://9280.kstore.vip/newwex.json`。
- 原包 URL：`http://oss4liview.moji.com/thd_file/2026/11/17/ff5af105e608d6389b89d59586515c70.jpg`。扩展名为 `.jpg`，实际内容是包含 DEX 和资源的 ZIP/JAR。
- 原始包大小：1,047,475 字节。
- 原始包 MD5：`5a934007fb34ec762c2e7d25dbdc865d`（与配置声明一致）。
- 原始包 SHA256：`620afed882618749e5a9fbb558f8eb847f4a4a4c6f6a5369f6b9099331849138`。

| 包内真实路径 | 格式与架构 | 字节数 |
| --- | --- | --- |
| `assets/wexguard_v7.so` | ELF / ARM / 32 位 | 48364 |
| `assets/wexguard_v8.so` | ELF / AArch64 / 64 位 | 48680 |

这两个文件触发了产品的 `.so` 预检。检测发生在启动 Java Runner 之前，不是 JVM 已执行源代码后抛出的异常。

## 解出业务包中的第二层库

研究输出 `native-loader-output.bin` 本身是 ZIP，SHA256 为 `6644bed20cf19aac6003726da48d6124497840b1e09ad52b97b8c5a8764023f3`。其条目为：

| 业务包内路径 | 格式与架构 | 字节数 |
| --- | --- | --- |
| `assets/libwex_v7.so` | ELF / ARM / 32 位 | 97052 |
| `assets/libwex_v8.so` | ELF / AArch64 / 64 位 | 113816 |

这些属于解出的第二层业务包，不应误写成原始被拒绝 JAR 中的条目。每个 `.so` 的 SHA256 和 ELF machine 值保存在 JSON 证据中。

## 实际栈 A：产品 provider 的预检拒绝

独立数据目录调用编译后的 `VideoSourceProvider.search`，使用原始配置的类名、URL 和 MD5，未修改用户配置。Node 版本：`v24.15.0`。这是 provider 的实际异常栈，不额外补入没有采集的 HTTP/Express 栈帧。

错误码：`type3_java_native_unsupported`。源码拒绝位置是 `server/video-sources/type3-java.ts` 的 `preparedSpider`；以下行号来自实际运行的编译 JS。

```text
Error: 该 Spider 包含 Android 原生库（.so），Windows JVM 适配器已拒绝执行；需要原生 Android 兼容层
    at appError (file:///<workspace>/dist-server/server/video-sources/type3-java.js:17:12)
    at preparedSpider (file:///<workspace>/dist-server/server/video-sources/type3-java.js:448:15)
    at async invokeJavaSource (file:///<workspace>/dist-server/server/video-sources/type3-java.js:505:11)
    at async invokeType3 (file:///<workspace>/dist-server/server/video-sources/type3.js:23:15)
    at async VideoSourceProvider.query (file:///<workspace>/dist-server/server/video-sources/provider.js:37:28)
    at async VideoSourceProvider.search (file:///<workspace>/dist-server/server/video-sources/provider.js:65:24)
    at async file:///<workspace>/[eval1]:4:5
```

## 实际栈 B：调用原始 DexNative 后的 JVM 失败

条件：将原始 DEX 转成 JVM JAR，保留原始 assets；在诊断用 stubs 副本中排除参考项目的 `DexNative` 占位类，使原包真实 `DexNative` 执行。产品中的预检保持不变。此实验使用 Windows x64 的 Temurin 17.0.20.1 JVM。

原包 `DexNative.<clinit>` 会将所选 `.so` 解压为随机名称再调用 `System.load()`。本次缓存名 `.wexfnw463ixookf8` 的 SHA256 为 `0614b7b18ca30b41450fed4dd3ed9150cea1c94dc62960e4151a3a87d43a1b5e`，与原包条目 `assets/wexguard_v7.so` 完全一致。因此本次真正尝试加载的库可以明确对应到该文件，不能仅根据 Windows 位数猜测。

进程退出码：`1`；标准输出为空。原始 stderr（只做路径去标识）：

```text
OpenJDK 64-Bit Server VM warning: Options -Xverify:none and -noverify were deprecated in JDK 13 and will likely be removed in a future release.
[NetPanSpiderRunner] java.lang.ExceptionInInitializerError: null
java.lang.ExceptionInInitializerError
	at com.github.catvod.spider.Init.init(Unknown Source)
	at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)
	at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke(Unknown Source)
	at java.base/jdk.internal.reflect.DelegatingMethodAccessorImpl.invoke(Unknown Source)
	at java.base/java.lang.reflect.Method.invoke(Unknown Source)
	at NetPanSpiderRunner.initializeContextClass(NetPanSpiderRunner.java:120)
	at NetPanSpiderRunner.initializeGlobalSpiderState(NetPanSpiderRunner.java:107)
	at NetPanSpiderRunner.main(NetPanSpiderRunner.java:48)
Caused by: java.lang.RuntimeException: java.lang.UnsatisfiedLinkError: <temp>\netpan-spider-windows-research\guard-host-cache\cache\.wexfnw463ixookf8: Can't load this .dll (machine code=0x34) on a AMD 64-bit platform
	at com.github.catvod.spider.DexNative.<clinit>(Unknown Source)
	... 8 more
Caused by: java.lang.UnsatisfiedLinkError: <temp>\netpan-spider-windows-research\guard-host-cache\cache\.wexfnw463ixookf8: Can't load this .dll (machine code=0x34) on a AMD 64-bit platform
	at java.base/jdk.internal.loader.NativeLibraries.load(Native Method)
	at java.base/jdk.internal.loader.NativeLibraries$NativeLibraryImpl.open(Unknown Source)
	at java.base/jdk.internal.loader.NativeLibraries.loadLibrary(Unknown Source)
	at java.base/jdk.internal.loader.NativeLibraries.loadLibrary(Unknown Source)
	at java.base/java.lang.ClassLoader.loadLibrary(Unknown Source)
	at java.base/java.lang.Runtime.load0(Unknown Source)
	at java.base/java.lang.System.load(Unknown Source)
	... 9 more
```

## 结论与未到达阶段

产品首先因原始包含 `assets/wexguard_v7.so`、`assets/wexguard_v8.so` 而拒绝；独立实验进一步证明，调用原始加载器时在 `DexNative.<clinit> → System.load` 失败。第二层 `libwex_*` 和本地代理依赖也尚未接通。取消预检不等于修复兼容。

本次未进入真实业务搜索，详情、媒体解析、实际下载均未到达；未把配置导入、DEX 转换、原生入口探针或进程退出码当作兼容成功。

[完整机器可读证据](evidence/type3-native-rejection-2026-11-20.json)
