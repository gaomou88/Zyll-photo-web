# 共享相册规范（v1，测试分支）

Android（Kotlin）和网页版（TypeScript）共同遵守。改动时同时更新 `test-vectors/sharing.json`，两端测试都要通过。

## 0. 目标与原则

- 把某个相册共享给别人，对方用自己的 Zyll（安卓或网页版）打开。
- **主密钥（MK）和包裹密钥（K_wrap）永远不离开本人设备。** 分享出去的只有“相册钥匙”，它只能打开这一个相册。
- 照片密文不重新加密。只把每张照片的 DEK 用相册钥匙另存一份（写在加密的相册目录里）。
- 没有自建服务器。访问控制分两层：网盘权限决定“谁能读、谁能写这个文件夹”，签名决定“哪些成员、哪个目录是可信的”。
- 第一版只支持同一家网盘内共享（Google 分享给 Google 账号，OneDrive 分享给 Microsoft 账号）。

## 1. 原语（新增）

| 用途 | 算法 | 备注 |
| --- | --- | --- |
| 密钥协商 | X25519（RFC 7748） | WebCrypto 原生支持；Android 用 Bouncy Castle |
| 签名 | Ed25519（RFC 8032） | 同上 |
| 其余 | 沿用 crypto-format.md：HKDF-SHA256、AES-256-GCM、SHA-256 | |

公钥、私钥都是 32 字节原始字节，JSON 里用标准 base64（带 `=`）。

## 2. 身份密钥（每个库一套）

每个库第一次用到共享时生成：

- `xPriv/xPub`：X25519，用来接收相册钥匙；
- `edPriv/edPub`：Ed25519，用来给相册清单签名。

私钥保存在网盘 `vault/identity.zylc`（ZYLC，kind=5，用本库 K_wrap 加密），这样同一个库的其他手机和网页版解锁后都能拿到。明文是 JSON：

```json
{ "format": "zyll-identity", "version": 1, "x": "<xPriv b64>", "ed": "<edPriv b64>", "created": 1730000000000 }
```

公钥由私钥算出，不单独存。

### 2.1 指纹与安全码

```
fp       = SHA-256(UTF-8("zyll-share-id/v1") || xPub || edPub)
fpHex    = 小写十六进制(fp)                 # 程序内部用作成员 id
安全码    = fp 前 10 字节的 Base32（RFC 4648 大写无填充，16 个字符），每 4 个一组用空格分隔
```

双方当面或打电话核对安全码，防止网盘或聊天渠道里的人调包公钥。

### 2.2 分享名片

想接收共享的人把名片发给对方（二维码或链接）：

```json
{ "format": "zyll-share-card", "version": 1, "provider": "google|onedrive", "email": "a@example.com", "x": "<xPub b64>", "ed": "<edPub b64>" }
```

链接形式：`https://<网页版域名>/#card=<base64url(名片 JSON)>`，App 内扫码同样解析 `card=` 后的部分。

## 3. 相册钥匙

- `AK`：32 字节随机数，每个共享相册一把；撤销成员时整把换掉（`epoch + 1`）。
- 相册包裹密钥：`K_album = HKDF-SHA256(ikm = AK, salt = 空, info = UTF-8("zyll/v1/album-wrap|" + albumId), 32)`。
  它的用法和 K_wrap 完全一样：作为 ZYLC 的包裹密钥，用来加密相册目录和成员新上传的照片。

### 3.1 把相册钥匙封装给某个成员（sealed box）

```
eph        = 新随机 X25519 私钥；ephPub = 对应公钥
ss         = X25519(eph, 成员 xPub)                  # 全 0 结果必须拒绝
k          = HKDF-SHA256(ikm = ss, salt = ephPub || 成员 xPub, info = UTF-8("zyll/v1/share-seal"), 32)
nonce      = 12 字节随机
aad        = UTF-8("zyll-share/v1|" + albumId + "|" + epoch + "|" + 成员 fpHex)
ct         = AES-256-GCM(k, nonce, AK, aad)          # 32 + 16 字节
```

