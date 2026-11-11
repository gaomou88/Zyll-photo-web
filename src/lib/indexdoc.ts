import { TOMBSTONE_MAX, TRASH_IN_INDEX } from "./config";
import { t } from "./i18n";

/**
 * 网盘备份目录（index.json / vault/index.zylc 的明文），格式见 spec/vault-layout.md。
 * 读写规则照搬安卓 CloudBackup.pullIndex / uploadIndex：
 * - 两份目录按 seq 从新到旧合并，同一个文件取新的那份，墓碑（del）里的去掉；
 * - 写回时 seq = max(网盘, 本机上次见过的) + 1，别的设备写的条目、mode、settings 原样保留；
 * - 只能写明文目录时不写加密条目（它们留在加密目录里）；
 * - 手机搬存放位置时换了文件 id，目录里带一张对照表（mv）：读的时候先把旧 id 换成新的，写回时原样带上（过期的去掉）。
 */

/** 对照表在目录里保留多久（和安卓一致）。 */
const MOVES_KEEP_MS = 90 * 24 * 3600 * 1000;

/** 搬存放位置时换过的 id：旧 id → { 新 id, 搬的时间 }。 */
export type IdMoves = Map<string, { n: string; at: number }>;

export interface IndexItem {
  /** 网盘文件 id */
  r: string;
  /** 是否加密 */
  e: boolean;
  /** 文件名 */
  n: string;
  /** 相簿 */
  a: string;
  m: string;
  /** 拍摄时间（毫秒） */
  t: number;
  /** 明文大小 */
  s: number;
  /** 明文 SHA-256（小写十六进制），旧条目可能为空 */
  h: string;
  /** 缩略图文件 id */
  th: string;
  /** 上传它的设备 */
  d: string;
  /** 加密用的密钥（和目录不是同一套时） */
  k: string;
  /**
   * 动态照片：文件里嵌着一段短视频（spec/motion-photo.md）。只是给照片墙打标记用的提示：
   * 没有这个字段不代表不是动态照片（旧版本写的、或别的设备没识别），打开时还会按内容再找一次。
   */
  mo?: boolean;
}

export interface IndexDoc {
  seq: number;
  hasSeq: boolean;
  items: IndexItem[];
  del: string[];
  trash: string[];
  mode: { enc: boolean; at: number } | null;
  settings: Record<string, unknown> | null;
  mv: IdMoves;
}

