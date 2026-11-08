import { BlobKind, keybundle, toHex, randomBytes } from "@zyll/crypto";
import { NeedsSignIn, loadAccounts, removeAccount, signIn as authSignIn, type DriveKind, type StoredAccount } from "./auth";
import { ENCRYPTED_FOLDER, INDEX_ENCRYPTED, INDEX_PLAIN, KEYBUNDLE_PATH, THUMB_FOLDER, VISIBLE_ROOT } from "./config";
import { GoogleDrive, OneDrive, type Drive, type Quota } from "./drive";
import { applyChange, mergeDocs, parseIndex, serializeIndex, type IndexChange, type IndexDoc, type IndexItem, type Merged } from "./indexdoc";
import { isHeic, makeThumbnail, mimeOf, sha256Hex, takenAt } from "./media";
import { bytesSource, decryptKind, encryptingSource, plainSource } from "./zylcio";
import { runKdf } from "../kdf";

/**
 * 网页版的“库”：每个已连接的网盘账号读一份备份目录，合在一起显示。
 * 写网盘（上传、删除）时先重新读一遍目录再合并改动，规则和安卓一致（见 indexdoc.ts）。
 */

const text = new TextDecoder();
const utf8 = new TextEncoder();

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

/** 这个浏览器的设备 id，写进它上传的条目的 `d`。 */
export const deviceId: string = (() => {
  let id = lsGet("zyll-device-id");
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    lsSet("zyll-device-id", id);
  }
  return id;
})();

/** 解锁后的包裹密钥：vaultId → K_wrap（不可导出，只在内存里）。 */
const keyring = new Map<string, CryptoKey>();

/** 存放位置根目录的 storage.json（spec/sharing.md 第 7 节）。 */
async function readMarker(d: Drive): Promise<{ state: string; to: string } | null> {
  const id = await d.findFile(["storage.json"]);
  if (!id) return null;
  try {
    const o = JSON.parse(text.decode(await d.download(id)));
    if (o?.format !== "zyll-storage") return null;
    return { state: String(o.state ?? ""), to: String(o.to ?? "") };
  } catch {
    return null;
  }
}

export class Locked extends Error {
  constructor() {
    super("需要解锁");
  }
}

export interface Photo {
  /** 全局唯一：账号 key + 网盘文件 id */
  key: string;
  acc: Account;
  item: IndexItem;
  /** 同一张照片（内容指纹相同）在其他账号里的备份 */
  copies: { acc: Account; item: IndexItem }[];
}

interface Pulled {
  merged: Merged;
  encId: string | null;
  plainId: string | null;
}

export type AccountState = "loading" | "ready" | "locked" | "signin" | "error";

export class Account {
  state = $state<AccountState>("loading");
  error = $state("");
  /** 不能写网盘的原因（目录回滚、手机正在搬迁存储位置等）；为空时可以上传和删除 */
  readOnly = $state("");
  items = $state.raw<IndexItem[]>([]);
  quota = $state<Quota>({});
  /** 网盘里有密钥包（开过端到端加密） */
  bundleJson = $state<string | null>(null);
  /** 库放在哪里（给设置页显示） */
  where = $state("");
  drive: Drive;
  private merged: Merged | null = null;
  private encId: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(public stored: StoredAccount) {
    this.drive = stored.kind === "google" ? new GoogleDrive(stored) : new OneDrive(stored);
    this.where = stored.kind === "google" ? "Google 云端硬盘 · 隐藏的应用数据区" : "OneDrive · 应用/Zyll 相册";
  }

  get key() {
    return this.stored.key;
  }
  get label() {
    return `${this.stored.kind === "google" ? "Google" : "OneDrive"} · ${this.stored.email}`;
  }

  get bundleVaultId(): string | null {
    if (!this.bundleJson) return null;
    try {
      return keybundle.parse(this.bundleJson).vaultId;
    } catch {
      return null;
    }
  }

  /** 这个账号用的包裹密钥（没解锁时为 null）。 */
  wrapKey(): CryptoKey | null {
    const id = this.bundleVaultId;
    return id ? (keyring.get(id) ?? null) : null;
  }