记作 `{ "epk": ephPub, "nonce": nonce, "ct": ct }`（都是 base64）。打开时用自己的 xPriv 重算 `ss`，GCM 校验失败即“不是给我的或被改过”。

## 4. 网盘里的共享相册文件夹

```
Zyll 相册/共享/<albumId>/            # albumId：UUID v4；文件夹带 appProperties.zyllShared = albumId
├─ album.json                        # 签名的相册清单（明文，只有公钥和封装后的钥匙）
├─ index.zylc                        # kind=3，用 K_album 加密的相册目录
└─ adds/<成员 fpHex>-<seq>.zylc       # kind=4，“可添加”成员提交的新照片，等主人或管理者合并
```

照片密文本身（原图、缩略图）留在原来的位置，按文件单独授权给成员。成员上传的新照片放在共享文件夹里，用 K_album 加密。

### 4.1 `album.json`

```json
{ "format": "zyll-shared-album", "version": 1, "body": "<base64(清单 JSON 的 UTF-8 字节)>", "by": "<签名者 fpHex>", "sig": "<base64 Ed25519 签名>" }
```

签名对象是 `UTF-8("zyll-shared-album/v1|") || body 解码后的字节`。直接签原始字节，不需要两端做 JSON 规范化。

清单 body：

```json
{
  "albumId": "…", "seq": 7, "epoch": 2,
  "owner": { "x": "<b64>", "ed": "<b64>", "email": "owner@example.com" },
  "members": [
    { "x": "<b64>", "ed": "<b64>", "email": "b@example.com", "role": "viewer|contributor|manager", "since": 1730000000000 }
  ],
  "keys": { "<fpHex>": { "epk": "…", "nonce": "…", "ct": "…" } },
  "index": { "sha256": "<index.zylc 全文件的 SHA-256 十六进制>", "seq": 12 },
  "opts": { "originals": true }
}
```

- `keys` 里只放当前 `epoch` 的封装，主人自己也有一份。
- `opts.originals = false` 时，目录里不给成员原图的 DEK，只给缩略图和预览图（“只能看预览”）。
- 读清单时必须检查：签名有效；签名者是主人，或者是本清单里 `role = manager` 的成员；`seq` 不小于本机上次见过的值（防回滚）；`albumId` 和文件夹的一致。任一不通过就拒绝，并提示“相册清单被改动过”。
- `index.sha256` 不一致时不读目录（防止有写权限的成员偷偷替换目录）。

### 4.2 相册目录 `index.zylc`

用 K_album 加密的 ZYLC（kind=3），明文 JSON，字段沿用 vault-layout.md 的备份目录：

```json
{ "v": 1, "seq": 12, "name": "相册名", "cover": "<r>",
  "items": [ { "r": "…", "n": "…", "m": "…", "t": 0, "s": 0, "h": "…", "th": "…", "dk": "<原图 DEK b64>", "tk": "<缩略图 DEK b64>", "by": "<添加者 fpHex>" } ],
  "del": ["<r>"] }
```

- `dk` / `tk` 是照片 DEK 的原始 32 字节。成员用它们直接解密 ZYLC 文件，不需要文件头里的 wrappedDek（那是用主人 K_wrap 包的）。
  ZYLC 的块校验仍然生效：头部的 SHA-256 参与每块的 AAD，文件头被改动也会解密失败。
- `opts.originals = false` 时不写 `dk`。
- 只有主人和管理者写 `index.zylc`，每次写完都要更新并重新签名 `album.json`（`index.sha256`、`index.seq`、`seq + 1`）。

### 4.3 新增照片（`adds/`）

“可添加”成员上传照片时：原图和缩略图用 K_album 加密，放进共享文件夹；再写一个 `adds/<自己 fpHex>-<seq>.zylc`（K_album 加密，kind=4），内容为 `{ "items": [ … ] }`，字段同 4.2。
主人或管理者的设备看到后合并进 `index.zylc`，然后删掉这个文件。

## 5. 三档权限

