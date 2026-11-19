# Windows Type3 兼容性与端到端验收

更新日期：2026-11-20。此报告区分“配置导入”“运行时执行”和“实际下载”。本轮接入了 JavaScript、标准 JVM JAR、纯 DEX 转 JVM 三条路径；**王二小 newwex 的加固 Android csp Spider 尚未完成兼容**，不能称为所有 Type3 源均可用。

## 当前窗口接管核查

用户实际打开的程序 app.asar SHA256 为 `9ebb461cf9238cc93acedffd2d7ebf3040bb552f5d4e33e9e39663cb79ecc082`，与最新构建完全相同。当前站点为「贱片┃秒播」`csp_WexAiJianPianGuard`，配置为 newwex，搜索词「<user-query>」。界面原生库报错已实际观察到；不是旧版本、JSON 扩展名或导入位置的问题。

本轮在独立研究目录将原包转换为 JVM，并保留原始 assets，实际调用同一 Guard。参考 stubs 中的 DexNative 占位实现会使内部 Spider 为 null；排除该占位、调用原包真实 DexNative 后，JVM 在 System.load 明确抛出 `UnsatisfiedLinkError: Can't load this .dll (machine code=0x34) on a AMD 64-bit platform`。因此直接取消产品中的 .so 检查仍不能让该源工作。

第二层 ARM 库的 helloJNI 和 contains 已在独立 Unicorn 探针中实际执行，但尚未接入 JVM/JNI 桥，也没有通过该站点的搜索、详情、地址解析或下载。没有将 native 方法改成固定值作为产品替代。本轮未更换用户程序、删除源、修改系统设置或修改产品运行逻辑。证据：[当前窗口与原始 Guard 诊断](evidence/jianpian-takeover-2026-11-20.json)。

贱片业务类的搜索会调用 LoadNiMa.contains 过滤结果；全局初始化还依赖 GoProxy、本地 8964–9998 端口服务（回退 9978）与本地媒体接口。只解出业务 DEX、或仅替换一处 DLL 加载，都不能认定完成兼容。

当前请求默认域名 ev5356.970xw.com 及旧候选 wangerniu.cqxkn.com 的真实搜索接口均未通过 DNS，没有取得 HTTP 状态码或搜索 JSON。该源会通过 AliDNS TXT 动态发现域名；本轮未完成全部动态候选验证，因此不据此宣称整个源站已失效。原始 Guard 的 ARM 加载失败发生在域名发现和搜索之前，是当前程序的首个实际阻断。

## 已实现和未实现

| 运行方式 | 已实现 | 尚未实现或限制 |
| --- | --- | --- |
| JavaScript / drpy | 独立子进程；ES Module 默认/命名导出、CommonJS、全局函数；init/home/search/detail/play；CatVod 方法别名；req/request、cheerio、CryptoJS、pdfh/pdfa/pd；相对模块预取和缓存；可加载配置给出的 drpy2 引擎和 ext 规则 | 裸 var rule 不自带 drpy 引擎；不能承诺任意 drpy 分支和 Android 专用接口。15 秒执行、1.5MB 结果限制；当前斗鱼规则仍有 eval 上下文问题 |
| 标准 JVM .class JAR | 内置 JRE、独立 Java Runner；init 多种签名；homeContent/searchContent/detailContent/playerContent；中文 flags；资源文件、MD5 校验、SHA256 缓存；完整 provider 与下载接线 | 缺少的第三方依赖和 Android API 仍可能导致特定站点失败；不等于完整 Android 环境 |
| Android DEX/JAR 的普通 csp | 检测 DEX，dex2jar 转换，保留 assets/资源，再由 JVM Runner 调用；纯 DEX 四阶段实网验收通过 | DEX 转 JVM 存在转换差异；Android 桩不是 ART；部分混淆/R8 结构和序列化行为尚不兼容 |
| Android ARM 原生/加固 csp | 识别包含 .so 的包，界面返回明确不支持原因 | 未集成 ARM JNI、ART、加固类加载器和 Android 本地代理。当前 newwex 原包在此处失败 |
| 解析与下载 | Type3 playerContent 返回 URL/headers 后接 MP4 aria2 或 HLS；parse=1/jx=1 交给隐藏 Chromium 抓媒体；请求头进入清单、分片、密钥下载；独立解析 API | 网页需要人机验证、DRM、直播及外置音轨未兼容；隐藏网页解析不是所有解析站的通用保证 |

脚本子进程和 VM 用于生命周期及超时管理，不能称为安全沙盒。为兼容 drpy 的模板与规则，允许字符串 eval。JVM 插件同样属于用户选择执行的源代码。

