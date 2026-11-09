/**
 * 动态照片：找出照片文件里嵌着的那段短视频，规则见 spec/motion-photo.md（和安卓 core/motion 逐条一致）。
 *
 * 支持：
 * - Google Motion Photo（Pixel、小米、OPPO、vivo、荣耀等新机型）：XMP 里 Container 目录写着视频长度，视频在文件末尾；
 * - 旧的 Google MicroVideo：XMP 里的 MicroVideoOffset（从文件末尾往前数）；
 * - 三星：文件末尾的 SEF 目录里有一项 MotionPhoto_Data；
 * - HEIC 动态照片：顶层的 mpvd 盒子；
 * - 其他把 MP4 直接接在图片后面的机型：完整扫描（只在真要播放时做）。
 *
 * 这里只读文件，不改文件。
 */

export interface MotionVideo {
  /** 视频在文件里的起始位置 */
  offset: number;
  length: number;
  mime: "video/mp4" | "video/quicktime";
}

/** 按需读取文件的一段（越界时返回较短的结果）。 */
export type Reader = (offset: number, length: number) => Promise<Uint8Array>;

export const blobReader = (b: Blob): Reader => async (off, len) =>
  new Uint8Array(await b.slice(off, Math.min(b.size, off + len)).arrayBuffer());

const HEAD_BYTES = 256 * 1024;
const SCAN_STEP = 1 << 20;
const MAX_BOXES = 4096;

const ascii = (b: Uint8Array, at = 0, n = b.length - at) => {
  let s = "";
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u32le = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16) + ((b[at + 3]! << 24) >>> 0);
const isBoxType = (b: Uint8Array, at: number) => {
  for (let i = at; i < at + 4; i++) if (b[i]! < 0x20 || b[i]! > 0x7e) return false;
  return true;
};

/** 读一个 ISO-BMFF 盒子的头：返回 [类型, 总长, 头长]；不是合法盒子返回 null。 */
async function boxAt(read: Reader, size: number, pos: number): Promise<[string, number, number] | null> {
  if (pos + 8 > size) return null;
  const h = await read(pos, 16);
  if (h.length < 8 || !isBoxType(h, 4)) return null;
  let len = u32be(h, 0);
  let header = 8;
  if (len === 1) {
    if (h.length < 16) return null;
    const hi = u32be(h, 8);
    if (hi > 0x1fffff) return null;
    len = hi * 2 ** 32 + u32be(h, 12);
    header = 16;
  } else if (len === 0) {
    len = size - pos;
  }
  if (len < header || pos + len > size) return null;
  return [ascii(h, 4, 4), len, header];
}

/**
 * 从 [at] 开始是不是一段完整的 MP4 / MOV：第一个盒子是 ftyp（不超过 1 KiB），之后一串合法的盒子，
 * 里面要有 moov 和 mdat。是的话返回视频（长度到最后一个合法盒子为止，后面可以跟着别的数据）。
 */
export async function videoAt(read: Reader, size: number, at: number): Promise<MotionVideo | null> {
  if (at <= 0 || at + 16 > size) return null;
  const first = await boxAt(read, size, at);
  if (!first || first[0] !== "ftyp" || first[1] > 1024 || first[1] < 16) return null;
  const brand = ascii(await read(at + first[2], 4));
  let pos = at;
  let moov = false;
  let mdat = false;
  for (let n = 0; n < MAX_BOXES; n++) {
    const b = await boxAt(read, size, pos);
    if (!b) break;
    if (b[0] === "moov") moov = true;
    else if (b[0] === "mdat") mdat = true;
    pos += b[1];
    if (pos >= size) break;
  }
  if (!moov || !mdat) return null;
  return { offset: at, length: pos - at, mime: brand === "qt  " ? "video/quicktime" : "video/mp4" };
}

/** XMP 里写的“视频从文件末尾往前数多少字节”。可能有多个（新旧两种写法都写了），按出现顺序。 */
export function xmpTailLengths(text: string): number[] {
  const out: number[] = [];
  const add = (v: string | undefined) => {
    const n = Number(v);
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  };
  const attr = (name: string, s: string) => {
    const m = new RegExp(`${name}\\s*=\\s*["'](\\d+)["']|${name}>\\s*(\\d+)\\s*<`).exec(s);
    return m ? (m[1] ?? m[2]) : undefined;
  };
  // Container 目录：每一项是一个 rdf:li，视频那项的 Mime 是 video/*（或 Semantic 是 MotionPhoto）
  for (const li of text.split(/<rdf:li[\s>]/).slice(1)) {
    const item = li.split(/<\/rdf:li>/)[0]!;
    if (/Item:Mime\s*=\s*["']video\/|Item:Mime>\s*video\/|Item:Semantic\s*=\s*["']MotionPhoto["']|Item:Semantic>\s*MotionPhoto\s*</.test(item)) {
      add(attr("Item:Length", item));
    }
  }
  add(attr("MicroVideoOffset", text));
  return out;
}

