import { describe, expect, it } from "vitest";
import { BlobKind, importAesKey, zylc } from "@zyll/crypto";
import { decryptKind, encryptingSource } from "../src/lib/zylcio";

describe("流式加密", () => {
  it("任意切片拼起来和一次性加密逐字节相同，并能解密", async () => {
    const key = await importAesKey(new Uint8Array(32).fill(7));
    const plain = new Uint8Array(70_000 * 3 + 123).map((_, i) => (i * 31) & 255);
    const fixed = { blobId: new Uint8Array(16).fill(1), dek: new Uint8Array(32).fill(2), wrapNonce: new Uint8Array(12).fill(3), chunkLog2: 12 };
    const src = await encryptingSource(new Blob([plain]), BlobKind.Original, key, fixed);
    const whole = await zylc.encryptWith(plain, BlobKind.Original, key, fixed.blobId, fixed.dek, fixed.wrapNonce, 12);
    expect(src.size).toBe(whole.length);
    const parts: Uint8Array[] = [];
    for (let off = 0; off < src.size; off += 5000) parts.push(await src.read(off, Math.min(src.size, off + 5000)));
    const joined = new Uint8Array(src.size);
    let p = 0;
    for (const x of parts) { joined.set(x, p); p += x.length; }
    expect(joined).toEqual(whole);
    expect(await decryptKind(joined, key, BlobKind.Original)).toEqual(plain);
    await expect(decryptKind(joined, key, BlobKind.Thumbnail)).rejects.toThrow();
  });

  it("空文件", async () => {
    const key = await importAesKey(new Uint8Array(32).fill(9));
    const src = await encryptingSource(new Blob([]), BlobKind.IndexSnapshot, key);
    const all = await src.read(0, src.size);
    expect(await decryptKind(all, key, BlobKind.IndexSnapshot)).toEqual(new Uint8Array(0));
  });
});
