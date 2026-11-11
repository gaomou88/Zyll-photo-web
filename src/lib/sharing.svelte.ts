import { BlobKind, randomBytes, sha256, sharing, toHex, zylc } from "@zyll/crypto";
import { ENCRYPTED_FOLDER } from "./config";
import { GoogleDrive, ID_RE, isSharingDrive, type SharingDrive } from "./drive";
import { t } from "./i18n";
import { decryptKind } from "./zylcio";
import { Locked, library, lsGet, lsSet, type Account } from "./library.svelte";
import type { IndexItem } from "./indexdoc";

/**
 * 共享相册（网页版），和 App 的 SharedAlbums.kt 读写同样的文件：
 * 网盘上的 vault/identity.zylc（身份密钥）、vault/shared-albums.zylc（我的共享相册列表）、
 * 共享/<albumId>/album.json（签名的清单）和 index.zylc（用相册钥匙加密的目录）。见 spec/sharing.md。
 */

export type ShareRole = "viewer" | "contributor" | "manager";
export const ROLES: ShareRole[] = ["viewer", "contributor", "manager"];
const isRole = (s: unknown): s is ShareRole => ROLES.includes(s as ShareRole);
const canWrite = (r: ShareRole | null) => r === "contributor" || r === "manager";

export const SHARED_FOLDER = "共享";
const MANIFEST = "album.json";
const INDEX = "index.zylc";
const INDEX_NAME = /^index(-\d+(-[0-9a-f]{8})?)?\.zylc$/;
const LIST_PATH = [ENCRYPTED_FOLDER, "shared-albums.zylc"];
const LIST_BROKEN = [ENCRYPTED_FOLDER, "shared-albums-broken.zylc"];
const IDENTITY_PATH = [ENCRYPTED_FOLDER, "identity.zylc"];
/** 名片、加入链接都指向网页版，没装 App 的设备也能打开。 */
export const WEB = "https://photo.zyll.top/";

type SealedKey = sharing.SealedKey;
type ShareIdentity = sharing.ShareIdentity;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- base64 ----------

export function b64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 从链接里取出 `#<key>=<base64url JSON>`。 */
export function payload(text: string, key: string): Record<string, any> | null {
  const frag = text.includes("#") ? text.slice(text.indexOf("#") + 1) : "";
  const part = frag.split("&").find((p) => p.startsWith(key + "="));
  if (!part) return null;
  try {
    return JSON.parse(dec.decode(unb64(decodeURIComponent(part.slice(key.length + 1)))));
  } catch {
    return null;
  }
}

// ---------- 名片、成员、清单 ----------

export interface Member {
  x: Uint8Array;
  ed: Uint8Array;
  email: string;
  /** null = 主人 */
  role: ShareRole | null;
  since: number;
  fpHex: string;
  code: string;
}

async function member(x: Uint8Array, ed: Uint8Array, email: string, role: ShareRole | null, since: number): Promise<Member> {
  const fp = await sharing.fingerprint(x, ed);
  return { x, ed, email, role, since, fpHex: toHex(fp), code: sharing.safetyCode(fp) };
}

export interface ShareCard {
  provider: "google" | "onedrive";
  email: string;
  member: Member;
}

/** 解析名片链接、二维码内容或者名片 JSON；格式不对返回 null。 */
export async function parseCard(text: string): Promise<ShareCard | null> {
  try {
    const o = payload(text, "card") ?? JSON.parse(text.trim());
    if (o?.format !== "zyll-share-card") return null;
    const x = unb64(o.x);
    const ed = unb64(o.ed);
    if (x.length !== 32 || ed.length !== 32 || !o.email) return null;
    const provider = o.provider === "google" ? "google" : "onedrive";
    return { provider, email: String(o.email), member: await member(x, ed, String(o.email), null, 0) };
  } catch {
    return null;
  }
}

export interface Invite {
  provider: "google" | "onedrive";
  folder: string;
  album: string;
  name: string;
  owner: string;
  code: string;
}

export function parseInvite(text: string): Invite | null {
  const o = payload(text, "join");
  // 文件夹 id 来自别人：格式不对、或者没有主人安全码（没法核对主人）的链接都不收
  if (o?.format !== "zyll-shared-invite" || !ID_RE.test(String(o.album ?? "")) || !ID_RE.test(String(o.folder ?? "")) || !String(o.code ?? "").trim()) return null;
  return {
    provider: o.provider === "google" ? "google" : "onedrive",
    folder: String(o.folder), album: String(o.album), name: String(o.name ?? ""), owner: String(o.owner ?? ""), code: String(o.code ?? ""),
  };
}

interface Manifest {
  albumId: string;
  seq: number;
  epoch: number;
  owner: Member;
  members: Member[];
  keys: Record<string, SealedKey>;
  indexSha: string;
  indexSeq: number;
  /** 目录文件名（index-<seq>.zylc）；旧清单没有这个字段时是 index.zylc。 */
  indexFile: string;
  originals: boolean;
}

const memberJson = (m: Member) => ({ x: b64(m.x), ed: b64(m.ed), email: m.email, since: m.since, ...(m.role ? { role: m.role } : {}) });

function manifestBody(m: Manifest): Uint8Array {
  const keys: Record<string, unknown> = {};
  for (const [fp, k] of Object.entries(m.keys)) keys[fp] = { epk: b64(k.epk), nonce: b64(k.nonce), ct: b64(k.ct) };
  return enc.encode(JSON.stringify({
    albumId: m.albumId, seq: m.seq, epoch: m.epoch,
    owner: memberJson(m.owner),
    members: m.members.map(memberJson),
    keys,
    index: { sha256: m.indexSha, seq: m.indexSeq, ...(m.indexFile !== INDEX ? { file: m.indexFile } : {}) },
    opts: { originals: m.originals },
  }));
}

