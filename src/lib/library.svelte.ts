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

/** 出错时带上是哪一步（方便用户截图反馈）；需要解锁、需要登录的照原样抛出。 */
async function step<T>(label: string, job: () => Promise<T>): Promise<T> {
  try {
    return await job();
  } catch (e) {
    if (e instanceof Locked || e instanceof NeedsSignIn) throw e;
    const err = new Error(`${label}失败：${(e as Error).message || e}`);
    err.cause = e;
    throw err;
  }
}

/** 存放位置根目录的 storage.json（spec/sharing.md 第 7 节）。 */
async function readMarker(d: Drive): Promise<{ state: string; to: string; at: number } | null> {
  const id = await d.findFile(["storage.json"]);
  if (!id) return null;
  try {
    const o = JSON.parse(text.decode(await d.download(id)));
    if (o?.format !== "zyll-storage") return null;
    return { state: String(o.state ?? ""), to: String(o.to ?? ""), at: Number(o.at) || 0 };
  } catch {
    return null;
  }
}

const MIGRATING = "手机正在搬迁这个网盘的存储位置，搬完前网页版不能在这里上传或删除照片。";

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
  /** 有加密目录时，明文目录里多出来的条目：只显示，不写回 */
  extra: IndexItem[];
}

/** 网页删除了、还没确认已经写进网盘目录的墓碑。 */
interface PendingDel {
  r: string;
  /** 要删的文件（原图、缩略图），删掉后从这里去掉 */
  f: string[];
}

export type AccountState = "loading" | "ready" | "locked" | "signin" | "error";

export class Account {
  state = $state<AccountState>("loading");
  error = $state("");
  /** 不能写网盘的原因（目录回滚、手机正在搬迁存储位置等）；为空时可以上传和删除 */
  readOnly = $state("");
  /** 只读是因为网盘目录比本机见过的旧（手机选了“以网盘为准”或者被还原过） */
  rolledBack = $state(false);
  /** 手机正在搬迁存储位置：不能开始新的上传，已经传完的照常写进目录 */
  migrating = $state(false);
  /** 搬迁标记超过 3 天没更新（搬的手机可能不在了），可以让用户选择不再等它 */
  migrationStale = $state(false);
  private markerAt = 0;
  /** 搬迁后找不到了、需要重新上传的文件名 */
  lostUploads = $state<string[]>([]);
  items = $state.raw<IndexItem[]>([]);
  quota = $state<Quota>({});
  /** 网盘里有密钥包（开过端到端加密） */
  bundleJson = $state<string | null>(null);
  /** 库放在哪里（给设置页显示） */
  where = $state("");
  drive: Drive;
  private merged: Merged | null = null;
  private driveSeq = 0;
  private missingAtLoad = false;
  private verifyTimer: ReturnType<typeof setTimeout> | null = null;
  private encId: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(public stored: StoredAccount) {
    this.drive = stored.kind === "google" ? new GoogleDrive(stored) : new OneDrive(stored);
    this.where = stored.kind === "google" ? "Google 网盘 · 隐藏区" : "OneDrive · 应用/Zyll 相册";
  }

  get key() {
    return this.stored.key;
  }
  get label() {
    return `${this.stored.kind === "google" ? "Google 网盘" : "OneDrive"}（${this.stored.email}）`;
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
    // 网盘里有密钥包（开过加密）也按加密传，宁可多加密，不把照片明文传上去
    return !!this.encId || this.items.some((i) => i.e) || !!this.bundleJson;
  }

  /** 操作中途登录过期：切到“需要重新连接”状态，界面会显示提示条。 */
  noteError(e: unknown) {
    if (e instanceof NeedsSignIn) this.state = "signin";
  }

