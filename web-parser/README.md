# NetPan Parser Web

这是桌面应用的隔离 Web Parser 项目，只做安全的链接元数据解析。

## 边界

- 默认模式：`PURE_PARSER`
- 提供：`POST /api/web/parse`
- 禁止：公网执行 `yt-dlp`
- 禁止：云端下载代理
- 禁止：调用桌面端 `/api/downloads/*`、`/api/download-engine/*`

## 本地运行

```bash
cd web-parser
npm run dev
```

前端默认运行在 `http://127.0.0.1:5183`，后端默认运行在 `http://127.0.0.1:5190`。

## 部署建议

公网部署时保持 `WEB_PARSER_MODE=PURE_PARSER`。如果未来需要媒体直链解析，应单独部署受保护的私有服务或队列 worker，不要在公网 Web 服务中直接执行。
