import { NeedsSignIn, accessToken, invalidate, type StoredAccount } from "./auth";
import { SIMPLE_UPLOAD_MAX, SLICE, VISIBLE_ROOT } from "./config";

/** 要上传的内容：按需读出一段字节（加密文件边读边加密，不整个放进内存）。 */
export interface UploadSource {
  size: number;
  mime: string;
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface UploadOptions {
  /** 固定名字的文件（目录、密钥包）：已有同名文件就覆盖，文件 id 不变。 */
  replace?: boolean;
  onProgress?: (sent: number) => void;
  signal?: AbortSignal;
}

export interface Quota {
  total?: number;
  used?: number;
}

/** 给 Service Worker 用的下载请求（视频边下边播）。 */
export interface MediaRequest {
  url: string;
  headers: Record<string, string>;
}

/** 一个网盘的读写接口，路径和安卓 CloudDrive 一致（相对于库根目录）。 */
export interface Drive {
  readonly account: StoredAccount;
  findFile(path: string[]): Promise<string | null>;
  download(id: string, range?: [number, number], signal?: AbortSignal): Promise<Uint8Array>;
  mediaRequest(id: string): Promise<MediaRequest>;
  upload(path: string[], src: UploadSource, opts?: UploadOptions): Promise<string>;
  /** 删除；文件已经不在了也算成功。 */
  delete(id: string): Promise<void>;
  /** 文件还在不在（不在回收站里）。 */
  exists(id: string): Promise<boolean>;
  /** 在网盘服务器上复制一份到 [path]，返回新文件 id（不经过浏览器）。 */
  copy(id: string, path: string[]): Promise<string>;
  quota(): Promise<Quota>;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
  get quotaFull() {
    return this.status === 507 || /storageQuotaExceeded|quotaLimitReached|insufficientStorage/i.test(this.message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 带重试的请求：401 让令牌失效后重试一次，429 / 5xx / 断网按指数退避重试。 */
async function request(acc: StoredAccount | null, url: string, init: RequestInit = {}, ok: (s: number) => boolean = (s) => s >= 200 && s < 300): Promise<Response> {
  let authRetried = false;
  for (let attempt = 0; ; attempt++) {
    const headers = new Headers(init.headers);
    if (acc) headers.set("Authorization", `Bearer ${await accessToken(acc)}`);
    let r: Response;
    try {
      r = await fetch(url, { ...init, headers });
    } catch (e) {
      if ((e as Error).name === "AbortError" || attempt >= 3) throw e;
      await sleep(1000 << attempt);
      continue;
    }
    if (ok(r.status)) return r;
    if (r.status === 401 && acc && !authRetried) {
      authRetried = true;
      invalidate(acc);
      if (acc.kind === "google") throw new NeedsSignIn(acc);
      continue;
    }
    if ((r.status === 429 || r.status >= 500) && attempt < 4) {
      const after = Number(r.headers.get("Retry-After"));
      await sleep(after > 0 ? Math.min(after, 60) * 1000 : 1000 << attempt);
      continue;
    }
    const text = await r.text().catch(() => "");
    let msg = `HTTP ${r.status}`;
    try {
      const o = JSON.parse(text);
      msg = o.error?.message ?? o.error_description ?? msg;
      if (o.error?.errors?.[0]?.reason) msg += ` (${o.error.errors[0].reason})`;
      if (o.error?.code && typeof o.error.code === "string") msg += ` (${o.error.code})`;
    } catch {
      /* not json */
    }
    throw new HttpError(r.status, msg);
  }
}

const rangeHeader = (range?: [number, number]): Record<string, string> => (range ? { Range: `bytes=${range[0]}-${range[1] - 1}` } : {});

async function bytes(r: Response): Promise<Uint8Array> {
  return new Uint8Array(await r.arrayBuffer());
}

/** 分片上传的公共循环：把 [start, size) 按 SLICE 发出去，直到服务器返回文件 id。 */
async function sendSlices(
  src: UploadSource, start: number, opts: UploadOptions,
  put: (chunk: Uint8Array, from: number, to: number) => Promise<{ done: string } | { next: number }>,
): Promise<string> {
  let offset = start;
  for (;;) {
    opts.signal?.throwIfAborted();
    const end = Math.min(src.size, offset + SLICE);
    const chunk = await src.read(offset, end);
    const res = await put(chunk, offset, end);
    if ("done" in res) {
      opts.onProgress?.(src.size);
      return res.done;
    }
    offset = res.next;
    opts.onProgress?.(offset);
  }
}

// ======================= Google Drive =======================

const G_API = "https://www.googleapis.com/drive/v3";
const G_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const G_FOLDER = "application/vnd.google-apps.folder";

const gq = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/**
 * Google Drive v3。[root] 是库根目录：
 * - "appDataFolder"：隐藏区（安卓默认）；
 * - 一个文件夹 id：开了分享功能后 My Drive 下的“Zyll 相册/”（drive.file）。
 */
export class GoogleDrive implements Drive {
  private folders = new Map<string, string>();
  constructor(readonly account: StoredAccount, readonly root: string = "appDataFolder") {}

  private get spaces() {
    return this.root === "appDataFolder" ? "appDataFolder" : "drive";
  }

  private async list(q: string, fields = "files(id)", extra = ""): Promise<{ id: string; [k: string]: unknown }[]> {
    const url = `${G_API}/files?spaces=${this.spaces}&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(q)}${extra}`;
    const o = await (await request(this.account, url)).json();
    return o.files ?? [];
  }

  private async folderId(path: string[], create: boolean): Promise<string | null> {
    let parent = this.root;
    let key = "";
    for (const name of path) {
      key += "/" + name;
      const cached = this.folders.get(key);
      if (cached) {
        parent = cached;
        continue;
      }
      const found = await this.list(`name = '${gq(name)}' and mimeType = '${G_FOLDER}' and '${parent}' in parents and trashed = false`);
      let id = found[0]?.id;
      if (!id) {
        if (!create) return null;
        const r = await request(this.account, `${G_API}/files?fields=id`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, mimeType: G_FOLDER, parents: [parent] }),
        });
        id = (await r.json()).id as string;
      }
      this.folders.set(key, id);
      parent = id;
    }
    return parent;
  }

