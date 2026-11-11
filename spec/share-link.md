# 外链分享规范（v1）

Android（Kotlin）和网页版（TypeScript）共同遵守。改动时同时更新 `test-vectors/share-link.json`，两端测试都要通过。

## 0. 目标与原则

- 像谷歌相册的“创建链接”：选几张照片 → 生成一条链接和一个密码 → 对方用浏览器打开，输入密码就能看，不需要账号、不需要装 App。
- **只拿到链接、或者只知道密码，都打不开。** 链接里的随机片段和密码一起才能算出钥匙。
- **主密钥（MK）、包裹密钥（K_wrap）、解锁密码永远不离开本人设备。** 每条链接一把新钥匙，只能打开这条链接里的照片。照片密文不重新加密，只把每张照片的 DEK 用这把钥匙另包一份。
- 没有自建服务器。网盘上公开的只有密文；链接 `#` 后面的部分浏览器不会发给任何服务器（包括网盘和网页版所在的服务器）。
- 不和某个网站绑死：链接格式就是本文件。默认用 `https://photo.zyll.top/s` 打开；换域名或自己搭网页版，同一条链接（`#` 后面的部分）照样能打开。
- 只能分享**端到端加密**的备份（没开加密的库不能创建外链）。Google 账号要开着分享功能、照片已经在可见文件夹里（`appDataFolder` 里的文件不能公开）。

## 1. 链接

```
https://photo.zyll.top/s#1.<p>.<loc>.<secret>
```

| 字段 | 说明 |
| --- | --- |
| `1` | 链接格式版本 |
| `p` | `g` = Google 网盘，`o` = OneDrive |
| `loc` | 清单文件的位置。Google：文件 id；OneDrive：清单匿名分享链接（`webUrl`）的 base64url（无填充） |
| `secret` | 32 字节随机数 `S` 的 base64url（无填充，43 个字符） |

四段用 `.` 分隔；`loc` 和 `secret` 里不会出现 `.`。解析失败一律提示“链接不完整”，不猜。

## 2. 钥匙

```
salt   = SHA-256(UTF-8("zyll-link/v1/salt") || S) 的前 16 字节
pw     = Argon2id(NFC(密码) 的 UTF-8, salt, m = 65536 KiB, t = 3, p = 1, 32 字节)
K_link = HKDF-SHA256(ikm = S || pw, salt = 空, info = UTF-8("zyll/v1/link-wrap"), 32)
```

- 密码至少 8 个字符（按 Unicode 码点数，NFC 之后），App 在创建时检查。Argon2id 参数固定，不写进链接或清单。
- 打开时密码错误的表现：清单的 ZYLC 头部解不开（GCM 校验失败）。只提示“密码不正确”，不区分别的原因。
- 网页上的“重试次数限制”拦不住下载了清单、在自己电脑上试密码的人，真正起作用的是密码强度和 Argon2id 的成本。界面要提示：密码要和链接分开发。

## 3. 清单

清单是一个 ZYLC 文件（kind = 5），包裹密钥用 `K_link`（用法和 K_wrap 一样），明文是 UTF-8 JSON：

```json
{
  "format": "zyll-link", "version": 1,
  "id": "<32 位小写十六进制>",
  "title": "周末去海边",
  "created": 1730000000000,
  "expires": 1730604800000,
  "originals": true,
  "items": [
    { "n": "IMG_0001.jpg", "m": "image/jpeg", "t": 1729990000000, "s": 3456789, "mo": false,
      "f": "<原图位置>", "dk": "<原图 DEK b64>",
      "tf": "<缩略图位置>", "tk": "<缩略图 DEK b64>" }
  ]
}
```

- `expires`：毫秒时间戳；`null` = 永久。
- `originals`：`false` 时网页版不显示“下载原图”按钮。**这只是界面上的限制**：能看大图的人就能截图或从浏览器里取出图片，创建时界面要说明这一点。
- 位置（`f`、`tf`）：Google 是文件 id；OneDrive 是这个文件匿名只读分享链接的 `webUrl`。
- `dk` / `tk` 是照片 DEK 的原始 32 字节（标准 base64）。用法同共享相册（sharing.md 4.2）：直接解密 ZYLC，块校验照常生效，文件头被改过同样会失败。
- `tf` / `tk` 可以为空字符串（没有缩略图时网页用原图缩小显示）。
- `p`（可选）：这张照片在另一个账号里时写 `g` 或 `o`；不写就是清单所在的账号。一条链接可以同时带 Google 和 OneDrive 里的照片。
- 一条链接最多 500 张。

