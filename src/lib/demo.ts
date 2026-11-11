// 只在开发模式（npm run dev，地址带 ?demo）里用：内存里的假网盘，用来在没有 OAuth 客户端时试界面和读写流程。
// 生产构建里不会包含这个文件。
import { BlobKind, keybundle } from "@zyll/crypto";
import type { StoredAccount } from "./auth";
import type { Drive, MediaRequest, Quota, SharingDrive, UploadOptions, UploadSource } from "./drive";
import { encryptingSource, bytesSource } from "./zylcio";

interface F { id: string; path: string; data: Uint8Array }

const dirId = (pre: string, path: string) =>
  `dir_${pre}_${btoa(String.fromCharCode(...new TextEncoder().encode(path))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

/** 所有假网盘（共享相册：读别人共享给自己的文件）。 */
const world: MemoryDrive[] = [];
/** 文件或文件夹 id → 有权限的邮箱 → 能不能写。 */
const perms = new Map<string, Map<string, boolean>>();

export class MemoryDrive implements Drive, SharingDrive {
  files = new Map<string, F>();
  private n = 0;
  constructor(readonly account: StoredAccount) {
    world.push(this);
  }
  private prefix() { return this.account.key.replace(/[^a-z]/gi, "") + "-"; }
  private byPath(path: string[]) {
    const p = path.join("/");
    return [...this.files.values()].find((f) => f.path === p) ?? null;
  }
  async findFile(path: string[]) { return this.byPath(path)?.id ?? null; }
  async download(id: string, range?: [number, number]) {
    const f = this.files.get(id);
    if (!f) throw new Error("404");
    return range ? f.data.slice(range[0], range[1]) : f.data.slice();
  }
  async mediaRequest(id: string): Promise<MediaRequest> {
    const f = this.files.get(id)!;
    return { url: URL.createObjectURL(new Blob([f.data as Uint8Array<ArrayBuffer>])), headers: {} };
  }
  async upload(path: string[], src: UploadSource, opts: UploadOptions = {}) {
    await new Promise((r) => setTimeout(r, 150));
    const data = await src.read(0, src.size);
    const existing = opts.replace ? this.byPath(path) : null;
    const id = existing?.id ?? `${this.prefix()}f${++this.n}`;
    this.files.set(id, { id, path: path.join("/"), data });
    opts.onProgress?.(src.size);
    return id;
  }
  async delete(id: string) { this.files.delete(id); }
  async exists(id: string) { return this.files.has(id); }
  async copy(id: string, path: string[]) {
    const f = this.files.get(id)!;
    const nid = `${this.prefix()}f${++this.n}`;
    this.files.set(nid, { id: nid, path: path.join("/"), data: f.data });
    return nid;
  }
  async quota(): Promise<Quota> { return { total: 15e9, used: 2.3e9 }; }

  // ---------- 共享相册 ----------
  // 文件夹 id 形如 “dir_<网盘前缀>_<base64url 路径>”（符合网盘 id 的格式检查）；文件 id 带网盘前缀，别的网盘的文件按权限读
  async ensureFolder(path: string[]) { return dirId(this.prefix(), path.join("/")); }
  private static locate(id: string): { d: MemoryDrive; path: string } | null {
    if (id.startsWith("dir_")) {
      const m = /^dir_([^_]*)_(.*)$/.exec(id);
      const d = m && world.find((w) => w.prefix() === m[1]);
      return d && m ? { d, path: new TextDecoder().decode(Uint8Array.from(atob(m[2]!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))) } : null;
    }
    for (const d of world) {
      const f = d.files.get(id);
      if (f) return { d, path: f.path };
    }
    return null;
  }
  private allowed(id: string, write: boolean): MemoryDrive {
    const at = MemoryDrive.locate(id);
    if (!at) throw new Error("404");
    if (at.d === this) return at.d;
    const me = this.account.email.toLowerCase();
    // 文件本身或者它所在的文件夹授权过
    for (const [pid, m] of perms) {
      const w = m.get(me);
      if (w === undefined || (write && !w)) continue;
      if (pid === id) return at.d;
      const dir = MemoryDrive.locate(pid);
      if (dir && dir.d === at.d && pid.startsWith("dir_") && (at.path === dir.path || at.path.startsWith(dir.path + "/"))) return at.d;
    }
    throw new Error("404");
  }
  async head(id: string, n: number) { return this.downloadAny(id).then((b) => b.slice(0, n)); }
  async grant(id: string, email: string, write: boolean) {
    const m = perms.get(id) ?? new Map<string, boolean>();
    m.set(email.toLowerCase(), write);
    perms.set(id, m);
  }
  async revokeEmail(id: string, email: string) { perms.get(id)?.delete(email.toLowerCase()); }
  async findChild(folderId: string, name: string) {
    const d = this.allowed(folderId, false);
    const base = MemoryDrive.locate(folderId)!.path;
    return [...d.files.values()].find((f) => f.path === (base ? base + "/" : "") + name)?.id ?? null;
  }
  async listChildren(folderId: string): Promise<[string, string, number][]> {
    const d = this.allowed(folderId, false);
    const base = MemoryDrive.locate(folderId)!.path;
    const out = new Map<string, string>();
    for (const f of d.files.values()) {
      if (!f.path.startsWith(base + "/")) continue;
      const rest = f.path.slice(base.length + 1).split("/");
      out.set(rest[0]!, rest.length > 1 ? dirId(d.prefix(), `${base}/${rest[0]}`) : f.id);
    }
    return [...out].map(([n, id]): [string, string, number] => [n, id, 0]);
  }
  async downloadAny(id: string) {
    const d = this.allowed(id, false);
    return d.files.get(id)!.data.slice();
  }
  async uploadInto(folderId: string, name: string, data: Uint8Array) {
    const d = this.allowed(folderId, true);
    const path = MemoryDrive.locate(folderId)!.path + "/" + name;
    const old = [...d.files.values()].find((f) => f.path === path);
    const id = old?.id ?? `${d.prefix()}f${++d.n}`;
    d.files.set(id, { id, path, data: data.slice() });
    return id;
  }
  async deleteAny(id: string) {
    const d = this.allowed(id, true);
    if (!id.startsWith("dir_")) return void d.files.delete(id);
    const base = MemoryDrive.locate(id)!.path;
    for (const f of [...d.files.values()]) if (f.path.startsWith(base + "/")) d.files.delete(f.id);
  }
}

async function picture(w: number, h: number, hue: number, label: string): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hue} 60% 55%)`);
  grad.addColorStop(1, `hsl(${(hue + 60) % 360} 60% 35%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#fff";
  g.font = `${Math.round(h / 8)}px sans-serif`;
  g.fillText(label, w / 10, h / 2);
  return new Promise((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.9));
}

/** 一个什么都没有的网盘（测试首次上传）。 */
export function emptyDrive(): MemoryDrive {
  return new MemoryDrive({ key: "onedrive:empty", kind: "onedrive", accountId: "empty", email: "empty@example.com", accessToken: "x", expiresAt: Date.now() + 1e9 });
}

/** 造一个开着端到端加密的库：密码 test1234，几十张照片。 */
export async function demoDrive(who = "demo", count = 24, extra = 0): Promise<MemoryDrive> {
  const acc: StoredAccount = { key: `onedrive:${who}`, kind: "onedrive", accountId: who, email: `${who}@example.com`, accessToken: "x", expiresAt: Date.now() + 1e9 };
  const d = new MemoryDrive(acc);
  const created = await keybundle.create("test1234", { memoryKiB: 8192, iterations: 1, parallelism: 1 });
  const enc = new TextEncoder();
  await d.upload(["vault", "keybundle.json"], bytesSource(enc.encode(created.json), "application/json"));
  const key = created.vault.wrapKey;
  type Item = { r: string; e: boolean; n: string; a: string; m: string; t: number; s: number; h: string; th: string; d: string };
  const items: Item[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const big = await picture(1600, 1200, i * 37, `照片 ${i + 1}`);
    const small = await picture(384, 288, i * 37, `${i + 1}`);
    const r = await d.upload(["vault", `orig${i}.zylc`], await encryptingSource(big, BlobKind.Original, key));
    const th = await d.upload(["vault", `t-${i}.zylc`], await encryptingSource(small, BlobKind.Thumbnail, key));
    const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await big.arrayBuffer()))].map((x) => x.toString(16).padStart(2, "0")).join("");
    items.push({ r, e: true, n: `IMG_${1000 + i}.jpg`, a: i % 3 ? "相机" : "旅行", m: "image/jpeg", t: now - Math.floor(i / 4) * 86_400_000 - i * 60_000, s: big.size, h, th, d: "phone-1" });
  }
  // 大图库（?demo=big）：同样的文件再挂几千个条目，测照片墙滚动
  for (let i = 0; extra && i < extra; i++) {
    const src: Item = items[i % count]!;
    const r = `${d.account.accountId}-big${i}`;
    const th = `${d.account.accountId}-bigt${i}`;
    d.files.set(r, { id: r, path: `vault/big${i}.zylc`, data: d.files.get(src.r)!.data });
    d.files.set(th, { id: th, path: `vault/bigt${i}.zylc`, data: d.files.get(src.th)!.data });
    items.push({ ...src, r, th, h: src.h.slice(0, 56) + i.toString(16).padStart(8, "0"), t: now - (30 + Math.floor(i / 7)) * 86_400_000 - i * 1000 });
  }
  const index = { v: 2, seq: 3, items, del: [], trash: [], mode: { enc: true, at: now }, settings: { backup: {} } };
  await d.upload(["vault", "index.zylc"], await encryptingSource(new Blob([enc.encode(JSON.stringify(index))]), BlobKind.IndexSnapshot, key));
  return d;
}
