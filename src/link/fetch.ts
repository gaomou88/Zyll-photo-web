import { sharelink } from "@zyll/crypto";
import { GOOGLE_API_KEY } from "../lib/config";

/** 不登录读取外链里的公开文件（spec/share-link.md 第 6 节）。 */

export class FetchError extends Error {
  constructor(readonly status: number, readonly reason = "") {
    super(`HTTP ${status}${reason ? ` ${reason}` : ""}`);
  }

  /**
   * 文件确实不在了、或者不再公开（链接被撤销、过期后被删）。
   * Google 的 403 多数是 API key、配额、限流的问题，和链接本身无关，不算。
   */
  get gone(): boolean {
    if (this.status === 404 || this.status === 410) return true;
    if (this.status === 401 || this.status === 403) return GONE_REASONS.has(this.reason);
    return false;
  }
}

/**
 * 这些原因表示文件本身打不开了（不再公开、没有权限）。
 * 不含 Google 的 "forbidden"：API key 被来源限制拦下（API_KEY_HTTP_REFERRER_BLOCKED）时也是它，那不是链接失效。
 */
const GONE_REASONS = new Set(["notFound", "insufficientFilePermissions", "appNotAuthorizedToFile", "cannotDownloadAbusiveFile", "accessDenied", "itemNotFound"]);

async function errorOf(res: Response, p: sharelink.Provider): Promise<FetchError> {
  let reason = "";
  try {
    const body = (await res.json()) as { error?: { errors?: { reason?: string }[]; code?: unknown; status?: unknown } };
    const e = body.error;
    reason = e?.errors?.[0]?.reason ?? (typeof e?.code === "string" ? e.code : "");
  } catch {
    // 没有 JSON 正文
  }
  // OneDrive 的匿名接口不用 key：401、403 就是链接被撤掉了
  if (p === "o" && (res.status === 401 || res.status === 403) && !reason) reason = "accessDenied";
  return new FetchError(res.status, reason);
}

/**
 * [p] = g：[loc] 是 Google 文件 id；o：[loc] 是 OneDrive 匿名链接的 webUrl（已经是 base64url 时传 encoded = true）。
 * [onProgress]：已下载字节数和总字节数（不知道总数时为 0）。
 */
export async function fetchPublic(
  p: sharelink.Provider,
  loc: string,
  encoded = false,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const url = p === "g"
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(loc)}?alt=media&key=${encodeURIComponent(GOOGLE_API_KEY)}`
    : `https://api.onedrive.com/v1.0/shares/u!${encoded ? loc : sharelink.encodeUrlLoc(loc)}/root/content`;
  // Google 的 API key 按来源网站限制调用，要带上来源（只有域名：路径只是 /s，# 后面的部分浏览器从来不放进 Referer）。
  // 页面本身仍是 no-referrer，OneDrive 的请求也不带
  const res = await fetch(url, { signal, credentials: "omit", referrerPolicy: p === "g" ? "origin" : "no-referrer" });
  if (!res.ok) throw await errorOf(res, p);
  if (!onProgress || !res.body) return new Uint8Array(await res.arrayBuffer());
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
    done += r.value.length;
    onProgress(done, total);
  }
  const out = new Uint8Array(done);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