  /** 条目能不能在这里解密：不加密的都能；加密的要解锁，而且不是用另一套旧密钥加密的。 */
  canOpen(i: IndexItem): boolean {
    if (!i.e) return true;
    if (!this.wrapKey()) return false;
    return !i.k || i.k === this.bundleVaultId;
  }

  /** 新上传的照片要不要加密：跟着账号的加密选择走（手机上设置）。 */
  get uploadEncrypted(): boolean {
    const m = this.merged;
    if (m?.mode) return m.mode.enc;
    return !!this.encId || this.items.some((i) => i.e);
  }

  private get seqKey() {
    return `zyll-seq-${this.key}`;
  }
  private get pendingKey() {
    return `zyll-pending-${this.key}`;
  }

  private lock<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  async load(): Promise<void> {
    this.state = "loading";
    this.error = "";
    try {
      await this.lock(async () => {
        if (this.drive instanceof GoogleDrive) await this.resolveGoogleRoot();
        const id = await this.drive.findFile(KEYBUNDLE_PATH);
        this.bundleJson = id ? text.decode(await this.drive.download(id)) : null;
        const p = await this.pull();
        this.apply(p);
      });
      this.state = "ready";
      this.drive.quota().then((q) => (this.quota = q), () => {});
      await this.flushPending();
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown) {
    if (e instanceof Locked) this.state = "locked";
    else if (e instanceof NeedsSignIn) this.state = "signin";
    else {
      this.state = "error";
      this.error = (e as Error).message || String(e);
    }
  }

  /**
   * Google：库默认在隐藏区；开了分享功能、手机搬完以后在 My Drive 的“Zyll 相册/”。
   * 每个位置的根目录可能有 storage.json 标记：moved 表示去 to 指向的位置读写，migrating 表示正在搬、不能写。
   */
  private async resolveGoogleRoot() {
    const hidden = new GoogleDrive(this.stored, "appDataFolder");
    let visibleId: string | null = null;
    try {
      visibleId = await GoogleDrive.findVisibleRoot(this.stored);
    } catch {
      /* 没有这个文件夹 */
    }
    const at = (where: "hidden" | "visible") => {
      if (where === "visible" && visibleId) {
        this.drive = new GoogleDrive(this.stored, visibleId);
        this.where = `Google 云端硬盘 · 我的云端硬盘/${VISIBLE_ROOT}`;
      } else {
        this.drive = hidden;
        this.where = "Google 云端硬盘 · 隐藏的应用数据区";
      }
    };
    at("hidden");
    const marker = await readMarker(hidden);
    if (marker?.state === "moved") return at(marker.to === "visible" ? "visible" : "hidden");
    if (marker) return;
    // 没有标记：隐藏区里没有库、可见文件夹里有，就用可见的
    const hiddenHas = !!(await hidden.findFile(INDEX_ENCRYPTED)) || !!(await hidden.findFile(INDEX_PLAIN));
    if (!hiddenHas && visibleId) at("visible");
  }

  /** 读网盘上的目录（加密的 + 明文的）并合并。 */
  private async pull(): Promise<Pulled> {
    const encId = await this.drive.findFile(INDEX_ENCRYPTED);
    const plainId = await this.drive.findFile(INDEX_PLAIN);
    const docs: IndexDoc[] = [];
    let encDoc: IndexDoc | null = null;
    if (encId) {
      const key = this.wrapKey();
      if (!key) throw new Locked();
      let plain: Uint8Array;
      try {
        plain = await decryptKind(await this.drive.download(encId), key, BlobKind.IndexSnapshot);
      } catch {
        throw new Error("加密的备份目录用这个密码解不开（可能是另一套密钥），请先在手机上处理");
      }
      encDoc = parseIndex(text.decode(plain));
      docs.push(encDoc);
    }
    if (plainId) {
      const d = parseIndex(text.decode(await this.drive.download(plainId)));
      // 开着加密时不信任明文目录（能写网盘的人放一份明文目录就能塞进假照片），和安卓一致
      if (!(encDoc && encDoc.mode?.enc)) docs.push(d);
    }
    const merged = mergeDocs(docs);
    const seen = Number(lsGet(this.seqKey) ?? 0);
    this.readOnly = "";
    if (merged.hasSeq && merged.seq < seen) {
      this.readOnly = "网盘上的备份目录比这个浏览器上次看到的还旧（可能被还原过），为了不覆盖数据，暂时只能浏览。请先在手机上处理。";
    }
    const marker = await readMarker(this.drive);
    if (marker?.state === "migrating") this.readOnly = "手机正在搬迁这个网盘的存储位置，搬完前网页版只能浏览。";
    if (marker?.state === "moved") this.readOnly = "这个库已经搬到别的位置，请刷新页面。";
    return { merged, encId, plainId };
  }

  private apply(p: Pulled) {
    this.merged = p.merged;
    this.encId = p.encId;
    if (p.merged.hasSeq) lsSet(this.seqKey, String(Math.max(p.merged.seq, Number(lsGet(this.seqKey) ?? 0))));
    this.items = p.merged.items;
  }

  /** 把改动写进网盘目录：重新读一遍、合并、seq + 1、整份写回。 */
  commit(change: IndexChange): Promise<void> {
    return this.lock(async () => {
      const p = await this.pull();
      if (this.readOnly) throw new Error(this.readOnly);
      const m = applyChange(p.merged, change);
      const key = this.wrapKey();
      const hasEnc = m.items.some((i) => i.e);
      if (hasEnc && !key) throw new Locked();
      const encrypt = !!key && (!!p.encId || hasEnc || !!m.mode?.enc);
      const seq = Math.max(p.merged.seq, Number(lsGet(this.seqKey) ?? 0)) + 1;
      const data = utf8.encode(serializeIndex(m, seq, encrypt));
      if (encrypt) {
        await this.drive.upload(INDEX_ENCRYPTED, await encryptingSource(new Blob([data]), BlobKind.IndexSnapshot, key!), { replace: true });
      } else {
        await this.drive.upload(INDEX_PLAIN, bytesSource(data, "application/octet-stream"), { replace: true });
      }
      lsSet(this.seqKey, String(seq));
      this.apply({ merged: { ...m, seq, hasSeq: true }, encId: encrypt ? (p.encId ?? "new") : p.encId, plainId: p.plainId });
    });
  }

  // ---------- 上传 ----------

  private pending(): IndexItem[] {
    try {
      return JSON.parse(lsGet(this.pendingKey) ?? "[]");
    } catch {
      return [];
    }
  }

  private setPending(list: IndexItem[]) {
    lsSet(this.pendingKey, list.length ? JSON.stringify(list) : null);
  }

  /** 上次传完文件、还没写进目录的条目（比如中途关了页面）：补写进去，不留孤儿文件。 */
  async flushPending() {
    const list = this.pending();
    if (!list.length || this.readOnly) return;
    try {
      await this.commit({ add: list });
      this.setPending([]);
    } catch {
      /* 下次再试 */
    }
  }

  hasHash(h: string) {
    return this.items.some((i) => i.h === h);
  }

  /**
   * 上传一个文件（原图 + 缩略图），返回目录条目；内容相同的照片已经在这个账号里时返回 null。
   * 条目先记进本机的待写清单，调用方攒一批后用 [commitUploads] 写进目录。
   */
  async uploadFile(
    f: File, album: string, onProgress: (phase: string, frac: number) => void, signal?: AbortSignal,
  ): Promise<IndexItem | null> {
    if (this.readOnly) throw new Error(this.readOnly);
    const mime = mimeOf(f);
    onProgress("计算指纹", 0);
    const h = await sha256Hex(f, (d) => onProgress("计算指纹", d / Math.max(1, f.size)));
    if (this.hasHash(h) || this.pending().some((i) => i.h === h)) return null;
    const t = await takenAt(f, mime);
    onProgress("生成缩略图", 0);
    const thumb = await makeThumbnail(f, mime, f.name);
    const encrypt = this.uploadEncrypted;
    const key = encrypt ? this.wrapKey() : null;
    if (encrypt && !key) throw new Locked();
    const safe = (s: string) => s.replace(/\//g, "_").trim();
    const src = encrypt ? await encryptingSource(f, BlobKind.Original, key!) : plainSource(f, mime);
    const path = encrypt ? [ENCRYPTED_FOLDER, `${toHex(randomBytes(16))}.zylc`] : [safe(album) || "未命名", safe(f.name) || "photo"];
    const r = await this.drive.upload(path, src, { signal, onProgress: (n) => onProgress("上传", n / src.size) });
    let th = "";
    if (thumb) {
      try {
        const name = toHex(randomBytes(12));
        th = encrypt
          ? await this.drive.upload([ENCRYPTED_FOLDER, `t-${name}.zylc`], await encryptingSource(thumb, BlobKind.Thumbnail, key!))
          : await this.drive.upload([THUMB_FOLDER, `${name}.jpg`], plainSource(thumb, "image/jpeg"));
      } catch {
        // 缩略图传失败不要紧：手机会自己补
      }
    }
    const item: IndexItem = { r, e: encrypt, n: f.name, a: album, m: mime, t, s: f.size, h, th, d: deviceId, k: "" };
    this.setPending([...this.pending(), item]);
    return item;
  }

  /** 把待写清单里的条目写进目录。 */
  async commitUploads() {
    const list = this.pending();
    if (!list.length) return;
    await this.commit({ add: list });
    this.setPending(this.pending().filter((p) => !list.some((x) => x.r === p.r)));
  }

  // ---------- 删除 ----------

  /** 从网盘永久删除：先在目录里写墓碑（别的设备据此删除记录），再删文件；删不掉的留给手机接着删。 */
  async remove(list: IndexItem[]) {
    if (!list.length) return;
    const files = list.flatMap((i) => [i.r, i.th].filter(Boolean));
    await this.commit({ remove: list.map((i) => i.r), trash: files });
    const done: string[] = [];
    for (const id of files) {
      try {
        await this.drive.delete(id);
        done.push(id);
      } catch {
        /* 留在 trash 里 */
      }
    }
    if (done.length) await this.commit({ trashDone: done }).catch(() => {});
  }

  // ---------- 读取 ----------

  /** 原图（解密并核对内容指纹）。 */
  async original(i: IndexItem, signal?: AbortSignal): Promise<Blob> {
    let data = await this.drive.download(i.r, undefined, signal);
    if (i.e) {
      const key = this.wrapKey();
      if (!key || !this.canOpen(i)) throw new Locked();
      data = await decryptKind(data, key, BlobKind.Original);
    }
    if (i.h) {
      const got = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>)));
      if (got !== i.h.toLowerCase()) throw new Error("文件内容和备份记录对不上（可能被替换过），已拒绝显示");
    }
    return new Blob([data as Uint8Array<ArrayBuffer>], { type: i.m || "application/octet-stream" });
  }

  /** 缩略图字节（JPEG）；没有网盘缩略图时返回 null。密文缓存在浏览器 Cache 里，明文只在内存。 */
  async thumbnail(i: IndexItem): Promise<Blob | null> {
    if (!i.th) return null;
    const cacheUrl = `https://zyll.cache/${encodeURIComponent(this.key)}/${encodeURIComponent(i.th)}`;
    let raw: Uint8Array | null = null;
    let cache: Cache | null = null;
    try {
      cache = await caches.open("zyll-thumbs-v1");
      const hit = await cache.match(cacheUrl);
      if (hit) raw = new Uint8Array(await hit.arrayBuffer());
    } catch {
      cache = null;
    }
    if (!raw) {
      raw = await this.drive.download(i.th);
      // 只缓存加密的缩略图（明文缩略图本来就是用户网盘里的明文，但也不在本机多留一份）
      if (cache && i.e) cache.put(cacheUrl, new Response(raw as Uint8Array<ArrayBuffer>)).catch(() => {});
    }
    if (i.e) {
      const key = this.wrapKey();
      if (!key || !this.canOpen(i)) throw new Locked();
      raw = await decryptKind(raw, key, BlobKind.Thumbnail);
    }
    return new Blob([raw as Uint8Array<ArrayBuffer>], { type: "image/jpeg" });
  }
}

