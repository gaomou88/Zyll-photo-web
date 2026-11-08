import {
  BlobKind, KEY_LEN, NONCE_LEN, TAG_LEN, ZyllCryptoError, aesGcmEncrypt, concat, importAesKey, randomBytes, sha256, u64, zylc,
} from "@zyll/crypto";
import type { UploadSource } from "./drive";

/**
 * ZYLC v1 的流式读写（spec/crypto-format.md），给大文件用：
 * - 上传：按需加密出任意一段密文，几 GB 的视频也不用整个放进内存；
 * - 解密：按 kind 校验（原图、缩略图、目录各自只接受自己的 kind，和安卓一致）。
 */

const chunkNonce = (i: number) => concat(new Uint8Array(4), u64(i));
const chunkAad = (headerHash: Uint8Array, i: number, last: boolean) => concat(headerHash, u64(i), new Uint8Array([last ? 1 : 0]));

export interface EncryptOptions {
  /** 测试用：固定随机数 */
  blobId?: Uint8Array;
  dek?: Uint8Array;
  wrapNonce?: Uint8Array;
  chunkLog2?: number;
}

/** 把 [plain] 包装成一个加密后的上传源：read(start, end) 返回密文的这一段。 */
export async function encryptingSource(plain: Blob, kind: BlobKind, kWrap: CryptoKey, o: EncryptOptions = {}): Promise<UploadSource> {
  const chunkLog2 = o.chunkLog2 ?? zylc.DEFAULT_CHUNK_LOG2;
  const blobId = o.blobId ?? randomBytes(16);
  const dekRaw = o.dek ?? randomBytes(KEY_LEN);
  const wrapNonce = o.wrapNonce ?? randomBytes(NONCE_LEN);
  const header: zylc.ZylcHeader = { chunkLog2, kind, blobId, wrapNonce, wrappedDek: new Uint8Array(48), plainLen: plain.size };
  header.wrappedDek = await aesGcmEncrypt(kWrap, wrapNonce, dekRaw, zylc.encodeHeader(header).subarray(0, 24));
  const headerBytes = zylc.encodeHeader(header);
  const headerHash = await sha256(headerBytes);
  const dek = await importAesKey(dekRaw);
  if (!o.dek) dekRaw.fill(0);
  const C = 1 << chunkLog2;
  const n = zylc.chunkCount(header);
  const total = zylc.totalLen(header);
  const stride = C + TAG_LEN;

  async function chunk(i: number): Promise<Uint8Array> {
    const part = new Uint8Array(await plain.slice(i * C, Math.min((i + 1) * C, plain.size)).arrayBuffer());
    return aesGcmEncrypt(dek, chunkNonce(i), part, chunkAad(headerHash, i, i === n - 1));
  }

  return {
    size: total,
    mime: "application/octet-stream",
    async read(start: number, end: number) {
      const out = new Uint8Array(end - start);
      let pos = start;
      if (pos < zylc.HEADER_LEN) {
        const take = headerBytes.subarray(pos, Math.min(zylc.HEADER_LEN, end));
        out.set(take, 0);
        pos += take.length;
      }
      while (pos < end) {
        const i = Math.floor((pos - zylc.HEADER_LEN) / stride);
        const base = zylc.HEADER_LEN + i * stride;
        const ct = await chunk(i);
        const from = pos - base;
        const take = ct.subarray(from, Math.min(ct.length, from + (end - pos)));
        out.set(take, pos - start);
        pos += take.length;
      }
      return out;
    },
  };
}

/** 不加密的上传源。 */
export function plainSource(b: Blob, mime: string): UploadSource {
  return {
    size: b.size,
    mime: mime || "application/octet-stream",
    read: async (start, end) => new Uint8Array(await b.slice(start, end).arrayBuffer()),
  };
}

export const bytesSource = (b: Uint8Array, mime: string): UploadSource => ({
  size: b.length,
  mime,
  read: async (s, e) => b.subarray(s, e),
});

/** 解密一个完整的 ZYLC 文件，并要求是 [expect] 这种 kind。 */
export async function decryptKind(data: Uint8Array, kWrap: CryptoKey, expect: BlobKind): Promise<Uint8Array> {
  const h = zylc.decodeHeader(data.subarray(0, zylc.HEADER_LEN));
  if (h.kind !== expect) throw new ZyllCryptoError("unexpected blob kind");
  return zylc.decrypt(data, kWrap);
}

/** 一段 ZYLC 文件在明文里的块分布，给视频流式解密用。 */
export function chunkLayout(h: zylc.ZylcHeader) {
  return { size: zylc.chunkSize(h), count: zylc.chunkCount(h), stride: zylc.chunkSize(h) + TAG_LEN, headerLen: zylc.HEADER_LEN };
}