  private get seqKey() {
    return `zyll-seq-${this.key}`;
  }
  private get pendingKey() {
    return `zyll-pending-${this.key}`;
  }
  private get pendingDelKey() {
    return `zyll-pdel-${this.key}`;
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
        if (this.drive instanceof GoogleDrive) await step("查找存放位置", () => this.resolveGoogleRoot());
        const id = await step("查找密钥包", () => this.drive.findFile(KEYBUNDLE_PATH));
        this.bundleJson = id ? await step("读取密钥包", async () => text.decode(await this.drive.download(id))) : null;
        const p = await step("读取备份目录", () => this.pull());
        this.missingAtLoad = this.confirm(p.merged);
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
        this.where = `Google 网盘 · 我的云端硬盘/${VISIBLE_ROOT}`;
      } else {
        this.drive = hidden;
        this.where = "Google 网盘 · 隐藏区";
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
    let plainDoc: IndexDoc | null = null;
    if (plainId) plainDoc = parseIndex(text.decode(await this.drive.download(plainId)));
    // 加密目录解得开时，明文目录不参与合并和写回（能写网盘的人放一份明文目录，就能塞进假照片、假墓碑），
    // 只把它多出来的条目显示出来。没有加密目录时才以明文目录为准。
    if (plainDoc && !encDoc) docs.push(plainDoc);
    const merged = mergeDocs(docs);
    let extra: IndexItem[] = [];
    if (plainDoc && encDoc) {
      const have = new Set(merged.items.map((i) => i.r));
      extra = plainDoc.items.filter((i) => i.r && !i.e && !have.has(i.r) && !merged.deleted.has(i.r) && !plainDoc!.del.includes(i.r));
    }
    const seen = Number(lsGet(this.seqKey) ?? 0);
    this.driveSeq = merged.seq;
    this.readOnly = "";
    this.rolledBack = false;
    if (merged.hasSeq && merged.seq < seen) {
      this.rolledBack = true;
      this.readOnly = "网盘上的备份目录比这个浏览器上次看到的旧（手机选了“以网盘为准”，或者被还原过），暂时只能浏览。确认是手机上操作的，可以在设置里点“以网盘为准”。";
    }
    this.noteMarker(await readMarker(this.drive));
    return { merged, encId, plainId, extra };
  }

  private apply(p: Pulled) {
    this.merged = p.merged;
    this.encId = p.encId;
    if (p.merged.hasSeq && !this.rolledBack) lsSet(this.seqKey, String(Math.max(p.merged.seq, Number(lsGet(this.seqKey) ?? 0))));
    this.items = p.extra.length ? [...p.merged.items, ...p.extra] : p.merged.items;
  }

  /** 网盘目录比本机见过的旧，用户确认是手机上操作的：以网盘为准，解除只读。 */
  async trustDrive() {
    lsSet(this.seqKey, String(this.driveSeq));
    lsSet(this.writtenSeqKey, String(this.driveSeq));
    await this.load();
  }

  private get writtenSeqKey() {
    return `zyll-wseq-${this.key}`;
  }

  /**
   * 用从网盘读到的目录确认待写清单，返回是否有改动不在目录里（需要补写）。
   * 只有读到的 seq 比这个浏览器最后写的大（别的设备在我们之后又写过、并且保留了我们的改动），
   * 才算确认；seq 相等说明还是我们自己写的那份，手机可能正要覆盖，继续等。
   */
  private confirm(m: Merged): boolean {
    const has = new Set(m.items.map((i) => i.r));
    const addIn = (i: IndexItem) => has.has(i.r) || m.deleted.has(i.r);
    const delIn = (d: PendingDel) => m.deleted.has(d.r) && !has.has(d.r);
    const adds = this.pending();
    const dels = this.pendingDels();
    const missing = adds.some((i) => !addIn(i)) || dels.some((d) => !delIn(d));
    if (m.seq > Number(lsGet(this.writtenSeqKey) ?? 0)) {
      const keepAdds = adds.filter((i) => !addIn(i));
      if (keepAdds.length !== adds.length) this.setPending(keepAdds);
      // 墓碑确认了、文件也都删掉了才算完成
      const keepDels = dels.filter((d) => !delIn(d) || d.f.length > 0);
      if (keepDels.length !== dels.length) this.setPendingDels(keepDels);
    }
    return missing;
  }

  /** 重新读一次目录，确认待写清单；返回是否有改动不在目录里。 */
  async recheck(): Promise<boolean> {
    return this.lock(async () => {
      const p = await this.pull();
      const missing = this.confirm(p.merged);
      this.apply(p);
      return missing;
    });
  }

  get pendingAddCount(): number {
    return this.pending().length;
  }

  get unconfirmed(): number {
    return this.pending().length + this.pendingDels().length;
  }

  /** 把改动写进网盘目录：重新读一遍、合并、seq + 1、整份写回。 */
  commit(change: IndexChange, verify = true): Promise<void> {
    return this.lock(async () => {
      const p = await this.pull();
      if (this.readOnly) throw new Error(this.readOnly);
      // 这里不确认待写清单：刚写完马上读到的可能还是自己写的，手机可能紧接着覆盖。确认放在隔几秒的复查里。
      // 还没确认写进去的条目和墓碑每次都再带上（手机可能在我们写之后又整份覆盖了目录）
      const dels = this.pendingDels();
      const full: IndexChange = {
        add: [...(change.add ?? []), ...this.pending()],
        remove: [...(change.remove ?? []), ...dels.map((d) => d.r)],
        trash: [...(change.trash ?? []), ...dels.flatMap((d) => d.f)].filter((t) => !(change.trashDone ?? []).includes(t)),
        trashDone: change.trashDone,
      };
      const m = applyChange(p.merged, full);
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
      lsSet(this.writtenSeqKey, String(seq));
      this.apply({ merged: { ...m, seq, hasSeq: true }, encId: encrypt ? (p.encId ?? "new") : p.encId, plainId: p.plainId, extra: p.extra });
      if (verify) this.scheduleVerify();
    });
  }

