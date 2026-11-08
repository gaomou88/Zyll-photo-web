import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { argon2id, fromHex, hkdfSha256, importAesKey, sha256, toHex, ZyllCryptoError } from "../src/primitives";
import * as zylc from "../src/zylc";
import * as kb from "../src/keybundle";

/** 读取 Kotlin 端生成的同一份向量：TS 必须逐字节复现。 */
const dir = fileURLToPath(new URL("../../../spec/test-vectors/", import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(dir + name, "utf8"));
const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);

describe("primitives", () => {
  const v = load("primitives.json");
  for (const c of v.hkdf as any[]) it(`hkdf ${c.name}`, async () => {
    expect(toHex(await hkdfSha256(fromHex(c.ikm), fromHex(c.salt), fromHex(c.info), c.length))).toBe(c.okm);
  });
  for (const c of v.argon2id as any[]) it(`argon2id ${c.name}`, async () => {
    expect(toHex(await argon2id(fromHex(c.password), fromHex(c.salt), c.m, c.t, c.p))).toBe(c.output);
  }, 30_000);
});

describe("zylc", () => {
  const v = load("zylc.json");
  const kWrap = () => importAesKey(fromHex(v.kWrap));

  for (const c of v.cases as any[]) it(`byte-exact ${c.name}`, async () => {
    const key = await kWrap();
    const plain = pattern(c.plainLen);
    const ct = await zylc.encryptWith(plain, c.kind, key, fromHex(c.blobId), fromHex(c.dek), fromHex(c.wrapNonce), c.chunkLog2);
    expect(toHex(await sha256(ct))).toBe(c.ciphertextSha256);
    if (c.ciphertext) expect(toHex(ct)).toBe(c.ciphertext);
    expect(await zylc.decrypt(ct, key)).toEqual(plain);
  });

  for (const c of v.negative as any[]) it(`rejects ${c.name}`, async () => {
    const key = await importAesKey(fromHex(c.kWrap ?? v.kWrap));
    await expect(zylc.decrypt(fromHex(c.ciphertext), key)).rejects.toBeInstanceOf(ZyllCryptoError);
  });

  it("random access", async () => {
    const key = await kWrap();
    const plain = pattern(10000);
    const ct = await zylc.encrypt(plain, zylc.BlobKind.Original, key, 12);
    const r = await zylc.ZylcReader.open(ct.subarray(0, zylc.HEADER_LEN), key);
    expect(r.chunkCount).toBe(3);
    const off = zylc.chunkOffset(r.header, 2);
    expect(await r.decryptChunk(2, ct.subarray(off))).toEqual(plain.subarray(8192));
  });
});

describe("keybundle", () => {
  const v = load("keybundle.json");
  for (const b of v.bundles as any[]) it(`unlock + recreate ${b.name}`, async () => {
    const text = JSON.stringify(b.bundle);
    const byPw = await kb.unwrapWithPassword(text, b.password);
    expect(toHex(byPw.masterKey)).toBe(b.masterKey);
    expect(toHex(await kb.deriveWrapKeyBytes(byPw.masterKey))).toBe(b.wrapKey);
    const byRk = await kb.unwrapWithRecoveryKey(text, b.recoveryKey.toLowerCase());
    expect(toHex(byRk.masterKey)).toBe(b.masterKey);
    await expect(kb.unwrapWithPassword(text, b.password + "x")).rejects.toBeInstanceOf(ZyllCryptoError);

    const i = b.createInputs;
    const again = await kb.createWith({
      vaultId: i.vaultId, masterKey: fromHex(b.masterKey), recoveryKey: kb.parseRecoveryKey(b.recoveryKey),
      pwSalt: fromHex(i.pwSalt), pwNonce: fromHex(i.pwNonce), rcSalt: fromHex(i.rcSalt), rcNonce: fromHex(i.rcNonce),
    }, b.password, { memoryKiB: i.m, iterations: i.t, parallelism: i.p });
    expect(again).toEqual(b.bundle);
  }, 30_000);

  it("non-extractable wrap key decrypts vectors made by Kotlin", async () => {
    const b = load("keybundle.json").bundles[0];
    const vault = await kb.unlockWithPassword(JSON.stringify(b.bundle), b.password);
    const plain = pattern(5000);
    const ct = await zylc.encrypt(plain, zylc.BlobKind.Thumbnail, vault.wrapKey);
    expect(await zylc.decrypt(ct, vault.wrapKey)).toEqual(plain);
    const raw = await importAesKey(fromHex(b.wrapKey));
    expect(await zylc.decrypt(ct, raw)).toEqual(plain);
  });

  it("recovery key format round-trips", () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const s = kb.formatRecoveryKey(key);
    expect(s.replace(/-/g, "")).toHaveLength(52);
    expect(kb.parseRecoveryKey(s)).toEqual(key);
  });
});
