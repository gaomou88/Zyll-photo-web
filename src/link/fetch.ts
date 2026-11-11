import { sharelink } from "@zyll/crypto";
import { GOOGLE_API_KEY } from "../lib/config";

/** 不登录读取外链里的公开文件（spec/share-link.md 第 6 节）。 */

export class FetchError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** [p] = g：[loc] 是 Google 文件 id；o：[loc] 是 OneDrive 匿名链接的 webUrl（已经是 base64url 时传 encoded = true）。 */
export async function fetchPublic(p: sharelink.Provider, loc: string, encoded = false, signal?: AbortSignal): Promise<Uint8Array> {
  const url = p === "g"
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(loc)}?alt=media&key=${encodeURIComponent(GOOGLE_API_KEY)}`
    : `https://api.onedrive.com/v1.0/shares/u!${encoded ? loc : sharelink.encodeUrlLoc(loc)}/root/content`;
  const res = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new FetchError(res.status);
  return new Uint8Array(await res.arrayBuffer());
}