const signer = (m: Manifest, fpHex: string) => (m.owner.fpHex === fpHex ? m.owner : m.members.find((x) => x.fpHex === fpHex && x.role === "manager") ?? null);

class Tampered extends Error {
  constructor() {
    super(t("相册清单被改动过，已停止读取。"));
  }
}

/** 解析并验签。签名者必须是主人或清单里的管理者。 */
async function openManifest(text: string): Promise<Manifest> {
  let f: Record<string, any>;
  let o: Record<string, any>;
  let body: Uint8Array;
  try {
    f = JSON.parse(text);
    if (f.format !== "zyll-shared-album" || f.version !== 1) throw new Tampered();
    body = unb64(f.body);
    o = JSON.parse(dec.decode(body));
  } catch {
    throw new Tampered();
  }
  const mem = (x: Record<string, any>) => member(unb64(x.x), unb64(x.ed), String(x.email ?? ""), isRole(x.role) ? x.role : null, Number(x.since) || 0);
  const keys: Record<string, SealedKey> = {};
  for (const [fp, k] of Object.entries((o.keys ?? {}) as Record<string, any>)) keys[fp] = { epk: unb64(k.epk), nonce: unb64(k.nonce), ct: unb64(k.ct) };
  const m: Manifest = {
    albumId: String(o.albumId), seq: Number(o.seq) || 0, epoch: Number(o.epoch) || 0,
    owner: { ...(await mem(o.owner)), role: null },
    members: await Promise.all(((o.members ?? []) as Record<string, any>[]).map(mem)),
    keys,
    indexSha: String(o.index?.sha256 ?? ""), indexSeq: Number(o.index?.seq) || 0,
    indexFile: o.index?.file === undefined ? INDEX : String(o.index.file),
    originals: o.opts?.originals !== false,
  };
  if (!INDEX_NAME.test(m.indexFile)) throw new Tampered();
  const who = signer(m, String(f.by));
  if (!who || !(await sharing.verifyManifest(body, unb64(String(f.sig)), who.ed))) throw new Tampered();
  return m;
}

async function sealManifest(m: Manifest, me: ShareIdentity): Promise<string> {
  const body = manifestBody(m);
  return JSON.stringify({ format: "zyll-shared-album", version: 1, body: b64(body), by: me.fpHex, sig: b64(await sharing.signManifest(body, me.edPriv)) });
}

// ---------- 相册目录 ----------

export interface SharedItem {
  r: string;
  n: string;
  m: string;
  t: number;
  s: number;
  h: string;
  th: string;
  /** 原图 DEK；“只能看预览”时没有。 */
  dk: Uint8Array | null;
  tk: Uint8Array | null;
  by: string;
}

interface Index {
  name: string;
  seq: number;
  items: SharedItem[];
}

function indexJson(i: Index): Uint8Array {
  return enc.encode(JSON.stringify({
    v: 1, seq: i.seq, name: i.name,
    items: i.items.map((x) => ({ r: x.r, n: x.n, m: x.m, t: x.t, s: x.s, h: x.h, th: x.th, by: x.by, ...(x.dk ? { dk: b64(x.dk) } : {}), ...(x.tk ? { tk: b64(x.tk) } : {}) })),
    del: [],
  }));
}

function parseIndexJson(b: Uint8Array): Index {
  const o = JSON.parse(dec.decode(b));
  return {
    name: String(o.name ?? ""), seq: Number(o.seq) || 0,
    // 条目 id 来自主人或管理者：格式不对的条目丢掉，不拼进接口地址
    items: ((o.items ?? []) as Record<string, any>[]).filter((i) => ID_RE.test(String(i.r)) && (!i.th || ID_RE.test(String(i.th)))).map((i) => ({
      r: String(i.r), n: String(i.n ?? ""), m: String(i.m ?? ""), t: Number(i.t) || 0, s: Number(i.s) || 0, h: String(i.h ?? ""), th: String(i.th ?? ""),
      dk: i.dk ? unb64(i.dk) : null, tk: i.tk ? unb64(i.tk) : null, by: String(i.by ?? ""),
    })),
  };
}

// ---------- 本机记录 ----------

/** 本机记着的一个共享相册（自己建的或加入的）。 */
export interface AlbumRef {
  albumId: string;
  /** 本机账号（Account.key） */
  acc: string;
  folderId: string;
  name: string;
  /** null = 我是主人 */
  myRole: ShareRole | null;
  ownerEmail: string;
  ownerCode: string;
  count: number;
  addedAt: number;
}

const REFS = "zyll-shared-refs";
const REMOVED = "zyll-shared-removed";
const DIRTY = "zyll-shared-dirty";
const seqKey = (albumId: string) => `zyll-shared-seq-${albumId}`;

