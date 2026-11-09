# Zyll 相册 · 网页版

Zyll 相册的网页端：在电脑浏览器里查看、上传、下载手机 Zyll 备份到**你自己的** Google 网盘 / OneDrive 里的照片。
纯静态页面，部署在 GitHub Pages，没有任何自建服务器。端到端加密的照片只在浏览器里解密，网盘服务商看不到内容。

在线地址：<https://gaomou88.github.io/Zyll-photo-web/>

## 能做什么

- 连接 Google 网盘、OneDrive（可以同时连多个账号，照片合在一起显示，同一张照片只显示一次）
- 用手机上设置的端到端加密密码（或恢复密钥）解锁；闲置后自动锁上
- 按天分组的照片墙、相簿、视频；大图查看（左右键切换、详细信息）
- 视频边下边播（加密视频由 Service Worker 按块解密）；HEIC 照片在浏览器里转码显示
- 上传：选择文件或直接拖进窗口，按账号的加密设置加密后上传，内容相同的照片自动跳过
- 下载：单张直接存；多张打包成 zip（Chrome / Edge 边下边写，不占满内存）
- 从网盘删除（同一张照片在所有已连接账号里的备份一起删）

不做：自动备份、AI 搜索和修图（这些在手机上用）。共享相册的网页端正在开发。

## 和手机端的约定

网页版读写的是手机端同一份网盘数据，格式见 [`spec/`](spec/)：

- 目录布局、备份目录（index）字段和合并规则：`spec/vault-layout.md`。网页版写目录时先重新读、合并，`seq + 1` 后整份写回，
  不改别的设备写的条目、`mode` 和 `settings`；只能写明文目录时不写加密条目；目录比上次见过的旧（被还原过）时只读。
- 加密容器和密钥包：`spec/crypto-format.md`、`spec/keybundle.md`。
- Google 的存放位置（隐藏区 / My Drive 的“Zyll 相册”）和 `storage.json` 标记：`spec/sharing.md` 第 7 节。手机搬迁期间网页版只读。
- 网页上传的条目 `d` 是 `web-<随机 UUID>`（每个浏览器一个）。

`packages/crypto/` 和 `spec/` 是从 [gaomou88/zyll-gallery](https://github.com/gaomou88/zyll-gallery) 复制过来的，那边改了要同步过来
（测试会跑同一套互验向量）。

## 部署配置

1. **Google Cloud**（安卓版用的**同一个项目**，否则读不到手机的备份）：凭据 → 创建 OAuth 客户端 → 类型“网页应用”，
   - 已获授权的 JavaScript 来源：`https://gaomou88.github.io`
   - 已获授权的重定向 URI：`https://gaomou88.github.io/Zyll-photo-web/auth-callback.html`
   - 数据访问里确认有 `drive.appdata`、`drive.file`。
2. **Microsoft Entra**（安卓版用的**同一个应用注册**）：身份验证 → 添加平台 → 单页应用程序，
   重定向 URI 填 `https://gaomou88.github.io/Zyll-photo-web/auth-callback.html`。
3. 本仓库 Settings → Secrets and variables → Actions，添加 `ZYLL_GOOGLE_WEB_CLIENT_ID`（第 1 步的客户端 ID）和
   `ZYLL_ONEDRIVE_CLIENT_ID`（Entra 应用的“应用程序(客户端) ID”）。
4. Settings → Pages → Source 选 **GitHub Actions**。推送到 `main` 后自动部署。

## 本地开发

```bash
pnpm install
pnpm dev          # http://localhost:5173/?demo 用内存里的模拟网盘试界面（密码 test1234）
pnpm test         # 网页逻辑 + 加密库互验向量
pnpm typecheck
pnpm build
```

本地连真实网盘：在 `.env.local` 里写 `VITE_GOOGLE_CLIENT_ID=…`、`VITE_ONEDRIVE_CLIENT_ID=…`，并在两边的重定向 URI 里加上
`http://localhost:5173/auth-callback.html`。

## 许可证

GPL-3.0，见 [LICENSE](LICENSE)。