| 角色 | 网盘权限 | App 内能做的 |
| --- | --- | --- |
| viewer（仅查看） | 读者 | 浏览、下载（`opts.originals` 允许时下原图） |
| contributor（可添加） | 编辑者 | 再加上：上传照片、删自己加的照片 |
| manager（可管理） | 编辑者 | 再加上：删任何照片、邀请和移除成员、改权限（签名清单） |

网盘本身分不出“可添加”和“可管理”，这两档靠签名区分：只有主人和管理者签的清单、清单里登记过的目录才会被读取。

## 6. 撤销与改权限

移除成员或从可写降为只读时：

1. 撤掉对方在网盘上的权限（共享文件夹和逐个授权的照片文件）；
2. `epoch + 1`，生成新的 AK，只封装给剩下的成员；
3. 用新的 K_album 重写 `index.zylc`，签名新清单。

被移除的人无法读取新目录和之后新加的照片。他以前已经下载过的照片收不回来，界面上要明说这一点。

## 7. 存储位置（Google）

- 设置项“分享功能”：关闭时库放在 `appDataFolder`（隐藏区，不能共享）；开启时整个库搬到 My Drive 下的可见文件夹 `Zyll 相册/`（`drive.file` 权限，文件夹带 `appProperties.zyllRoot = "1"`，新设备据此找到它）。
- 搬迁只复制密文（下载后原样上传，不解密），在当地时间 0:00–6:00、充电中、连着不计流量的网络（WiFi）、手机空闲（WorkManager `setRequiresDeviceIdle`）时进行，任一条件中途消失就暂停，下次满足时接着搬，可分多晚完成。
- 条件不满足就一直等，不催用户，也不提供“立即搬迁”。
- 搬迁开始前可以改回去；一旦开始，开关锁定，直到搬完才能再改。搬完后改回另一边，就按同样的规则反向再搬一次。
- 别的设备靠存放位置根目录下的 `storage.json` 标记：`{"format":"zyll-storage","version":1,"state":"migrating|moved","to":"visible|hidden","at":毫秒,"device":设备 id}`。
  看到 `migrating` 的设备不开始新的上传，但已经传完的文件照常写记录，备份目录（index）仍然写进旧位置，搬的设备合并旧目录时会带过去；
  搬的设备每 10 分钟刷新一次 `at` 作心跳，`at` 超过 3 天没变时，别的设备提示用户并允许“不再等它”（只在本机记下这份标记的 `at`，`at` 变了就重新等）；看到 `moved` 的设备切到新位置，按“换手机”的流程从那里找回备份目录。可见位置的根文件夹带 `appProperties.zyllRoot = "1"`。
- 搬的顺序（防止丢掉别的设备、网页版的写入）：
  1. 旧位置挂上 `migrating`，等 10 分钟，让正在进行的上传和目录写入做完（中途被打断，下次接着等剩下的时间）。
  2. 读一次旧位置的备份目录，合进本机记录；然后复制旧位置的全部文件（`index-broken-*` 也复制），复制完再列一遍，有新文件就接着复制（最多 3 轮，还有新文件就下次再来）。
  3. 生成新位置的目录，旧位置改成 `moved`。旧 id → 新 id 的映射保留到清理结束。
  4. 清理旧位置前：再列一次，没复制过的先复制；再读一次旧目录，把条目换成新 id 合进来、重写新目录。这时还有没复制过的文件就先不删，下次再补。之后只删映射里复制过的文件和旧目录，`storage.json` 保留。旧 id 换新 id 时，删除记号和待删列表一起换，上传清单和替换链清空。
- 网页版每次上传前读 `storage.json`：是 `migrating` 就不开始新上传（已经传完的照常写目录），是 `moved` 就不往这个位置写。
- OneDrive 的应用文件夹本来就是可见的，不需要搬迁。

## 8. 待实测

- Google `drive.file`：对方的 Zyll 能否读取别人共享给他的文件。计划让对方在接受邀请时通过 Google Picker 选中共享文件夹，再实测是否同时获得文件夹内文件的访问权限。不行的话要换方案（例如申请更大的读取权限），到时再定。
- OneDrive：读取别人共享的文件需要 `Files.Read.All`（个人账号只需用户同意，不需要审核）。