export class IndexCorrupt extends Error {
  constructor(cause?: unknown) {
    super(t("网盘上的备份目录损坏了，请在手机上处理（以手机为准重建）"));
    this.cause = cause;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseIndex(text: string): IndexDoc {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch (e) {
    throw new IndexCorrupt(e);
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new IndexCorrupt();
  const d = o as Record<string, unknown>;
  const arr = (v: unknown, name: string): unknown[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new IndexCorrupt(name);
    return v;
  };
  const items = arr(d.items, "items").map((x) => {
    if (!x || typeof x !== "object") throw new IndexCorrupt("item");
    const i = x as Record<string, unknown>;
    return {
      r: str(i.r), e: i.e === true, n: str(i.n), a: str(i.a), m: str(i.m), t: num(i.t), s: num(i.s),
      h: str(i.h), th: str(i.th), d: str(i.d), k: str(i.k),
      ...(i.mo === true ? { mo: true } : {}),
    } satisfies IndexItem;
  });
  const mv: IdMoves = new Map();
  for (const x of arr(d.mv, "mv")) {
    if (!x || typeof x !== "object") continue;
    const m = x as Record<string, unknown>;
    const o = str(m.o), n = str(m.n);
    if (o && n && o !== n) mv.set(o, { n, at: num(m.at) });
  }
  const mode = d.mode && typeof d.mode === "object" ? { enc: (d.mode as { enc?: unknown }).enc === true, at: num((d.mode as { at?: unknown }).at) } : null;
  return {
    seq: num(d.seq),
    hasSeq: typeof d.seq === "number",
    items,
    del: arr(d.del, "del").filter((x): x is string => typeof x === "string"),
    trash: arr(d.trash, "trash").filter((x): x is string => typeof x === "string"),
    mode,
    settings: d.settings && typeof d.settings === "object" && !Array.isArray(d.settings) ? (d.settings as Record<string, unknown>) : null,
    mv,
  };
}

export interface Merged {
  seq: number;
  hasSeq: boolean;
  items: IndexItem[];
  deleted: Set<string>;
  /** 墓碑按出现顺序（裁剪时保留新的） */
  delList: string[];
  trash: Set<string>;
  mode: IndexDoc["mode"];
  settings: IndexDoc["settings"];
  mv: IdMoves;
}

/** 合并读到的几份目录（加密那份 + 明文那份）。各份里的旧 id 先按对照表换成新的。 */
export function mergeDocs(docs: IndexDoc[]): Merged {
  const sorted = [...docs].sort((a, b) => b.seq - a.seq);
  const mv: IdMoves = new Map();
  for (const d of sorted) for (const [o, v] of d.mv) if (!mv.has(o)) mv.set(o, v);
  const moved = (id: string) => mv.get(id)?.n ?? id;
  const deleted = new Set<string>();
  const delList: string[] = [];
  for (const d of sorted) for (const r0 of d.del) { const r = moved(r0); if (!deleted.has(r)) { deleted.add(r); delList.push(r); } }
  const seen = new Set<string>();
  const items: IndexItem[] = [];
  for (const d of sorted) {
    for (const o0 of d.items) {
      const o = mv.has(o0.r) || mv.has(o0.th) ? { ...o0, r: moved(o0.r), th: o0.th ? moved(o0.th) : "" } : o0;
      if (o.r && !deleted.has(o.r) && !seen.has(o.r)) { seen.add(o.r); items.push(o); }
    }
  }
  const trash = new Set<string>();
  for (const d of sorted) d.trash.forEach((t) => trash.add(moved(t)));
  return {
    seq: sorted.reduce((m, d) => Math.max(m, d.seq), 0),
    hasSeq: sorted.some((d) => d.hasSeq),
    items, deleted, delList, trash,
    mode: sorted.find((d) => d.mode)?.mode ?? null,
    settings: sorted.find((d) => d.settings)?.settings ?? null,
    mv,
  };
}

/** 一次改动：加条目、删条目（写墓碑）、登记待删除文件、清掉已经删掉的文件。 */
export interface IndexChange {
  add?: IndexItem[];
  remove?: string[];
  trash?: string[];
  trashDone?: string[];
  /** 开启加密（网页首次设置时用），只在目录里还没有 mode 时写 */
  mode?: { enc: boolean; at: number };
}

export function applyChange(m: Merged, c: IndexChange): Merged {
  const remove = new Set(c.remove ?? []);
  const delList = [...m.delList];
  const deleted = new Set(m.deleted);
  for (const r of remove) if (!deleted.has(r)) { deleted.add(r); delList.push(r); }
  const items = m.items.filter((i) => !remove.has(i.r));
  const have = new Set(items.map((i) => i.r));
  for (const a of c.add ?? []) if (a.r && !have.has(a.r) && !deleted.has(a.r)) { have.add(a.r); items.push(a); }
  const trash = new Set(m.trash);
  (c.trash ?? []).forEach((t) => trash.add(t));
  (c.trashDone ?? []).forEach((t) => trash.delete(t));
  // 还有条目在用的文件不能留在待删除里（别的设备会把它删掉）
  for (const i of items) {
    trash.delete(i.r);
    if (i.th) trash.delete(i.th);
  }
  return { ...m, items, deleted, delList, trash, mode: m.mode ?? c.mode ?? null };
}

/** 生成要上传的目录 JSON。[encrypt] 为 false 时不写加密条目。 */
export function serializeIndex(m: Merged, seq: number, encrypt: boolean): string {
  const items = m.items.filter((i) => encrypt || !i.e).map((i) => {
    const o: Record<string, unknown> = { r: i.r, e: i.e, n: i.n, a: i.a, m: i.m, t: i.t, s: i.s, h: i.h, th: i.th, d: i.d };
    if (i.k) o.k = i.k;
    if (i.mo) o.mo = true;
    return o;
  });
  const doc: Record<string, unknown> = {
    v: 2,
    seq,
    items,
    del: m.delList.slice(-TOMBSTONE_MAX),
    trash: [...m.trash].slice(-TRASH_IN_INDEX),
  };
  if (m.mode) doc.mode = m.mode;
  const cutoff = Date.now() - MOVES_KEEP_MS;
  const mv = [...m.mv].filter(([, v]) => v.at >= cutoff).map(([o, v]) => ({ o, n: v.n, at: v.at }));
  if (mv.length) doc.mv = mv;
  doc.settings = m.settings;
  return JSON.stringify(doc);
}