## 真实搜索、详情、地址解析与下载

验收脚本为 `tests/e2e/type3LiveSmoke.mjs`，JS 规则和 Java 源码位于 `tests/fixtures/type3/`。`node scripts/prepare-type3-test-fixtures.mjs` 编译 NASA JAR/DEX 并输出三个 QA 环境变量。使用**本项目自写验收源**请求 NASA 公共 API，不是预置固定影视列表，也不是王二小站点。NASA API 文档：https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf 。

JavaScript 规则通过 HTTP 配置中的 api URL 导入；JVM/DEX 自写夹具通过受信目录的内部 QA 覆盖提供，不从网页接受本地路径。DEX 路径实际经过 dex2jar。每个运行方式使用新建的独立下载目录，避免已有文件或续传造成假通过。

联网 UI 验收需要 Playwright；可通过 NETPAN_PLAYWRIGHT_MODULE 指向已安装包的 index.mjs。生成 Java 夹具后，将脚本输出的 NETPAN_TYPE3_TRUSTED_JAR_ROOT、NETPAN_QA_JVM_JAR、NETPAN_QA_DEX_JAR 设置为环境变量，再运行联网脚本。验收启动的应用清除外部 JAVA_HOME、Java 根目录和 FFmpeg 覆盖，并将 PATH 缩到 Windows 系统目录；实际程序仍使用包内运行时。夹具和诊断目录由脚本保留供复核。

| 验收方式 | 搜索 | 详情 | 播放解析 | 下载与媒体检查 |
| --- | --- | --- | --- | --- |
| JavaScript | 实时搜索 Artemis，非空 1 条 | ID/title 匹配 Artemis Origins | NASA asset API 返回 HTTPS preview.mp4 | 独立文件 6,797,356 字节；FFmpeg 实际解码通过；从 UI 点击解析并下载 |
| 标准 JVM JAR | 同一实时搜索，非空 1 条 | 匹配同一 NASA ID | 实际执行 playerContent 获得媒体 URL | 独立文件 6,797,356 字节；FFmpeg 解码通过 |
| 纯 DEX 转 JVM | 同一实时搜索，非空 1 条 | 匹配同一 NASA ID | 转换后 Spider 实际执行 playerContent | 独立文件 6,797,356 字节；FFmpeg 解码通过 |
| 原始 newwex 加固 csp | 失败：type3_java_native_unsupported | 未到达 | 未到达 | 未到达 |

上述三条 NASA 路径验证的是应用执行、网络和下载链路，不证明第三方社区源全面兼容。最终便携包复测证据另见本报告末尾。

真实 `drpy2.min.js + 虎牙.js` 的 home 已返回 4 个分类和 4 个筛选分组。虎牙搜索仍失败：规则使用 response.3.docs，上游本次数据在 response.1.docs；空对象按失败处理。斗鱼搜索目前在规则 eval 中报 input.split 的 TypeError，仍有局部上下文兼容问题，也未计作兼容成功。首页分类成功只算首页调用成功；原配置中的代理 URL 能否获取脚本，由便携包联网诊断另外记录。

便携包已用饭太硬原配置中的 ghproxy.net API/ext 地址实际调用：导入 49 站点，虎牙 home 调用成功（首页样本影片 0），搜索返回 type3_js_empty_result。未静默改写成其它脚本地址。

隐藏 Chromium 的 parse=1 专项夹具从 W3Schools HTML 视频示例页取得真实媒体 URL，下载 788,493 字节并解码通过。另一专项夹具通过 Type3 play 返回 Mux 公开 HLS 测试流，实际下载、合并得到 10,867,100 字节 MP4，解码通过。这两个属于解析/下载链路夹具，不是社区影视源搜索成功的证明。

## 原始配置和原生研究结果

配置加载请求使用 okhttp User-Agent。饭太硬 `/tv` 本次返回图片包裹、尾部标记与 Base64 JSON；加载器已识别此格式，不要求 URL 以 .json 结尾。王二小 `https://9280.kstore.vip/newwex.json` 返回 100 个 type=3 的 csp_*Guard 站点。保存这些配置不代表能运行它们。

newwex Spider 原包 MD5 为 5a934007fb34ec762c2e7d25dbdc865d，与配置一致；包含 classes.dex、ARM32/ARM64 wexguard 原生库和加密 .guard。研究目录自写 Unicorn 探针实际执行外层 ELF/JNI，生成 CRC 正确的业务 ZIP，SHA256 为 6644bed20cf19aac6003726da48d6124497840b1e09ad52b97b8c5a8764023f3。这只证明外层载荷可解出，不是 Spider 端到端运行成功。业务包仍有 1193 个 DEX 类、第二层原生库及 27 个原生方法。

