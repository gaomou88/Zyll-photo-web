import { createSHA256 } from "hash-wasm";
import { THUMB_PX } from "./config";
import { htmlLang, t } from "./i18n";

/** 浏览器里处理照片：内容指纹、拍摄时间、缩略图、HEIC 转码。 */

/** 文件内容的 SHA-256（小写十六进制），分段读，大视频也不占满内存。和安卓的 `h` 一致。 */
export async function sha256Hex(b: Blob, onProgress?: (done: number) => void): Promise<string> {
  const h = await createSHA256();
  h.init();
  const STEP = 8 * 1024 * 1024;
  for (let off = 0; off < b.size; off += STEP) {
    h.update(new Uint8Array(await b.slice(off, off + STEP).arrayBuffer()));
    onProgress?.(Math.min(b.size, off + STEP));
  }
  return h.digest("hex");
}

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  heic: "image/heic", heif: "image/heif", avif: "image/avif", dng: "image/x-adobe-dng",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp", mkv: "video/x-matroska",
};

export function mimeOf(f: File): string {
  if (f.type) return f.type;
  return EXT_MIME[f.name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export const isMedia = (mime: string) => mime.startsWith("image/") || mime.startsWith("video/");
export const isHeic = (mime: string, name = "") => /image\/hei[cf]/.test(mime) || /\.(heic|heif)$/i.test(name);

/** 拍摄时间：EXIF 的 DateTimeOriginal，没有就用文件修改时间。 */
export async function takenAt(f: File, mime: string): Promise<number> {
  if (mime.startsWith("image/")) {
    try {
      const exifr = await import("exifr");
      const o = await exifr.parse(f, { pick: ["DateTimeOriginal", "CreateDate", "OffsetTimeOriginal", "OffsetTime"] });
      const d: unknown = o?.DateTimeOriginal ?? o?.CreateDate;
      if (d instanceof Date && !isNaN(d.getTime())) {
        // EXIF 时间是拍摄地的墙上时间；有时区偏移就换算成准确的时刻，没有就按这台电脑的时区算
        const off = parseOffset(o?.OffsetTimeOriginal ?? o?.OffsetTime);
        if (off === null) return d.getTime();
        const wall = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
        return wall - off * 60_000;
      }
    } catch {
      /* 没有 EXIF */
    }
  }
  if (mime.startsWith("video/")) {
    const t = await mp4CreationTime(f).catch(() => null);
    if (t) return t;
  }
  return f.lastModified || Date.now();
}

/** "+08:00" → 480（分钟）；格式不对返回 null。 */
function parseOffset(v: unknown): number | null {
  const m = typeof v === "string" ? /^([+-])(\d{2}):?(\d{2})$/.exec(v.trim()) : null;
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** 读 MP4 / MOV 的 moov/mvhd 里的创建时间（UTC，1904 年起的秒数）。读不到返回 null。 */
export async function mp4CreationTime(f: Blob): Promise<number | null> {
  const read = async (start: number, len: number) => new DataView(await f.slice(start, Math.min(f.size, start + len)).arrayBuffer());
  const type = (v: DataView, at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
  // 在顶层找 moov（可能在文件末尾）
  let pos = 0;
  let moov: [number, number] | null = null;
  for (let n = 0; pos + 8 <= f.size && n < 64; n++) {
    const h = await read(pos, 16);
    let size = h.getUint32(0);
    let header = 8;
    if (size === 1) {
      if (h.byteLength < 16) return null;
      size = Number(h.getBigUint64(8));
      header = 16;
    } else if (size === 0) size = f.size - pos;
    if (size < header) return null;
    if (type(h, 4) === "moov") {
      moov = [pos + header, size - header];
      break;
    }
    pos += size;
  }
  if (!moov) return null;
  const body = await read(moov[0], Math.min(moov[1], 4 << 20));
  for (let p = 0; p + 8 <= body.byteLength; ) {
    const size = body.getUint32(p);
    if (size < 8) return null;
    if (type(body, p + 4) === "mvhd") {
      const version = body.getUint8(p + 8);
      const secs = version === 1 ? Number(body.getBigUint64(p + 12)) : body.getUint32(p + 12);
      const ms = (secs - 2082844800) * 1000;
      // 没写时间（0）或明显不对的不用
      return ms > Date.UTC(2000, 0, 1) && ms < Date.now() + 86_400_000 ? ms : null;
    }
    p += size;
  }
  return null;
}

/** HEIC → JPEG（大多数电脑浏览器不能直接显示 HEIC）。转码库很大，用到时才加载。 */
export async function heicToJpeg(b: Blob, quality = 0.92): Promise<Blob> {
  const { heicTo } = await import("heic-to/csp");
  return heicTo({ blob: b, type: "image/jpeg", quality });
}

async function decodeImage(b: Blob, mime: string, name: string): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(b, { imageOrientation: "from-image" });
  } catch (e) {
    if (!isHeic(mime, name)) throw e;
    return createImageBitmap(await heicToJpeg(b, 0.85), { imageOrientation: "from-image" });
  }
}

function frameOfVideo(b: Blob): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(b);
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    const done = (err?: unknown) => {
      URL.revokeObjectURL(url);
      v.removeAttribute("src");
      v.load();
      if (err) reject(err instanceof Error ? err : new Error(t("无法读取视频")));
    };
    const timer = setTimeout(() => done(new Error(t("读取视频超时"))), 15_000);
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(1, (v.duration || 0) / 2);
    };
    v.onseeked = async () => {
      clearTimeout(timer);
      try {
        const bmp = await createImageBitmap(v);
        done();
        resolve(bmp);
      } catch (e) {
        done(e);
      }
    };
    v.onerror = () => {
      clearTimeout(timer);
      done(new Error(t("浏览器不支持这种视频格式")));
    };
    v.src = url;
  });
}

/** 做一张缩略图（JPEG，短边 [THUMB_PX]），和安卓上传的缩略图同样大小。做不出来时返回 null。 */
export async function makeThumbnail(b: Blob, mime: string, name: string): Promise<Blob | null> {
  let bmp: ImageBitmap;
  try {
    bmp = mime.startsWith("video/") ? await frameOfVideo(b) : await decodeImage(b, mime, name);
  } catch {
    return null;
  }
  const scale = Math.min(1, THUMB_PX / Math.min(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return new Promise((resolve) => canvas.toBlob((x) => resolve(x), "image/jpeg", 0.85));
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 照片墙的日期标题：今天 / 昨天 / 11月3日 周一 / 2024年5月1日。 */
export function dayLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return t("今天");
  if (diff === 1) return t("昨天");
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear() ? { month: "long", day: "numeric", weekday: "short" } : { year: "numeric", month: "long", day: "numeric" };
  return new Intl.DateTimeFormat(htmlLang, opts).format(d);
}

export const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export function fmtTime(ms: number): string {
  return new Intl.DateTimeFormat(htmlLang, { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

/** 下载一个 Blob 到本地。 */
export function saveBlob(b: Blob, name: string) {
  const url = URL.createObjectURL(b);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