/** 三星 SEF：文件以 "SEFT" 结尾，目录里名字是 MotionPhoto_Data 的那项就是视频。返回视频开始的位置。 */
async function samsungStart(read: Reader, size: number): Promise<number | null> {
  if (size < 32) return null;
  const tail = await read(size - 8, 8);
  if (ascii(tail, 4, 4) !== "SEFT") return null;
  const dirLen = u32le(tail, 0);
  const dir = size - 8 - dirLen;
  if (dirLen < 12 || dir < 0) return null;
  const d = await read(dir, Math.min(dirLen, 12 + 64 * 12));
  if (ascii(d, 0, 4) !== "SEFH") return null;
  const count = Math.min(u32le(d, 8), 64);
  for (let i = 0; i < count; i++) {
    const e = 12 + i * 12;
    if (e + 12 > d.length) break;
    const back = u32le(d, e + 4);
    const len = u32le(d, e + 8);
    const data = dir - back;
    if (back === 0 || data < 0 || data + len > dir) continue;
    const h = await read(data, 8 + 64);
    const nameLen = u32le(h, 4);
    if (nameLen === 0 || nameLen > 64 || 8 + nameLen > len) continue;
    if (ascii(h, 8, nameLen) === "MotionPhoto_Data") return data + 8 + nameLen;
  }
  return null;
}

/**
 * 找照片里的视频。[scan] 为 false 时只看文件自己写明的位置（XMP、三星目录、HEIC 的 mpvd），读的数据很少，
 * 适合给格子打标记；为 true 时找不到再从头扫一遍有没有接在后面的 MP4（要读整个文件，只在播放时用）。
 */
export async function findMotionVideo(read: Reader, size: number, scan = false): Promise<MotionVideo | null> {
  if (size < 64) return null;
  const head = await read(0, Math.min(size, HEAD_BYTES));
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const heif = ascii(head, 4, 4) === "ftyp";
  if (!jpeg && !heif) return null;

  for (const n of xmpTailLengths(ascii(head))) {
    if (n >= size) continue;
    const v = await videoAt(read, size, size - n);
    if (v) return v;
  }
  const sef = await samsungStart(read, size);
  if (sef !== null) {
    const v = await videoAt(read, size, sef);
    if (v) return v;
  }
  let scanFrom = 1;
  if (heif) {
    let pos = 0;
    for (let n = 0; n < MAX_BOXES && pos < size; n++) {
      const b = await boxAt(read, size, pos);
      if (!b) break;
      // Pixel 等：视频放在 mpvd 盒子里；有的机型直接把整段 MP4（从 ftyp 开始）接在后面
      const at = b[0] === "mpvd" ? pos + b[2] : b[0] === "ftyp" && pos > 0 ? pos : -1;
      if (at > 0) {
        const v = await videoAt(read, size, at);
        if (v) return v;
      }
      pos += b[1];
    }
    scanFrom = Math.max(1, pos);
  }
  if (!scan) return null;
  // 扫 "ftyp"：每段多读 7 个字节，跨段的也能找到
  for (let off = scanFrom; off < size; off += SCAN_STEP) {
    const chunk = await read(off, SCAN_STEP + 7);
    for (let i = 0; i + 8 <= chunk.length; i++) {
      if (chunk[i + 4] !== 0x66 || chunk[i + 5] !== 0x74 || chunk[i + 6] !== 0x79 || chunk[i + 7] !== 0x70) continue;
      const v = await videoAt(read, size, off + i);
      if (v) return v;
    }
  }
  return null;
}

/** 照片能不能带视频（只有 JPEG 和 HEIC/HEIF 会）。 */
export const mayHaveMotion = (mime: string, name = "") =>
  /^image\/(jpeg|jpg|heic|heif)$/.test(mime.toLowerCase()) || /\.(jpe?g|heic|heif)$/i.test(name);

/**
 * iPhone 的实况照片拷到电脑上是两个文件：IMG_1234.HEIC + IMG_1234.MOV。
 * 同一个相簿里、去掉扩展名后名字相同（不分大小写）的照片和 MOV 算一对。返回配对用的键，不能配对时返回 null。
 */
export function livePairKey(album: string, name: string, mime: string): { key: string; still: boolean } | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  const base = name.slice(0, dot).toLowerCase();
  const key = `${album}\u0000${base}`;
  if (ext === "mov" && mime.startsWith("video/")) return { key, still: false };
  if (/^(heic|heif|jpe?g)$/.test(ext) && mime.startsWith("image/")) return { key, still: true };
  return null;
}