function dirtyList(): string[] {
  try {
    const a = JSON.parse(lsGet(DIRTY) ?? "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function loadRefs(): AlbumRef[] {
  try {
    const a = JSON.parse(lsGet(REFS) ?? "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function removedMap(): Record<string, number> {
  try {
    return JSON.parse(lsGet(REMOVED) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export type SharingProblem = "visible" | "encrypt" | "locked" | null;

class SharedAlbums {
  albums = $state<AlbumRef[]>(loadRefs());
  private identities = new Map<string, Promise<ShareIdentity>>();
  private queue: Promise<unknown> = Promise.resolve();

  /** 一次只做一件写操作（和 App 的 mutex 一样）。 */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});
    return run;
  }

  private persist(list: AlbumRef[]) {
    this.albums = list;
    lsSet(REFS, JSON.stringify(list));
  }

  private saveRef(ref: AlbumRef) {
    const old = this.albums.find((a) => a.albumId === ref.albumId);
    const r = { ...ref, addedAt: ref.addedAt || old?.addedAt || Date.now() };
    this.persist([...this.albums.filter((a) => a.albumId !== ref.albumId), r]);
    if (!old) this.pushLater(ref.acc);
  }

  private dropRef(albumId: string) {
    const old = this.albums.find((a) => a.albumId === albumId);
    if (!old) return;
    this.persist(this.albums.filter((a) => a.albumId !== albumId));
    lsSet(REMOVED, JSON.stringify({ ...removedMap(), [albumId]: Date.now() }));
    this.pushLater(old.acc);
  }

  /** 列表改了要推到网盘：先记下，推成功才去掉；没推上去的下次加载时再推。 */
  private pushLater(accKey: string) {
    lsSet(DIRTY, JSON.stringify([...new Set([...dirtyList(), accKey])]));
    const acc = library.accounts.find((a) => a.key === accKey);
    if (acc) this.syncList(acc).catch(() => {});
  }

  /** 上次没推上去的账号再推一次（库加载完、解锁后调用）。 */
  pushDirty() {
    for (const key of dirtyList()) {
      const acc = library.accounts.find((a) => a.key === key);
      if (acc && acc.state === "ready" && acc.wrapKey()) this.syncList(acc).catch(() => {});
    }
  }

  // ---------- 账号 ----------

  /** 这个账号现在能不能共享；不能时返回原因。 */
  problem(acc: Account): SharingProblem {
    if (acc.drive instanceof GoogleDrive && (acc.drive as GoogleDrive).root === "appDataFolder") return "visible";
    if (!acc.bundleJson) return "encrypt";
    if (!acc.wrapKey()) return "locked";
    return null;
  }

  /** 用这个账号加入别人的相册还缺什么：只要库开着加密并且已解锁（身份密钥存在库里），不要求可见文件夹。 */
  joinProblem(acc: Account): SharingProblem {
    if (!acc.bundleJson) return "encrypt";
    if (!acc.wrapKey()) return "locked";
    return null;
  }

  private sd(acc: Account): SharingDrive {
    if (!isSharingDrive(acc.drive)) throw new Error(t("这个网盘不支持共享相册"));
    return acc.drive;
  }

  private key(acc: Account): CryptoKey {
    const k = acc.wrapKey();
    if (!k) throw new Locked();
    return k;
  }

  /** 这个账号所在库的共享身份：网盘 vault/identity.zylc 里有就用，没有就生成并上传（和 App 共用）。 */
  identity(acc: Account): Promise<ShareIdentity> {
    let p = this.identities.get(acc.key);
    if (!p) {
      p = this.loadIdentity(acc);
      this.identities.set(acc.key, p);
      p.catch(() => this.identities.delete(acc.key));
    }
    return p;
  }

  private async loadIdentity(acc: Account): Promise<ShareIdentity> {
    const key = this.key(acc);
    const read = async (): Promise<ShareIdentity | null> => {
      const id = await acc.drive.findFile(IDENTITY_PATH);
      if (!id) return null;
      const o = JSON.parse(dec.decode(await decryptKind(await acc.drive.download(id), key, BlobKind.Other)));
      if (o?.format !== "zyll-identity") throw new Error(t("身份密钥文件格式不对"));
      return sharing.identityFrom(unb64(o.x), unb64(o.ed));
    };
    const existing = await read();
    if (existing) return existing;
    const fresh = await sharing.generateIdentity();
    const plain = enc.encode(JSON.stringify({ format: "zyll-identity", version: 1, x: b64(fresh.xPriv), ed: b64(fresh.edPriv), created: Date.now() }));
    const ct = await zylc.encrypt(plain, BlobKind.Other, key);
    // 上传前再查一次（手机可能刚好也在生成），上传后读回来：以网盘上的那份为准，两边不会各用一套
    const raced = await read();
    if (raced) return raced;
    await acc.drive.upload(IDENTITY_PATH, { size: ct.length, mime: "application/octet-stream", read: async (a, b) => ct.slice(a, b) }, { replace: true });
    // 网盘的列表有时稍晚才看得到刚写的文件：隔一会儿再读回来（和 App 一样等 2.5 秒）
    await new Promise((r) => setTimeout(r, 2500));
    return (await read()) ?? fresh;
  }

  /** 自己的分享名片：链接和安全码。 */
  async myCard(acc: Account): Promise<{ link: string; code: string }> {
    const me = await this.identity(acc);
    const card = { format: "zyll-share-card", version: 1, provider: acc.stored.kind, email: acc.stored.email, x: b64(me.xPub), ed: b64(me.edPub) };
    return { link: WEB + "#card=" + b64url(enc.encode(JSON.stringify(card))), code: sharing.safetyCode(me.fingerprint) };
  }

  // ---------- 网盘上的列表（换设备后找回，和 App 同步） ----------

  /**
   * 和网盘上的列表（vault/shared-albums.zylc，用 K_wrap 加密）合并再写回去。
   * 规则和 App 一样：两边的相册取并集；“已移除”记录比加入时间新的去掉；防回滚序号取大的。
   */
  private syncing = new Map<string, Promise<void>>();
  syncList(acc: Account): Promise<void> {
    const prev = this.syncing.get(acc.key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.doSyncList(acc));
    this.syncing.set(acc.key, run);
    return run;
  }

  private async doSyncList(acc: Account) {
    const key = this.key(acc);
    const id = await acc.drive.findFile(LIST_PATH);
    const remote: (AlbumRef & { seq: number })[] = [];
    const remoteRemoved: Record<string, number> = {};
    if (id) {
      const bytes = await acc.drive.download(id);
      let o: Record<string, any> | null = null;
      try {
        o = JSON.parse(dec.decode(await decryptKind(bytes, key, BlobKind.Other)));
        if (o?.format !== "zyll-shared-list") throw new Error("bad");
      } catch {
        // 另一套已解锁的密钥（换密钥过渡期）能解开：先不动它，等这边换完
        for (const k of library.wrapKeys()) {
          if (k === key) continue;
          if (await decryptKind(bytes, k, BlobKind.Other).then(() => true, () => false)) throw new Error(t("共享相册列表是用另一套密钥写的，暂时不改它"));
        }
        // 解不开或格式不对：另存一份，按本机列表重建（和 App 一样）
        o = null;
        await acc.drive.upload(LIST_BROKEN, { size: bytes.length, mime: "application/octet-stream", read: async (a, b) => bytes.slice(a, b) }, { replace: true });
      }
      if (o) {
        for (const a of (o.albums ?? []) as Record<string, any>[]) {
          if (!ID_RE.test(String(a.f)) || !ID_RE.test(String(a.a))) continue;
          remote.push({
            albumId: String(a.a), acc: acc.key, folderId: String(a.f), name: String(a.n ?? ""), myRole: isRole(a.role) ? a.role : null,
            ownerEmail: String(a.oe ?? ""), ownerCode: String(a.oc ?? ""), count: Number(a.c) || 0, addedAt: Number(a.t) || 0, seq: Number(a.seq) || 0,
          });
        }
        for (const [k, v] of Object.entries((o.removed ?? {}) as Record<string, number>)) remoteRemoved[k] = Number(v) || 0;
      }
    }
    const allRemoved = removedMap();
    for (const [k, v] of Object.entries(remoteRemoved)) if (v > (allRemoved[k] ?? 0)) allRemoved[k] = v;
    const now = Date.now();
    const mine = this.albums.filter((a) => a.acc === acc.key).map((a) => (a.addedAt === 0 && !(a.albumId in allRemoved) ? { ...a, addedAt: now } : a));
    const merged = [...mine, ...remote.filter((r) => !mine.some((m) => m.albumId === r.albumId)).map(({ seq: _, ...r }) => r)]
      .filter((r) => !(r.albumId in allRemoved) || allRemoved[r.albumId]! < r.addedAt);
    for (const r of remote) if (r.seq > Number(lsGet(seqKey(r.albumId)) ?? 0)) lsSet(seqKey(r.albumId), String(r.seq));
    lsSet(REMOVED, JSON.stringify(allRemoved));
    this.persist([...this.albums.filter((a) => a.acc !== acc.key), ...merged]);
    const plain = enc.encode(JSON.stringify({
      format: "zyll-shared-list", version: 1,
      albums: merged.map((r) => ({ a: r.albumId, f: r.folderId, n: r.name, role: r.myRole ?? "", oe: r.ownerEmail, oc: r.ownerCode, c: r.count, t: r.addedAt, seq: Number(lsGet(seqKey(r.albumId)) ?? 0) })),
      removed: allRemoved,
    }));
    const ct = await zylc.encrypt(plain, BlobKind.Other, key);
    await acc.drive.upload(LIST_PATH, { size: ct.length, mime: "application/octet-stream", read: async (a, b) => ct.slice(a, b) }, { replace: true });
    lsSet(DIRTY, JSON.stringify(dirtyList().filter((k) => k !== acc.key)));
  }

  /** 兜底：扫一遍自己网盘的「共享/」，主人是自己的相册认回来（列表丢了、旧版本建的）。 */
  private async scanOwned(acc: Account) {
    if (this.problem(acc)) return;
    const me = await this.identity(acc);
    const drive = this.sd(acc);
    const root = await drive.ensureFolder([SHARED_FOLDER]);
    const gone = removedMap();
    for (const [name, folderId] of await drive.listChildren(root)) {
      if (name in gone || this.albums.some((a) => a.albumId === name)) continue;
      try {
        const mid = await drive.findChild(folderId, MANIFEST);
        if (!mid) continue;
        const m = await openManifest(dec.decode(await drive.downloadAny(mid)));
        if (m.albumId !== name || m.owner.fpHex !== me.fpHex) continue;
        const draft: AlbumRef = { albumId: name, acc: acc.key, folderId, name: "", myRole: null, ownerEmail: m.owner.email, ownerCode: m.owner.code, count: 0, addedAt: 0 };
        const index = await this.readIndex(draft, m, await this.albumKey(m, me));
        if (m.seq > Number(lsGet(seqKey(name)) ?? 0)) lsSet(seqKey(name), String(m.seq));
        this.saveRef({ ...draft, name: index.name, count: index.items.length });
      } catch {
        /* 读不了的跳过 */
      }
    }
  }

  /** 打开共享页时和网盘同步；返回出错的账号说明（空 = 都好）。 */
  async sync(): Promise<string[]> {
    const errs: string[] = [];
    for (const acc of library.accounts) {
      if (acc.state !== "ready" || !acc.bundleJson || !acc.wrapKey() || !isSharingDrive(acc.drive)) continue;
      try {
        await this.syncList(acc);
        await this.scanOwned(acc);
      } catch (e) {
        errs.push(`${acc.label}：${(e as Error).message}`);
      }
    }
    return errs;
  }

  // ---------- 读写清单和目录 ----------

  private account(ref: AlbumRef): Account {
    const acc = library.accounts.find((a) => a.key === ref.acc);
    if (!acc) throw new Error(t("这个共享相册所在的网盘账号没有连接"));
    return acc;
  }

  private async loadManifest(ref: AlbumRef): Promise<Manifest> {
    const drive = this.sd(this.account(ref));
    const id = await drive.findChild(ref.folderId, MANIFEST);
    if (!id) throw new Error(t("读不到这个共享相册（可能已经停止共享，或者你被移出了）"));
    const m = await openManifest(dec.decode(await drive.downloadAny(id)));
    // 防回滚：清单序号不能比上次见过的小；主人不能变
    const seen = Number(lsGet(seqKey(ref.albumId)) ?? 0);
    if (m.albumId !== ref.albumId || m.seq < seen) throw new Tampered();
    if (ref.ownerCode && m.owner.code !== ref.ownerCode) throw new Tampered();
    // 旧记录里没有主人安全码：第一次读到时记下并固定，之后主人变了就拒绝
    if (!ref.ownerCode) {
      // 用列表里现在那条记录，免得把名字、数量、角色改回旧值
      const cur = this.albums.find((a) => a.albumId === ref.albumId);
      if (cur && !cur.ownerCode) this.saveRef({ ...cur, ownerCode: m.owner.code });
    }
    lsSet(seqKey(ref.albumId), String(m.seq));
    return m;
  }

  private async albumKey(m: Manifest, me: ShareIdentity): Promise<Uint8Array> {
    const sealed = m.keys[me.fpHex];
    if (!sealed) throw new Error(t("这个共享相册里没有给你的钥匙"));
    return sharing.openAlbumKey(sealed, m.albumId, m.epoch, me);
  }

  private async readIndex(ref: AlbumRef, m: Manifest, ak: Uint8Array): Promise<Index> {
    const drive = this.sd(this.account(ref));
    let id = await drive.findChild(ref.folderId, m.indexFile);
    if (!id) {
      // 另一个管理者可能刚写了新目录、删了旧的：重读一次清单
      const again = await this.loadManifest(ref);
      if (again.seq !== m.seq) return this.readIndex(ref, again, again.epoch === m.epoch ? ak : await this.albumKey(again, await this.identity(this.account(ref))));
      id = await drive.findChild(ref.folderId, m.indexFile);
      if (!id) throw new Error(t("暂时读不到，请稍后再试"));
    }
    const bytes = await drive.downloadAny(id);
    // 有写权限的成员能替换文件，但改不了签过名的清单：哈希对不上就不读
    if (toHex(await sha256(bytes)) !== m.indexSha) throw new Tampered();
    return parseIndexJson(await decryptKind(bytes, await sharing.albumWrapKey(ak, m.albumId), BlobKind.IndexSnapshot));
  }

  /** 写目录和清单（主人或管理者），返回新清单。 */
  private async writeAlbum(ref: AlbumRef, m: Manifest, me: ShareIdentity, ak: Uint8Array, index: Index): Promise<Manifest> {
    const drive = this.sd(this.account(ref));
    // 新目录用新名字，清单写成功后才删旧的：
    // 清单没写成时旧清单还指向旧目录，相册照常能打开
    // 文件名用新清单的 seq 加随机后缀（和 App 一致）：不会和旧清单指向的那份同名，
    // 两个管理者同时写也不会互相覆盖
    const file = `index-${m.seq + 1}-${toHex(randomBytes(4))}.zylc`;
    // 写之前再读一次清单：这期间别人改过（seq 变了）就不覆盖，让用户再试一次
    if (m.indexSha) {
      const mid = await drive.findChild(ref.folderId, MANIFEST);
      const now = mid ? await openManifest(dec.decode(await drive.downloadAny(mid))) : null;
      if (!now || now.seq !== m.seq) throw new Error(t("相册刚被别人改过，请再试一次"));
    }
    const ct = await zylc.encrypt(indexJson(index), BlobKind.IndexSnapshot, await sharing.albumWrapKey(ak, m.albumId));
    await drive.uploadInto(ref.folderId, file, ct, "application/octet-stream");
    const next: Manifest = { ...m, seq: m.seq + 1, indexSha: toHex(await sha256(ct)), indexSeq: index.seq, indexFile: file };
    await drive.uploadInto(ref.folderId, MANIFEST, enc.encode(await sealManifest(next, me)), "application/json");
    lsSet(seqKey(ref.albumId), String(next.seq));
    // 只删上一份清单指向的那个文件；别的目录文件只删没被引用、超过一天没改过的
    // （另一个管理者刚写的新目录不能删）。和 App 一致。
    try {
      const old = m.indexSha ? await drive.findChild(ref.folderId, m.indexFile) : null;
      if (old && m.indexFile !== file) await drive.deleteAny(old);
      const dayAgo = Date.now() - 86_400_000;
      for (const [name, id, at] of await drive.listChildren(ref.folderId)) {
        if (name !== file && name !== m.indexFile && INDEX_NAME.test(name) && at > 0 && at < dayAgo) await drive.deleteAny(id).catch(() => {});
      }
    } catch {
      /* 留着也不影响读取 */
    }
    return next;
  }

  // ---------- 主人：建相册、加照片 ----------

  /** 取出照片的 DEK，组成共享目录里的条目。不加密的、用旧密钥加密的、读不到头部的跳过。 */
  private async itemsFor(acc: Account, items: IndexItem[], me: ShareIdentity, originals: boolean): Promise<SharedItem[]> {
    const key = this.key(acc);
    const drive = this.sd(acc);
    const seen = new Set<string>();
    const out: SharedItem[] = [];
    for (const r of items) {
      if (seen.has(r.r) || !r.e || r.k) continue;
      seen.add(r.r);
      try {
        const dk = await zylc.unwrapDek(await drive.head(r.r, zylc.HEADER_LEN), key);
        const tk = r.th ? await zylc.unwrapDek(await drive.head(r.th, zylc.HEADER_LEN), key) : null;
        out.push({ r: r.r, n: r.n, m: r.m, t: r.t, s: r.s, h: r.h, th: r.th, dk: originals ? dk : null, tk, by: me.fpHex });
      } catch {
        /* 跳过 */
      }
    }
    return out;
  }

  /** 把选中的照片共享成一个新相册。返回成功放进去的张数。 */
  create(acc: Account, name: string, items: IndexItem[], originals: boolean): Promise<AlbumRef> {
    return this.serial(async () => {
      const bad = this.problem(acc);
      if (bad) throw new Error(problemText(bad));
      const me = await this.identity(acc);
      const albumId = crypto.randomUUID();
      const folderId = await this.sd(acc).ensureFolder([SHARED_FOLDER, albumId]);
      const ak = randomBytes(32);
      const owner = await member(me.xPub, me.edPub, acc.stored.email, null, Date.now());
      const keys = { [me.fpHex]: await sharing.sealAlbumKey(ak, albumId, 1, me.xPub, me.fpHex) };
      const m: Manifest = { albumId, seq: 0, epoch: 1, owner, members: [], keys, indexSha: "", indexSeq: 0, indexFile: INDEX, originals };
      const ref: AlbumRef = { albumId, acc: acc.key, folderId, name, myRole: null, ownerEmail: acc.stored.email, ownerCode: owner.code, count: 0, addedAt: 0 };
      const shared = await this.itemsFor(acc, items, me, originals);
      if (!shared.length) throw new Error(t("选中的照片里没有可以共享的（只能共享用现在这套密钥加密的照片）"));
      await this.writeAlbum(ref, m, me, ak, { name, seq: 1, items: shared });
      const done = { ...ref, count: shared.length };
      this.saveRef(done);
      return done;
    });
  }

  /** 往自己管理的相册里加照片，并授权给现有成员。返回新加的张数。 */
  addPhotos(albumId: string, items: IndexItem[]): Promise<number> {
    return this.serial(async () => {
      const ref = this.ref(albumId);
      const acc = this.account(ref);
      const me = await this.identity(acc);
      const m = await this.loadManifest(ref);
      if (!signer(m, me.fpHex)) throw new Error(t("你没有管理这个相册的权限"));
      const ak = await this.albumKey(m, me);
      const index = await this.readIndex(ref, m, ak);
      const known = new Set(index.items.map((i) => i.r));
      const added = await this.itemsFor(acc, items.filter((i) => !known.has(i.r)), me, m.originals);
      if (!added.length) return 0;
      const drive = this.sd(acc);
      for (const x of m.members) for (const i of added) await grantItem(drive, i, x.email);
      await this.writeAlbum(ref, m, me, ak, { name: index.name, seq: index.seq + 1, items: [...index.items, ...added] });
      this.saveRef({ ...ref, count: index.items.length + added.length });
      return added.length;
    });
  }

  /** 从相册里删掉照片（主人或管理者）。照片本身还在原来的备份里，只是不再共享。 */
  removePhotos(albumId: string, ids: string[]): Promise<void> {
    return this.serial(async () => {
      const ref = this.ref(albumId);
      const acc = this.account(ref);
      const me = await this.identity(acc);
      const m = await this.loadManifest(ref);
      if (!signer(m, me.fpHex)) throw new Error(t("你没有管理这个相册的权限"));
      const ak = await this.albumKey(m, me);
      const index = await this.readIndex(ref, m, ak);
      const gone = index.items.filter((i) => ids.includes(i.r));
      if (!gone.length) return;
      await this.writeAlbum(ref, m, me, ak, { name: index.name, seq: index.seq + 1, items: index.items.filter((i) => !ids.includes(i.r)) });
      // 自己网盘里的照片：撤掉成员的读权限（别人的照片撤不了，跳过）
      const drive = this.sd(acc);
      const keep = await this.sharedElsewhere(acc, albumId);
      for (const x of m.members) for (const i of gone) await revokeItem(drive, i, x.email, keep);
      this.saveRef({ ...ref, count: index.items.length - gone.length });
    });
  }

  /**
   * 照片的读权限按“文件 + 邮箱”给，不分相册：撤之前看这个账号管理的其他共享相册，
   * 照片还在那边、这个邮箱也还是那边的成员，就不撤。有相册读不出来时一律不撤（宁可多留）。
   */
  private async sharedElsewhere(acc: Account, albumId: string): Promise<Keep> {
    const me = await this.identity(acc);
    // 先和网盘上的列表同步（手机刚建的相册也算进去）；同步不了就一张都不撤
    try {
      await this.syncList(acc);
    } catch {
      return () => true;
    }
    const byEmail = new Map<string, Set<string>>();
    for (const ref of this.albums) {
      if (ref.acc !== acc.key || ref.albumId === albumId || (ref.myRole !== null && ref.myRole !== "manager")) continue;
      try {
        const m = await this.loadManifest(ref);
        const index = await this.readIndex(ref, m, await this.albumKey(m, me));
        for (const x of m.members) {
          const e = x.email.toLowerCase();
          const set = byEmail.get(e) ?? new Set<string>();
          for (const i of index.items) {
            set.add(i.r);
            if (i.th) set.add(i.th);
          }
          byEmail.set(e, set);
        }
      } catch {
        return () => true;
      }
    }
    return (fileId, email) => !!byEmail.get(email.toLowerCase())?.has(fileId);
  }

  // ---------- 成员管理 ----------

  /** 邀请：封装相册钥匙给对方、授权网盘文件夹和照片、签新清单。返回发给对方的加入链接。 */
  invite(albumId: string, card: ShareCard, role: ShareRole): Promise<string> {
    return this.serial(async () => {
      const ref = this.ref(albumId);
      const acc = this.account(ref);
      if (card.provider !== acc.stored.kind) throw new Error(t("对方的网盘和这个相册不是同一家，第一版只支持同一家网盘内共享"));
      const me = await this.identity(acc);
      const m = await this.loadManifest(ref);
      if (!signer(m, me.fpHex)) throw new Error(t("你没有管理这个相册的权限"));
      const ak = await this.albumKey(m, me);
      const index = await this.readIndex(ref, m, ak);
      const drive = this.sd(acc);
      await drive.grant(ref.folderId, card.email, canWrite(role));
      for (const i of index.items) await grantItem(drive, i, card.email);
      const who = { ...card.member, role, since: Date.now() };
      const keys = { ...m.keys, [who.fpHex]: await sharing.sealAlbumKey(ak, albumId, m.epoch, who.x, who.fpHex) };
      const next: Manifest = { ...m, members: [...m.members.filter((x) => x.fpHex !== who.fpHex), who], keys };
      await this.writeAlbum(ref, next, me, ak, index);
      return joinLink(ref, m.owner.code);
    });
  }

  /** 改权限：网盘文件夹权限跟着改；从可写降为只读时换相册钥匙。 */
  setRole(albumId: string, fpHex: string, role: ShareRole): Promise<void> {
    return this.serial(async () => {
      const ref = this.ref(albumId);
      const acc = this.account(ref);
      const me = await this.identity(acc);
      const m = await this.loadManifest(ref);
      if (!signer(m, me.fpHex)) throw new Error(t("你没有管理这个相册的权限"));
      const who = m.members.find((x) => x.fpHex === fpHex);
      if (!who) return;
      const drive = this.sd(acc);
      const members = m.members.map((x) => (x.fpHex === fpHex ? { ...x, role } : x));
      await fixFolder(drive, ref.folderId, who.email, m.members, members);
      if (canWrite(who.role) && !canWrite(role)) {
        await this.rotate(ref, m, me, members);
      } else {
        const ak = await this.albumKey(m, me);
        await this.writeAlbum(ref, { ...m, members }, me, ak, await this.readIndex(ref, m, ak));
      }
    });
  }

  /** 移除成员：撤网盘权限，换新相册钥匙只封装给剩下的人。对方下载过的照片收不回来。 */
  removeMember(albumId: string, fpHex: string): Promise<void> {
    return this.serial(async () => {
      const ref = this.ref(albumId);
      const acc = this.account(ref);
      const me = await this.identity(acc);
      const m = await this.loadManifest(ref);
      if (!signer(m, me.fpHex)) throw new Error(t("你没有管理这个相册的权限"));
      const who = m.members.find((x) => x.fpHex === fpHex);
      if (!who) return;
      const drive = this.sd(acc);
      const index = await this.readIndex(ref, m, await this.albumKey(m, me));
      const rest = m.members.filter((x) => x.fpHex !== fpHex);
      // 同一个邮箱可能还以别的身份留在相册里：文件夹权限按它们里最高的角色给，照片的读权限不撤
      await fixFolder(drive, ref.folderId, who.email, m.members, rest).catch(() => {});
      if (!sameEmail(rest, who.email).length) {
        const keep = await this.sharedElsewhere(acc, albumId);
        for (const i of index.items) await revokeItem(drive, i, who.email, keep);
      }
      await this.rotate(ref, m, me, rest);
    });
  }

  private async rotate(ref: AlbumRef, m: Manifest, me: ShareIdentity, members: Member[]) {
    const index = await this.readIndex(ref, m, await this.albumKey(m, me));
    const ak = randomBytes(32);
    const epoch = m.epoch + 1;
    const keys: Record<string, SealedKey> = {};
    keys[m.owner.fpHex] = await sharing.sealAlbumKey(ak, m.albumId, epoch, m.owner.x, m.owner.fpHex);
    for (const x of members) keys[x.fpHex] = await sharing.sealAlbumKey(ak, m.albumId, epoch, x.x, x.fpHex);
    await this.writeAlbum(ref, { ...m, epoch, members, keys }, me, ak, { name: index.name, seq: index.seq + 1, items: index.items });
  }

  /** 主人停止共享：撤掉所有人的权限，删掉共享文件夹。照片本身还在自己的备份里。 */
  stopSharing(albumId: string): Promise<void> {
    return this.serial(async () => {
      const ref = this.ref(albumId);
      if (ref.myRole !== null) throw new Error(t("只有主人能停止共享"));
      const acc = this.account(ref);
      const me = await this.identity(acc);
      const m = await this.loadManifest(ref);
      const index = await this.readIndex(ref, m, await this.albumKey(m, me));
      const drive = this.sd(acc);
      const keep = await this.sharedElsewhere(acc, albumId);
      for (const x of m.members) for (const i of index.items) await revokeItem(drive, i, x.email, keep);
      await drive.deleteAny(ref.folderId);
      this.dropRef(albumId);
    });
  }

  /** 成员退出：只删本机记录（主人移除后网盘权限才会撤掉）。 */
  leave(albumId: string) {
    this.dropRef(albumId);
  }

  // ---------- 成员：加入、浏览 ----------

  /** 用账号 [acc] 加入相册：读清单、验签、核对主人安全码、确认有给自己的钥匙。 */
  join(acc: Account, inv: Invite): Promise<AlbumRef> {
    return this.serial(async () => {
      if (inv.provider !== acc.stored.kind) throw new Error(t("这个邀请来自另一家网盘，请用同一家网盘的账号加入"));
      const me = await this.identity(acc);
      const draft: AlbumRef = { albumId: inv.album, acc: acc.key, folderId: inv.folder, name: inv.name, myRole: "viewer", ownerEmail: inv.owner, ownerCode: inv.code, count: 0, addedAt: 0 };
      let m: Manifest;
      try {
        m = await this.loadManifest(draft);
      } catch (e) {
        if (e instanceof Tampered) throw e;
        throw new Error(t("读不到这个共享相册。请确认对方已经用你这个账号的名片邀请了你。"));
      }
      const mine = m.members.find((x) => x.fpHex === me.fpHex);
      if (!mine) throw new Error(t("这个相册里没有你。请把你这个账号的名片发给对方，让对方邀请你。"));
      const index = await this.readIndex(draft, m, await this.albumKey(m, me));
      const ref = { ...draft, name: index.name, myRole: mine.role ?? "viewer", count: index.items.length };
      this.saveRef(ref);
      return ref;
    });
  }

  /** 相册详情：照片和成员（先读清单、验签）。 */
  async open(albumId: string): Promise<{ items: SharedItem[]; owner: Member; members: Member[]; canManage: boolean; originals: boolean }> {
    const ref = this.ref(albumId);
    const acc = this.account(ref);
    const me = await this.identity(acc);
    const m = await this.loadManifest(ref);
    const index = await this.readIndex(ref, m, await this.albumKey(m, me));
    const mine = ref.myRole === null ? null : m.members.find((x) => x.fpHex === me.fpHex);
    this.saveRef({ ...ref, name: index.name, myRole: ref.myRole === null ? null : (mine?.role ?? ref.myRole), count: index.items.length });
    return { items: index.items, owner: m.owner, members: m.members, canManage: !!signer(m, me.fpHex), originals: m.originals };
  }

  /** 下载并解密一张照片的缩略图或原图。 */
  async file(albumId: string, item: SharedItem, original: boolean): Promise<Blob | null> {
    const ref = this.ref(albumId);
    const drive = this.sd(this.account(ref));
    const thumb = !original && !!item.th;
    const id = thumb ? item.th : item.r;
    const dek = thumb ? item.tk : item.dk;
    const bytes = await drive.downloadAny(id);
    let plain: Uint8Array;
    if (dek) {
      plain = await zylc.decryptWithDek(bytes, dek, thumb ? BlobKind.Thumbnail : BlobKind.Original);
    } else {
      // 成员上传的照片用相册钥匙加密；解不开就是“只能看预览”的原图
      const acc = this.account(ref);
      const m = await this.loadManifest(ref);
      const ak = await this.albumKey(m, await this.identity(acc));
      try {
        plain = await decryptKind(bytes, await sharing.albumWrapKey(ak, m.albumId), thumb ? BlobKind.Thumbnail : BlobKind.Original);
      } catch {
        return null;
      }
    }
    return new Blob([plain as Uint8Array<ArrayBuffer>], { type: thumb ? "image/jpeg" : item.m || "application/octet-stream" });
  }

  ref(albumId: string): AlbumRef {
    const r = this.albums.find((a) => a.albumId === albumId);
    if (!r) throw new Error(t("本机没有这个共享相册"));
    return r;
  }

  joinLink(albumId: string): string {
    const r = this.ref(albumId);
    return joinLink(r, r.ownerCode);
  }

  /** 锁上时忘掉身份私钥。 */
  forget() {
    this.identities.clear();
  }
}

function joinLink(ref: AlbumRef, ownerCode: string): string {
  const acc = library.accounts.find((a) => a.key === ref.acc);
  const o = {
    format: "zyll-shared-invite", version: 1, provider: acc?.stored.kind ?? "onedrive",
    folder: ref.folderId, album: ref.albumId, name: ref.name, owner: ref.ownerEmail, code: ownerCode,
  };
  return WEB + "#join=" + b64url(enc.encode(JSON.stringify(o)));
}

const sameEmail = (list: Member[], email: string) => list.filter((x) => x.email.toLowerCase() === email.toLowerCase());

/** 一个邮箱在共享文件夹上的权限：按这个邮箱下所有身份里最高的角色（没有身份了就撤掉）。 */
async function fixFolder(drive: SharingDrive, folderId: string, email: string, before: Member[], after: Member[]) {
  const level = (list: Member[]) => {
    const mine = sameEmail(list, email);
    return !mine.length ? 0 : mine.some((x) => canWrite(x.role)) ? 2 : 1;
  };
  const was = level(before);
  const now = level(after);
  if (was === now) return;
  await drive.revokeEmail(folderId, email);
  if (now) await drive.grant(folderId, email, now === 2);
}

async function grantItem(drive: SharingDrive, i: SharedItem, email: string) {
  // 照片文件只给读权限；写权限只在共享文件夹上
  await drive.grant(i.r, email, false);
  if (i.th) await drive.grant(i.th, email, false);
}

/** 撤一张照片对 [email] 的读权限；[keep] 说某个文件在别的相册里还共享给这个人时跳过。 */
async function revokeItem(drive: SharingDrive, i: SharedItem, email: string, keep: Keep) {
  if (!keep(i.r, email)) await drive.revokeEmail(i.r, email).catch(() => {});
  if (i.th && !keep(i.th, email)) await drive.revokeEmail(i.th, email).catch(() => {});
}

type Keep = (fileId: string, email: string) => boolean;

export function problemText(p: SharingProblem): string {
  switch (p) {
    case "visible":
      return t("这个 Google 账号的库放在隐藏区，隐藏区的文件不能共享。请在手机 Zyll 里打开“分享功能”，等库搬到可见的“Zyll 相册”文件夹后再来。");
    case "encrypt":
      return t("共享相册只能共享加密的照片。请先给这个网盘开启端到端加密。");
    case "locked":
      return t("请先解锁加密的照片。");
    default:
      return "";
  }
}

export const shared = new SharedAlbums();
