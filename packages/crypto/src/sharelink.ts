import { ZyllCryptoError, argon2id, concat, hkdfSha256, importAesKey, sha256, utf8 } from "./primitives";
import * as zylc from "./zylc";

/** 外链分享：链接格式和钥匙。见 spec/share-link.md。 */

export const VERSION = 1;
export const SECRET_LEN = 32;
export const MIN_PASSWORD = 8;
export const ARGON2 = { memoryKiB: 65536, iterations: 3, parallelism: 1 } as const;

export type Provider = "g" | "o";

export interface Fragment {
  provider: Provider;
  /** Google：清单文件 id；OneDrive：清单匿名链接 webUrl 的 base64url。 */
  loc: string;
  secret: Uint8Array;
}

const LOC_RE = /^[A-Za-z0-9_-]+$/;

function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new ZyllCryptoError("bad link");
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function b64urlEncode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 解析 `#` 后面的部分（带不带 `#` 都行）。格式不对抛 ZyllCryptoError。 */
export function parseFragment(text: string): Fragment {
  const parts = text.replace(/^#/, "").split(".");
  if (parts.length !== 4 || parts[0] !== String(VERSION)) throw new ZyllCryptoError("bad link");
  const [, provider = "", loc = "", sec = ""] = parts;
  if (provider !== "g" && provider !== "o") throw new ZyllCryptoError("bad link");
  if (!LOC_RE.test(loc)) throw new ZyllCryptoError("bad link");
  let secret: Uint8Array;
  try {
    secret = b64urlDecode(sec);
  } catch {
    throw new ZyllCryptoError("bad link");
  }
  if (secret.length !== SECRET_LEN) throw new ZyllCryptoError("bad link");
  return { provider, loc, secret };
}

export function encodeFragment(f: Fragment): string {
  return `${VERSION}.${f.provider}.${f.loc}.${b64urlEncode(f.secret)}`;
}

/** OneDrive 的清单位置还原成 webUrl。 */
export function decodeUrlLoc(loc: string): string {
  return new TextDecoder().decode(b64urlDecode(loc));
}

export function encodeUrlLoc(url: string): string {
  return b64urlEncode(utf8(url));
}

export async function salt(secret: Uint8Array): Promise<Uint8Array> {
  return (await sha256(utf8("zyll-link/v1/salt"), secret)).subarray(0, 16);
}

/** 清单的包裹密钥 K_link 原始字节。Argon2id 64 MiB：在 Worker 里调用。 */
export async function linkKeyBytes(secret: Uint8Array, password: string): Promise<Uint8Array> {
  if (secret.length !== SECRET_LEN) throw new ZyllCryptoError("bad link");
  const pw = await argon2id(utf8(password.normalize("NFC")), await salt(secret), ARGON2.memoryKiB, ARGON2.iterations, ARGON2.parallelism);
  try {
    return await hkdfSha256(concat(secret, pw), new Uint8Array(0), utf8("zyll/v1/link-wrap"), 32);
  } finally {
    pw.fill(0);
  }
}

/** 解开清单；密码错时抛 ZyllCryptoError。 */
export async function openManifest(data: Uint8Array, linkKey: Uint8Array): Promise<Uint8Array> {
  const k = await importAesKey(linkKey);
  const h = zylc.decodeHeader(data.subarray(0, Math.min(zylc.HEADER_LEN, data.length)));
  if (h.kind !== zylc.BlobKind.Other) throw new ZyllCryptoError("unexpected blob kind");
  return zylc.decrypt(data, k);
}

/** 清单里的一张照片（spec/share-link.md 第 3 节）。 */
export interface LinkItem {
  n: string;
  m: string;
  t: number;
  s: number;
  mo?: boolean;
  p?: Provider;
  f: string;
  dk: string;
  tf: string;
  tk: string;
}

export interface LinkManifest {
  format: "zyll-link";
  version: number;
  id: string;
  title: string;
  created: number;
  expires: number | null;
  originals: boolean;
  items: LinkItem[];
}

/** 解析并检查清单 JSON；格式不对抛 ZyllCryptoError。 */
export function parseManifest(plain: Uint8Array): LinkManifest {
  let o: unknown;
  try {
    o = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new ZyllCryptoError("bad manifest");
  }
  const m = o as LinkManifest;
  if (!m || m.format !== "zyll-link" || m.version !== VERSION || !Array.isArray(m.items)) throw new ZyllCryptoError("bad manifest");
  for (const i of m.items) {
    if (typeof i.f !== "string" || typeof i.dk !== "string" || typeof i.n !== "string") throw new ZyllCryptoError("bad manifest");
    if (i.p !== undefined && i.p !== "g" && i.p !== "o") throw new ZyllCryptoError("bad manifest");
  }
  return m;
}