继续研究的实际阻断：

- 修补 Activity.checkSelfPermission 等桌面桩后，InitOrigin 可继续执行，但仍尝试连接 Android 端本地代理。
- AiNewHuaJuan 的真实请求遇到超时/EOF 和代理栈问题。
- WexAiDuBoKu 的原始 API 本次确实返回有效记录，但转换后的 Spider 序列化路径最终返回 {}。不能把它描述为“上游没有结果”。
- 研究中用于隔离原生过滤的 shadow 类未进入产品，也不作为兼容成功证据；ARM JNI 和代理依赖仍未实现。

研究目录：`<temp>/netpan-spider-windows-research`。保留 ELF 探针、DEX/JVM 转换和搜索诊断资料。临时目录可能被系统清理，能力结论以此报告为准。

## 参考项目和分发依赖

- [FreeBox SpiderJarLoader](https://github.com/kknifer7/FreeBox/blob/main/src/main/java/io/knifer/freebox/spider/SpiderJarLoader.java)：标准 JVM 加载器检查到 DEX 会拒绝，不能由其 JAR 支持推断 Android DEX 全兼容。未复制其 GPL 解析器代码。
- [Meow drpy](https://github.com/upchr/meow/blob/main/server/drpy/README.md) 和 [Dex2Jvm](https://github.com/upchr/meow/blob/main/server/host/src/shared/core/Dex2Jvm.java)：参考进程桥和模块宿主设计；原生包被区别处理。未复制其非商业许可解析代码。
- [TVBoxPC JVM bridge](https://github.com/1577967449/TVBoxPC/blob/master/Core/Jar/JvmBridge.cs)：本项目自写 Runner，分发其发布运行时中的 Android 桩、JRE、dex2jar 和库，并携带各许可。Android 桩附有独立 MIT 声明。

`prepare-type3-java.ps1` 校验 TVBoxPC v1.8.1 ZIP 的 SHA256：9E067163D60AD677BD85028D32DCE31B870C5F40DAA5DC07D74311604BBAC4E0。便携包通过 extraResources 包含 JVM 运行时，使用者不需另装 Java。实验 Python/Unicorn 没有打入产品。

## 发布验证

预发布门禁已通过：前后端与 Electron TypeScript、构建确定性、既有发布回归、9 项源配置回归、12 项 Type3 调用与 provider 集成回归、20 项 HLS 回归。Type3 包含真实编译的 JVM 和 DEX 夹具，发布门禁不允许缺少运行时后跳过它们。最后补充的 body&&.item 多层选择器断言及服务器编译也已通过。

最终便携包：`release/NetPanDownload-0.1.0-windows-x64.exe`，227,857,635 字节。

SHA256：`06616cbc221027d807acd512ac6258f4007c526a97c2548e458f673c85fe0b69`。同目录附有 `.exe.sha256` 校验文件。

最终 EXE 实测证据：[Type3 JSON 报告](evidence/type3-2026-11-20.json)。三条 NASA 路径各在独立目录得到 6,797,356 字节文件，记录了不同 gid 和实际完成字节数；网页解析 788,493 字节、HLS 10,867,100 字节均解码通过。原始 newwex 和饭太硬虎牙的失败结果也保留在报告中。原始媒体留在 `<temp>/netpan-type3-live-llG94j/downloaded`。

最终构建的 win-unpacked 应用还通过了原有 MacCMS UI 回归，包括导入、搜索、详情、MP4/HLS、HLS 暂停/恢复、手动 m3u8 和跨源 API 拒绝。媒体为自写目录指向的公开测试流，MP4 1,128,375 字节，HLS 合并文件 10,867,100 字节，ffprobe 与 FFmpeg 解码通过；证据为 [Type1 JSON 报告](evidence/type1-2026-11-20.json)，原始目录 `<temp>/netpan-tvbox-smoke-9dkT54`。

公开仓库中的证据已去除本机绝对路径和用户实际搜索词；原始诊断文件保留在本地。

GitHub 同步说明：本次代码已整理到最新 main 的基础上，并重新通过完整预发布检查。上述 EXE 校验和与实网记录对应此前已验收的本地便携包，不表示已经为本次同步提交重新发布 EXE；分支上的 GitHub Actions 会另行构建代码产物。