  /**
   * 写完后隔一段时间再读目录（10 秒、1 分钟、3 分钟、10 分钟）：手机传目录可能要几十秒，
   * 看到改动不在目录里就立刻补写；都在但还没等到别的设备确认就接着等。之后交给下次打开页面。
   */
  /** 账号断开时停掉复查。 */
  dispose() {
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = null;
  }

  private scheduleVerify(step = 0) {
    const delays = [10_000, 60_000, 180_000, 600_000];
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = null;
    if (step >= delays.length || !this.unconfirmed) return;
    this.verifyTimer = setTimeout(() => {
      this.verifyTimer = null;
      this.recheck()
        .then(async (missing) => {
          if (missing && !this.readOnly) await this.commit({}, false);
          this.scheduleVerify(step + 1);
        })
        .catch(() => this.scheduleVerify(step + 1));
    }, delays[step]);
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

  private pendingDels(): PendingDel[] {
    try {
      const v = JSON.parse(lsGet(this.pendingDelKey) ?? "[]");
      return Array.isArray(v) ? v.filter((d) => d && typeof d.r === "string" && Array.isArray(d.f)) : [];
    } catch {
      return [];
    }
  }

  private setPendingDels(list: PendingDel[]) {
    lsSet(this.pendingDelKey, list.length ? JSON.stringify(list) : null);
  }

  /** 还没确认写进目录的上传和删除（比如中途关了页面、或者被手机覆盖了）：补写进去，不留孤儿文件。 */
  async flushPending() {
    if (!this.unconfirmed || this.readOnly) return;
    try {
      await this.dropMissing();
      // 目录里缺了才补写；都在只是还没确认的，接着复查
      if (this.missingAtLoad) await this.commit({});
      else this.scheduleVerify(1);
      this.missingAtLoad = false;
      await this.finishDeletes();
    } catch {
      /* 下次再试 */
    }
  }

  /** 网盘上的存储位置标记：手机开始搬迁或已经搬走，就不再开始新的上传。 */
  private async checkMarker() {
    this.noteMarker(await readMarker(this.drive));
    if (this.readOnly) throw new Error(this.readOnly);
    if (this.migrating) throw new Error(MIGRATING);
  }

  private get ignoreKey() {
    return `zyll-ignore-migrating-${this.key}`;
  }

  /**
   * 记下存储位置标记：moved 就只读；migrating 就不开始新上传。
   * 搬的手机每 10 分钟刷新 at，超过 3 天没变时允许用户“不再等它”（只认这一份 at，变了就重新等）。
   */
  private noteMarker(marker: { state: string; at: number } | null) {
    if (marker?.state === "moved") this.readOnly = "这个库已经搬到别的位置，请刷新页面。";
    const mig = marker?.state === "migrating";
    this.markerAt = mig ? marker!.at : 0;
    const ignored = mig && marker!.at > 0 && lsGet(this.ignoreKey) === String(marker!.at);
    this.migrating = mig && !ignored;
    this.migrationStale = this.migrating && marker!.at > 0 && Date.now() - marker!.at > 3 * 86_400_000;
    if (!mig) lsSet(this.ignoreKey, null);
  }

  /** 用户确认不再等那台搬迁中断的手机。 */
  stopWaitingMigration() {
    if (!this.markerAt) return;
    lsSet(this.ignoreKey, String(this.markerAt));
    this.migrating = false;
    this.migrationStale = false;
  }

  /** 补写前确认待写清单里的文件还在（搬迁后旧位置的文件会被清理掉），找不到的不写，记下来提示用户重新上传。 */
  private async dropMissing() {
    const list = this.pending();
    if (!list.length) return;
    const gone: IndexItem[] = [];
    for (const i of list) {
      try {
        if (!(await this.drive.exists(i.r))) gone.push(i);
      } catch {
        /* 查不了就先留着，下次再看 */
      }
    }
    if (!gone.length) return;
    this.setPending(this.pending().filter((i) => !gone.some((g) => g.r === i.r)));
    this.lostUploads = [...this.lostUploads, ...gone.map((g) => g.n)];
  }

  hasHash(h: string) {
    return (this.merged?.items ?? []).some((i) => i.h === h);
  }

  /**
   * 上传一个文件（原图 + 缩略图），返回目录条目；内容相同的照片已经在这个账号里时返回 null。
   * 条目先记进本机的待写清单，调用方攒一批后用 [commitUploads] 写进目录。
   */
  async uploadFile(
    f: File, album: string, onProgress: (phase: string, frac: number) => void, signal?: AbortSignal,
  ): Promise<IndexItem | null> {
    if (this.readOnly) throw new Error(this.readOnly);
    if (this.migrating) throw new Error(MIGRATING);
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
    // 每个文件上传前都看一眼存储位置标记，手机开始搬迁后立刻停（不然传上去的文件会被搬迁后的清理删掉）
    await this.checkMarker();
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

  /** 把待写清单里的条目写进目录。清单要等之后读目录确认了才清（见 confirm）。 */
  async commitUploads() {
    if (!this.pending().length) return;
    await this.commit({});
  }

  // ---------- 删除 ----------

  /** 从网盘永久删除：先在目录里写墓碑（别的设备据此删除记录），再删文件；删不掉的留给手机接着删。 */
  async remove(list: IndexItem[]) {
    // 只删真正在备份目录里的条目（加密时明文目录多出来的条目只是显示，不能据此删文件）
    const own = new Set((this.merged?.items ?? []).map((i) => i.r));
    list = list.filter((i) => own.has(i.r));
    if (!list.length) return;
    if (this.readOnly) throw new Error(this.readOnly);
    // 搬迁中不删：删掉旧位置的文件，新位置还会留着复制过去的那份（和 App 一致）
    await this.checkMarker();
    // 先记进本机的待确认墓碑：目录被别的设备覆盖掉时，下次写目录会再带上
    const dels = this.pendingDels();
    const added = list.filter((i) => !dels.some((d) => d.r === i.r)).map((i) => ({ r: i.r, f: [i.r, i.th].filter(Boolean) }));
    this.setPendingDels([...dels, ...added]);
    try {
      await this.commit({});
    } catch (e) {
      // 这次没删成：不留到以后偷偷删
      this.setPendingDels(this.pendingDels().filter((d) => !added.some((a) => a.r === d.r)));
      throw e;
    }
    await this.finishDeletes();
  }

  /** 删掉已经写进墓碑的文件；删不掉的留在 trash 里给手机接着删。 */
  private async finishDeletes() {
    const files = this.pendingDels().flatMap((d) => d.f);
    if (!files.length || this.readOnly || this.migrating) return;
    const done: string[] = [];
    for (const id of files) {
      try {
        await this.drive.delete(id);
        done.push(id);
      } catch {
        /* 下次再试；404 在 drive 里已经算删掉了 */
      }
    }
    if (!done.length) return;
    this.setPendingDels(this.pendingDels().map((d) => ({ ...d, f: d.f.filter((x) => !done.includes(x)) })));
    await this.commit({ trashDone: done }).catch(() => {});
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
    void this.unlocked; // 解锁、上锁后重新挑能打开的那份
    const out: Photo[] = [];
    const byHash = new Map<string, Photo>();
    for (const acc of this.accounts) {
      if (acc.state !== "ready") continue;
      for (const item of acc.items) {
        const dup = item.h ? byHash.get(item.h) : undefined;
        if (dup) {
          // 同一张照片有几份时，优先用这个浏览器能打开的那份
          if (!dup.acc.canOpen(dup.item) && acc.canOpen(item)) {
            dup.copies.push({ acc: dup.acc, item: dup.item });
            dup.acc = acc;
            dup.item = item;
            dup.key = `${acc.key}/${item.r}`;
          } else {
            dup.copies.push({ acc, item });
          }
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

  /** 断开账号。还有没写进目录的上传或删除时先补写一次，写不进去就报错（[force] 时照样断开）。 */
  async disconnect(acc: Account, force = false) {
    if (!force && acc.unconfirmed) {
      if (acc.state !== "ready" || acc.readOnly) throw new Error(`${acc.label} 还有 ${acc.unconfirmed} 项改动没写进网盘目录。`);
      await acc.flushPending();
      const missing = await acc.recheck().catch(() => true);
      if (!acc.unconfirmed) {
        /* 都确认了，可以断开 */
      } else if (missing) throw new Error(`${acc.label} 还有 ${acc.unconfirmed} 项改动没写进网盘目录，现在断开，刚上传的照片在手机上会看不到，删除的照片也可能回来。`);
      else throw new Error(`${acc.label} 刚才的改动已经写进网盘目录，但还没等到手机确认。手机如果正好在同时写目录，可能会把它们覆盖掉，过几分钟再断开更稳妥。`);
    }
    removeAccount(acc.key);
    acc.dispose();
    for (const k of [`zyll-pending-${acc.key}`, `zyll-pdel-${acc.key}`, `zyll-wseq-${acc.key}`]) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
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