  private async findIn(parent: string, name: string): Promise<string | null> {
    const found = await this.list(`name = '${gq(name)}' and '${parent}' in parents and trashed = false`, "files(id)", "&orderBy=modifiedTime%20desc");
    return found[0]?.id ?? null;
  }

  async findFile(path: string[]): Promise<string | null> {
    const parent = await this.folderId(path.slice(0, -1), false);
    return parent ? this.findIn(parent, path[path.length - 1]!) : null;
  }

  async download(id: string, range?: [number, number], signal?: AbortSignal): Promise<Uint8Array> {
    return bytes(await request(this.account, `${G_API}/files/${id}?alt=media`, { headers: rangeHeader(range), signal }));
  }

  async mediaRequest(id: string): Promise<MediaRequest> {
    return { url: `${G_API}/files/${id}?alt=media`, headers: { Authorization: `Bearer ${await accessToken(this.account)}` } };
  }

  async upload(path: string[], src: UploadSource, opts: UploadOptions = {}): Promise<string> {
    const parent = (await this.folderId(path.slice(0, -1), true))!;
    const name = path[path.length - 1]!;
    const existing = opts.replace ? await this.findIn(parent, name) : null;
    const meta = existing ? {} : { name, parents: [parent] };
    if (src.size <= SIMPLE_UPLOAD_MAX) {
      const data = await src.read(0, src.size);
      const boundary = "zyll" + Math.random().toString(36).slice(2);
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
        `--${boundary}\r\nContent-Type: ${src.mime}\r\n\r\n`,
        data as Uint8Array<ArrayBuffer>,
        `\r\n--${boundary}--`,
      ]);
      const url = existing ? `${G_UPLOAD}/${existing}?uploadType=multipart&fields=id` : `${G_UPLOAD}?uploadType=multipart&fields=id`;
      const r = await request(this.account, url, {
        method: existing ? "PATCH" : "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
        signal: opts.signal,
      });
      opts.onProgress?.(src.size);
      return (await r.json()).id;
    }
    const start = await request(this.account, existing ? `${G_UPLOAD}/${existing}?uploadType=resumable&fields=id` : `${G_UPLOAD}?uploadType=resumable&fields=id`, {
      method: existing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": src.mime, "X-Upload-Content-Length": String(src.size) },
      body: JSON.stringify(meta),
      signal: opts.signal,
    });
    const session = start.headers.get("Location");
    if (!session) throw new Error("Google 没有返回上传地址");
    return sendSlices(src, 0, opts, async (chunk, from, to) => {
      const r = await request(null, session, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${from}-${to - 1}/${src.size}` },
        body: chunk as Uint8Array<ArrayBuffer>,
        signal: opts.signal,
      }, (s) => (s >= 200 && s < 300) || s === 308);
      if (r.status === 308) {
        // Range 头不一定对网页公开；读不到时按这一片已经收下算（每片都是按顺序整片发的）
        const got = r.headers.get("Range")?.split("-")[1];
        return { next: got ? Number(got) + 1 : to };
      }
      return { done: (await r.json()).id };
    });
  }

  async delete(id: string): Promise<void> {
    await request(this.account, `${G_API}/files/${id}`, { method: "DELETE" }, (s) => (s >= 200 && s < 300) || s === 404);
  }

  async exists(id: string): Promise<boolean> {
    const r = await request(this.account, `${G_API}/files/${id}?fields=id,trashed`, {}, (s) => (s >= 200 && s < 300) || s === 404);
    if (r.status === 404) return false;
    return !(await r.json()).trashed;
  }

  async copy(id: string, path: string[]): Promise<string> {
    const parent = (await this.folderId(path.slice(0, -1), true))!;
    const r = await request(this.account, `${G_API}/files/${id}/copy?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: path[path.length - 1], parents: [parent] }),
    });
    return (await r.json()).id;
  }

  async quota(): Promise<Quota> {
    const o = await (await request(this.account, `${G_API}/about?fields=storageQuota(limit,usage)`)).json();
    const q = o.storageQuota ?? {};
    return { total: q.limit ? Number(q.limit) : undefined, used: q.usage ? Number(q.usage) : undefined };
  }

  /** My Drive 下带 appProperties.zyllRoot = "1" 的“Zyll 相册/”文件夹（开了分享功能、搬过去的库）。 */
  static async findVisibleRoot(acc: StoredAccount): Promise<string | null> {
    // 和 App 一致：名字是“Zyll 相册”、在根目录下、带 zyllRoot 标记
    const q = `name = '${VISIBLE_ROOT}' and mimeType = '${G_FOLDER}' and 'root' in parents and trashed = false and appProperties has { key='zyllRoot' and value='1' }`;
    const url = `${G_API}/files?spaces=drive&fields=files(id)&q=${encodeURIComponent(q)}`;
    const o = await (await request(acc, url)).json();
    return o.files?.[0]?.id ?? null;
  }

  /** 建可见的“Zyll 相册/”文件夹（和 App 建的一样：根目录下、带 zyllRoot 标记和说明）。 */
  static async createVisibleRoot(acc: StoredAccount): Promise<string> {
    const r = await request(acc, `${G_API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: VISIBLE_ROOT,
        mimeType: G_FOLDER,
        parents: ["root"],
        appProperties: { zyllRoot: "1" },
        description: "Zyll 相册的加密备份。文件名是随机的，内容都是密文。请不要删除或移动这个文件夹。",
      }),
    });
    return (await r.json()).id;
  }
}

// ======================= OneDrive =======================

const MS_API = "https://graph.microsoft.com/v1.0";
const encPath = (path: string[]) => path.map(encodeURIComponent).join("/");

/** OneDrive（Microsoft Graph），库根目录是应用专属文件夹（approot）。 */
export class OneDrive implements Drive {
  private downloadUrls = new Map<string, { url: string; at: number }>();
  private driveId: string | null = null;
  constructor(readonly account: StoredAccount) {}

  async findFile(path: string[]): Promise<string | null> {
    const r = await request(this.account, `${MS_API}/me/drive/special/approot:/${encPath(path)}?$select=id`, {}, (s) => (s >= 200 && s < 300) || s === 404);
    if (r.status === 404) return null;
    return (await r.json()).id;
  }

  /**
   * 预签名的下载地址（不带 Authorization，支持 Range），缓存 30 分钟。
   * 个人账号用 $select 时有时不返回下载地址，所以不加 $select；两种属性名都认。
   */
  private async downloadUrl(id: string): Promise<string | null> {
    const c = this.downloadUrls.get(id);
    if (c && Date.now() - c.at < 30 * 60_000) return c.url;
    const o = await (await request(this.account, `${MS_API}/me/drive/items/${id}`)).json();
    const url = (o["@microsoft.graph.downloadUrl"] ?? o["@content.downloadUrl"]) as string | undefined;
    if (!url) return null;
    this.downloadUrls.set(id, { url, at: Date.now() });
    return url;
  }

  async download(id: string, range?: [number, number], signal?: AbortSignal): Promise<Uint8Array> {
    const url = await this.downloadUrl(id);
    // 拿不到预签名地址时走 /content（302 跳到下载地址，跨源跳转时浏览器会去掉 Authorization）
    if (!url) return bytes(await request(this.account, `${MS_API}/me/drive/items/${id}/content`, { headers: rangeHeader(range), signal }));
    try {
      return bytes(await request(null, url, { headers: rangeHeader(range), signal }));
    } catch (e) {
      // 地址过期：清缓存重取一次
      if (e instanceof HttpError && (e.status === 401 || e.status === 403 || e.status === 404)) {
        this.downloadUrls.delete(id);
        const fresh = await this.downloadUrl(id);
        if (fresh) return bytes(await request(null, fresh, { headers: rangeHeader(range), signal }));
      }
      throw e;
    }
  }

  async mediaRequest(id: string): Promise<MediaRequest> {
    const url = await this.downloadUrl(id);
    if (url) return { url, headers: {} };
    return { url: `${MS_API}/me/drive/items/${id}/content`, headers: { Authorization: `Bearer ${await accessToken(this.account)}` } };
  }

  async upload(path: string[], src: UploadSource, opts: UploadOptions = {}): Promise<string> {
    const conflict = opts.replace ? "replace" : "rename";
    if (src.size <= SIMPLE_UPLOAD_MAX) {
      const data = await src.read(0, src.size);
      const r = await request(this.account, `${MS_API}/me/drive/special/approot:/${encPath(path)}:/content?@microsoft.graph.conflictBehavior=${conflict}`, {
        method: "PUT",
        headers: { "Content-Type": src.mime },
        body: data as Uint8Array<ArrayBuffer>,
        signal: opts.signal,
      });
      opts.onProgress?.(src.size);
      return (await r.json()).id;
    }
    const s = await request(this.account, `${MS_API}/me/drive/special/approot:/${encPath(path)}:/createUploadSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": conflict } }),
      signal: opts.signal,
    });
    const uploadUrl = (await s.json()).uploadUrl as string;
    // 上传地址自带凭据，不能再带 Authorization 头
    return sendSlices(src, 0, opts, async (chunk, from, to) => {
      const r = await request(null, uploadUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${from}-${to - 1}/${src.size}` },
        body: chunk as Uint8Array<ArrayBuffer>,
        signal: opts.signal,
      });
      const o = await r.json();
      if (o.id) return { done: o.id as string };
      const next = Number(String(o.nextExpectedRanges?.[0] ?? to).split("-")[0]);
      return { next };
    });
  }

  async delete(id: string): Promise<void> {
    await request(this.account, `${MS_API}/me/drive/items/${id}`, { method: "DELETE" }, (s) => (s >= 200 && s < 300) || s === 404);
    this.downloadUrls.delete(id);
  }

  async exists(id: string): Promise<boolean> {
    const r = await request(this.account, `${MS_API}/me/drive/items/${id}?$select=id`, {}, (s) => (s >= 200 && s < 300) || s === 404);
    return r.status !== 404;
  }

  private async ensureFolder(path: string[]): Promise<{ id: string; driveId: string }> {
    if (!this.driveId) {
      const o = await (await request(this.account, `${MS_API}/me/drive/special/approot?$select=id,parentReference`)).json();
      this.driveId = o.parentReference?.driveId as string;
      if (path.length === 0) return { id: o.id, driveId: this.driveId };
    }
    const sel = path.length ? `:/${encPath(path)}` : "";
    const r = await request(this.account, `${MS_API}/me/drive/special/approot${sel}?$select=id`, {}, (s) => (s >= 200 && s < 300) || s === 404);
    if (r.status !== 404) return { id: (await r.json()).id, driveId: this.driveId };
    const parent = await this.ensureFolder(path.slice(0, -1));
    const c = await request(this.account, `${MS_API}/me/drive/items/${parent.id}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: path[path.length - 1], folder: {}, "@microsoft.graph.conflictBehavior": "replace" }),
    });
    return { id: (await c.json()).id, driveId: this.driveId };
  }

  async copy(id: string, path: string[]): Promise<string> {
    const parent = await this.ensureFolder(path.slice(0, -1));
    const r = await request(this.account, `${MS_API}/me/drive/items/${id}/copy?@microsoft.graph.conflictBehavior=rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentReference: { driveId: parent.driveId, id: parent.id }, name: path[path.length - 1] }),
    }, (s) => s === 202 || (s >= 200 && s < 300));
    const monitor = r.headers.get("Location");
    if (!monitor) throw new Error("OneDrive 没有返回复制进度地址");
    // 复制是异步的：轮询进度地址（不带 Authorization）
    for (let i = 0; i < 120; i++) {
      await sleep(Math.min(500 * (i + 1), 3000));
      const m = await fetch(monitor);
      const o = await m.json().catch(() => ({}));
      if (o.resourceId && (o.status === "completed" || m.status === 200)) return o.resourceId as string;
      if (o.status === "failed") throw new Error("OneDrive 复制失败");
    }
    throw new Error("OneDrive 复制超时");
  }

  async quota(): Promise<Quota> {
    try {
      const o = await (await request(this.account, `${MS_API}/me/drive?$select=quota`)).json();
      return { total: o.quota?.total || undefined, used: o.quota?.used };
    } catch {
      // 只有应用文件夹权限时个别账号读不到
      return {};
    }
  }
}
