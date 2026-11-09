// 只在开发模式（npm run dev，地址带 ?demo）里用：内存里的假网盘，用来在没有 OAuth 客户端时试界面和读写流程。
// 生产构建里不会包含这个文件。
import { BlobKind, keybundle } from "@zyll/crypto";
import type { StoredAccount } from "./auth";
import type { Drive, MediaRequest, Quota, UploadOptions, UploadSource } from "./drive";
import { encryptingSource, bytesSource } from "./zylcio";

interface F { id: string; path: string; data: Uint8Array }

export class MemoryDrive implements Drive {
  files = new Map<string, F>();
  private n = 0;
  constructor(readonly account: StoredAccount) {}
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
    const id = existing?.id ?? `f${++this.n}`;
    this.files.set(id, { id, path: path.join("/"), data });
    opts.onProgress?.(src.size);
    return id;
  }
  async delete(id: string) { this.files.delete(id); }
  async exists(id: string) { return this.files.has(id); }
  async copy(id: string, path: string[]) {
    const f = this.files.get(id)!;
    const nid = `f${++this.n}`;
    this.files.set(nid, { id: nid, path: path.join("/"), data: f.data });
    return nid;
  }
  async quota(): Promise<Quota> { return { total: 15e9, used: 2.3e9 }; }
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
export async function demoDrive(): Promise<MemoryDrive> {
  const acc: StoredAccount = { key: "onedrive:demo", kind: "onedrive", accountId: "demo", email: "demo@example.com", accessToken: "x", expiresAt: Date.now() + 1e9 };
  const d = new MemoryDrive(acc);
  const created = await keybundle.create("test1234", { memoryKiB: 8192, iterations: 1, parallelism: 1 });
  const enc = new TextEncoder();
  await d.upload(["vault", "keybundle.json"], bytesSource(enc.encode(created.json), "application/json"));
  const key = created.vault.wrapKey;
  const items = [];
  const now = Date.now();
  for (let i = 0; i < 24; i++) {
    const big = await picture(1600, 1200, i * 37, `照片 ${i + 1}`);
    const small = await picture(384, 288, i * 37, `${i + 1}`);
    const r = await d.upload(["vault", `orig${i}.zylc`], await encryptingSource(big, BlobKind.Original, key));
    const th = await d.upload(["vault", `t-${i}.zylc`], await encryptingSource(small, BlobKind.Thumbnail, key));
    const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await big.arrayBuffer()))].map((x) => x.toString(16).padStart(2, "0")).join("");
    items.push({ r, e: true, n: `IMG_${1000 + i}.jpg`, a: i % 3 ? "相机" : "旅行", m: "image/jpeg", t: now - Math.floor(i / 4) * 86_400_000 - i * 60_000, s: big.size, h, th, d: "phone-1" });
  }
  const index = { v: 2, seq: 3, items, del: [], trash: [], mode: { enc: true, at: now }, settings: { backup: {} } };
  await d.upload(["vault", "index.zylc"], await encryptingSource(new Blob([enc.encode(JSON.stringify(index))]), BlobKind.IndexSnapshot, key));
  return d;
}
