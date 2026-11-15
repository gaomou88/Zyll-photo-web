/**
 * 网盘文件夹布局 v3（spec/vault-layout.md），和安卓 DriveLayout.kt 一致：
 * 库根目录下只有三个文件夹“设置、共享、相册”（外链放在共享里），名字按界面语言取，只给人看；
 * 程序靠 Google 文件夹上的 appProperties.zyllDir、OneDrive 上四种语言的名字认它们。
 *
 * 其余代码仍然用逻辑路径（v2 的路径：vault/keybundle.json、共享/<albumId>、<相簿>/<文件>…），
 * 由网盘接口（drive.ts）按 [place] 换成实际位置。
 */
import { lang, type Lang } from "./i18n";

export type DriveDir = "settings" | "shared" | "albums" | "links";

export const LEGACY_VAULT = "vault";
export const LEGACY_SHARED = "共享";
export const LEGACY_LINKS = "links";
export const THUMBS = ".thumbs";
export const DIR_PROP = "zyllDir";

/** 不加密时相簿文件夹不能用的名字（逻辑路径里有特殊含义）。 */
export const RESERVED = new Set([LEGACY_VAULT, LEGACY_SHARED, THUMBS]);

/** v2 时的旧文件夹名：升级时改名“认领”过来（文件 id 不变）。 */
export const LEGACY: Record<DriveDir, string | null> = { settings: null, shared: LEGACY_SHARED, albums: LEGACY_VAULT, links: LEGACY_LINKS };

/** 四种语言的名字，顺序：简中、繁中、英文、日文（和安卓一样，只能往后加）。 */
const NAMES: Record<DriveDir, string[]> = {
  settings: ["设置", "設定", "Settings", "設定"],
  shared: ["共享", "共享", "Shared", "共有"],
  albums: ["相册", "相簿", "Albums", "アルバム"],
  links: ["外链", "外部連結", "Links", "リンク"],
};
const ORDER: Lang[] = ["zh", "zh-Hant", "en", "ja"];
const ROOT_NAMES = ["Zyll 相册", "Zyll 相簿", "Zyll Photos", "Zyll フォト"];
const ROOT_DESC = [
  "Zyll 相册的加密备份。文件名是随机的，内容都是密文。请不要删除或移动这个文件夹。",
  "Zyll 相簿的加密備份。檔案名稱是隨機的，內容都是密文。請不要刪除或移動這個資料夾。",
  "Encrypted backups from Zyll Photos. File names are random and the contents are encrypted. Please don't delete or move this folder.",
  "Zyll フォトの暗号化バックアップです。ファイル名はランダムで、中身はすべて暗号化されています。このフォルダを削除したり移動したりしないでください。",
];

const li = () => Math.max(0, ORDER.indexOf(lang));
export const nameOf = (dir: DriveDir) => NAMES[dir][li()]!;
export const rootName = () => ROOT_NAMES[li()]!;
export const rootDescription = () => ROOT_DESC[li()]!;
/** 认得的名字：当前语言的在前。 */
export const candidates = (dir: DriveDir) => [...new Set([nameOf(dir), ...NAMES[dir]])];
export const parentOf = (dir: DriveDir): DriveDir | null => (dir === "links" ? "shared" : null);

const SETTINGS_FILES = new Set([
  "keybundle.json", "index.zylc", "ai-results.zylc", "identity.zylc", "shared-albums.zylc",
  "shared-albums-broken.zylc", "share-links.zylc", "wiped.json",
]);
export const isSettingsFile = (name: string) => SETTINGS_FILES.has(name) || name.startsWith("index-broken");
export const isRootSettingsFile = (name: string) => name === "index.json" || name.startsWith("index-broken");

/** 实际位置：dir 为 null 表示就在库根目录下。 */
export interface Place { dir: DriveDir | null; rest: string[] }

/** 逻辑路径 → 实际位置（和安卓 DriveLayout.place 一致）。 */
export function place(logical: string[]): Place {
  const [first] = logical;
  if (!logical.length) return { dir: null, rest: logical };
  if (logical.length === 1 && isRootSettingsFile(first!)) return { dir: "settings", rest: logical };
  if (logical.length === 1) return { dir: null, rest: logical };
  if (first === LEGACY_VAULT && logical.length === 2 && isSettingsFile(logical[1]!)) return { dir: "settings", rest: logical.slice(1) };
  if (first === LEGACY_VAULT) return { dir: "albums", rest: logical.slice(1) };
  if (first === LEGACY_SHARED && logical[1] === LEGACY_LINKS) return { dir: "links", rest: logical.slice(2) };
  if (first === LEGACY_SHARED) return { dir: "shared", rest: logical.slice(1) };
  return { dir: "albums", rest: logical };
}

/** 逻辑上的文件夹（比如 [共享, albumId]）对应的实际位置。 */
export function placeDir(dir: string[]): Place {
  const p = place([...dir, "\u0000dir"]);
  return { dir: p.dir, rest: p.rest.slice(0, -1) };
}

/** 固定文件可能还留在的旧位置（已经改名成“相册”的旧 vault 里、根目录下又建出来的 vault 里、根目录）。 */
export function legacyPlaces(logical: string[]): Place[] {
  const p = place(logical);
  if (p.dir !== "settings") return [];
  const name = p.rest[0]!;
  return logical.length === 1 ? [{ dir: null, rest: [name] }] : [{ dir: "albums", rest: [name] }, { dir: null, rest: [LEGACY_VAULT, name] }];
}