清单放在 `共享/links/<id>.zylc`（Google 在 “Zyll 相册/共享/links/”，OneDrive 在应用文件夹的 “共享/links/”）。

## 4. 公开与撤销

创建（App）：

1. 对每张照片读 ZYLC 头部，用 K_wrap 解出 DEK（原图、缩略图各一次），写进清单。
2. 上传清单。
3. 把清单、每张照片的原图和缩略图设成“知道链接的人可以查看”：
   - Google：`permissions.create`，`{"type":"anyone","role":"reader","allowFileDiscovery":false}`，记下返回的权限 id。
   - OneDrive：`POST /items/{id}/createLink`，`{"type":"view","scope":"anonymous"}`，记下返回的权限 id 和 `link.webUrl`。
     工作或学校账号可能被管理员关掉了匿名链接（返回 403 / `notAllowed`）：整条链接创建失败，提示“这个账号不能创建外链”。
4. 任何一步失败：撤掉这次已经加上的公开权限、删掉清单，整条链接不生效。

撤销（用户点“撤销”、到期、清空全部数据之前）：

1. 删掉清单。
2. 逐个撤掉文件上的公开权限。同一个文件还在别的有效链接里时不撤。
3. 删不掉、撤不掉的记下来，下次接着撤；撤完之前这条链接在列表里显示“撤销中”。

对方以前已经看过、下载过的照片收不回来，界面上要明说。

**到期**：没有服务器，靠创建者的设备到时间撤销。App 用定时任务在 `expires` 到了时撤销；手机长时间关机、或者 App 被卸载时，会晚一些才撤。网页版看到 `expires` 已过就不显示照片（只是界面限制）。同一个库的其他设备（见第 5 节的列表）也会帮忙撤。

## 5. 链接列表

本人的全部链接记在 `vault/share-links.zylc`（ZYLC kind = 5，K_wrap 加密；属于固定文件，搬存储位置时跟着走）：

```json
{ "format": "zyll-share-links", "version": 1,
  "links": [
    { "id": "…", "provider": "google|onedrive", "manifest": "<清单文件 id>", "loc": "<链接里的 loc>", "secret": "<S b64url>",
      "title": "…", "created": 0, "expires": null, "originals": true, "count": 12,
      "files": [ { "id": "<文件 id>", "perm": "<公开权限 id>", "url": "<OneDrive webUrl，Google 为空>" } ],
      "revoked": 0 } ] }
```

- 合并：按 `id` 取并集；同一条两边都有时，`revoked` 非 0 的那份为准，否则取 `files` 多的那份。
- 撤销完成后保留记录 30 天（`revoked` = 完成时间），防止别的设备把它合并回来；之后删掉。
- 密码不存在任何地方。列表里有 `secret`，所以本人以后还能复制同一条链接，但仍然要记住密码。

## 6. 网页版打开链接

1. 从 `location.hash` 解析链接；马上用 `history.replaceState` 去掉 `#` 部分，免得留在浏览器历史和截图里。
2. 下载清单：
   - Google：`GET https://www.googleapis.com/drive/v3/files/<id>?alt=media&key=<API key>`。API key 只在网页版的构建配置里，限制只能从网页版域名调用。
   - OneDrive：`GET https://api.onedrive.com/v1.0/shares/u!<base64url(webUrl)>/root/content`（匿名）。**待实测**；不行的话改用 `createLink` 返回的直接下载地址，规范随之修改。
3. 让用户输入密码，在 Worker 里跑 Argon2id，解开清单。
4. 检查 `format`、`version`、`expires`；按 `items` 显示网格，照片按需下载、用 `dk` / `tk` 解密，只放在内存里。
5. 不需要登录，不读写任何本地存储（不记密码、不缓存照片）。

## 7. 待实测

- OneDrive 匿名链接能不能在浏览器里不登录直接下载（带 CORS）。
- Google “anyone” 权限 + API key 下载 `drive.file` 创建的文件。
- 工作 / 学校 OneDrive 账号的匿名链接限制提示。