// ======================= 整个库 =======================

class Library {
  accounts = $state<Account[]>([]);
  /** 至少一把密钥已经解锁 */
  unlocked = $state(false);

  constructor() {
    this.accounts = loadAccounts().map((a) => new Account(a));
  }

  async loadAll() {
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("demo")) {
      const { demoDrive } = await import("./demo");
      const d = await demoDrive();
      const acc = new Account(d.account);
      acc.drive = d;
      this.accounts = [acc];
      (window as unknown as { demoDrive: unknown }).demoDrive = d;
    }
    return Promise.all(this.accounts.map((a) => a.load()));
  }

  /** 所有照片，按拍摄时间从新到旧；同一张照片备份在几个账号里时只显示一次。 */
  photos = $derived.by(() => {
    const out: Photo[] = [];
    const byHash = new Map<string, Photo>();
    for (const acc of this.accounts) {
      if (acc.state !== "ready") continue;
      for (const item of acc.items) {
        const dup = item.h ? byHash.get(item.h) : undefined;
        if (dup) {
          dup.copies.push({ acc, item });
          continue;
        }
        const p: Photo = { key: `${acc.key}/${item.r}`, acc, item, copies: [] };
        if (item.h) byHash.set(item.h, p);
        out.push(p);
      }
    }
    return out.sort((a, b) => b.item.t - a.item.t);
  });

  /** 有加密内容、需要输密码的账号 */
  get needsUnlock() {
    return this.accounts.some((a) => a.state === "locked");
  }

  get hasVault() {
    return this.accounts.some((a) => a.bundleJson);
  }

  async connect(kind: DriveKind) {
    const stored = await authSignIn(kind);
    const existing = this.accounts.find((a) => a.key === stored.key);
    if (existing) {
      existing.stored = stored;
      existing.drive = kind === "google" ? new GoogleDrive(stored) : new OneDrive(stored);
      await existing.load();
      return existing;
    }
    const acc = new Account(stored);
    this.accounts = [...this.accounts, acc];
    await acc.load();
    return acc;
  }

  /** 登录过期后重新连接（Google 大约每小时一次）。 */
  async reconnect(acc: Account) {
    acc.stored = await authSignIn(acc.stored.kind, acc.stored);
    if (acc.drive instanceof GoogleDrive) acc.drive = new GoogleDrive(acc.stored, (acc.drive as GoogleDrive).root);
    else acc.drive = new OneDrive(acc.stored);
    await acc.load();
  }

  disconnect(acc: Account) {
    removeAccount(acc.key);
    try {
      localStorage.removeItem(`zyll-pending-${acc.key}`);
    } catch {
      /* ignore */
    }
    this.accounts = this.accounts.filter((a) => a !== acc);
  }

  /** 用密码或恢复密钥解锁网盘里的密钥包（几个账号的密钥包一起试）。 */
  async unlock(secret: string, recovery: boolean) {
    const bundles = new Map<string, string>();
    for (const a of this.accounts) {
      const id = a.bundleVaultId;
      if (id && a.bundleJson && !keyring.has(id)) bundles.set(id, a.bundleJson);
    }
    if (!bundles.size) throw new Error("网盘里没有找到密钥包");
    let ok = 0;
    let lastErr: Error | null = null;
    for (const [, json] of bundles) {
      try {
        const r = await runKdf(recovery ? { op: "unlockRecovery", json, recoveryKey: secret } : { op: "unlockPassword", json, password: secret });
        const v = await keybundle.vaultFromMasterKey(r.vaultId, r.masterKey);
        keyring.set(v.vaultId, v.wrapKey);
        ok++;
      } catch (e) {
        lastErr = e as Error;
      }
    }
    if (!ok) throw lastErr ?? new Error("密码或恢复密钥不正确");
    this.unlocked = true;
    await Promise.all(this.accounts.filter((a) => a.state !== "ready" || a.items.some((i) => i.e)).map((a) => a.load()));
  }

  /** 锁上：丢掉内存里的密钥，加密的内容重新需要密码。 */
  lock() {
    keyring.clear();
    this.unlocked = false;
    for (const a of this.accounts) if (a.bundleJson) a.load();
  }
}

export const library = new Library();
export const isHeicItem = (i: IndexItem) => isHeic(i.m, i.n);
