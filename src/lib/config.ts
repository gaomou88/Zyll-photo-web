/**
 * 网页版的 OAuth 配置。客户端 ID 不进仓库，构建时从环境变量注入（GitHub Actions 里读同名 secrets）：
 * - VITE_GOOGLE_CLIENT_ID：Google Cloud 里和安卓版**同一个项目**的“网页应用”类型 OAuth 客户端
 *   （同一个项目才能读到安卓版放在 appDataFolder / drive.file 里的文件）。
 * - VITE_ONEDRIVE_CLIENT_ID：Microsoft Entra 里和安卓版**同一个应用注册**（同一个应用才是同一个“应用/Zyll 相册”文件夹），
 *   加一个“单页应用程序”平台，重定向 URI 填 [redirectUri]。
 */
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
export const ONEDRIVE_CLIENT_ID: string = import.meta.env.VITE_ONEDRIVE_CLIENT_ID ?? "";

/** 登录回调页：和主页面同一目录下的 auth-callback.html。 */
export function redirectUri(): string {
  const u = new URL("auth-callback.html", location.href);
  u.search = "";
  u.hash = "";
  return u.toString();
}

export const GOOGLE_SCOPES = [
  // 隐藏区（安卓默认的存储位置）
  "https://www.googleapis.com/auth/drive.appdata",
  // 开了分享功能后库搬到 My Drive 的“Zyll 相册/”（spec/sharing.md 第 7 节）
  "https://www.googleapis.com/auth/drive.file",
  "openid",
  "email",
];

export const ONEDRIVE_SCOPES = ["Files.ReadWrite.AppFolder", "User.Read", "offline_access"];

/** 和安卓 CloudConfig / CloudBackup 一致的网盘路径。 */
export const ENCRYPTED_FOLDER = "vault";
export const THUMB_FOLDER = ".thumbs";
export const INDEX_PLAIN = ["index.json"];
export const INDEX_ENCRYPTED = [ENCRYPTED_FOLDER, "index.zylc"];
export const KEYBUNDLE_PATH = [ENCRYPTED_FOLDER, "keybundle.json"];
export const VISIBLE_ROOT = "Zyll 相册";

export const TOMBSTONE_MAX = 20_000;
export const TRASH_IN_INDEX = 2000;
export const THUMB_PX = 384;
/** 上传分片：256 KiB（Google）和 320 KiB（OneDrive）的公倍数。 */
export const SLICE = 5 * 1024 * 1024;
/** 小于这个大小的文件一次传完。 */
export const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
