import {
  ZyllCryptoError, aesGcmDecrypt, aesGcmEncrypt, argon2id, fromBase64, hkdfSha256, importAesKey,
  randomBytes, subtle, toBase64, utf8,
} from "./primitives";

/** 密钥包 v1，见 spec/keybundle.md。 */
export const FORMAT = "zyll-keybundle";

export interface KdfParams {
  alg: string;
  v?: number;
  m?: number;
  t?: number;
  p?: number;
  salt: string;
}

export interface KeySlot {
  type: string;
  kdf: KdfParams;
  nonce: string;
  wrappedMk: string;
}

export interface KeyBundleFile {
  format: string;
  version: number;
  vaultId: string;
  slots: KeySlot[];
}

export interface Argon2Params {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export const DEFAULT_ARGON2: Argon2Params = { memoryKiB: 65536, iterations: 3, parallelism: 1 };

function checkParams(p: Argon2Params) {
  // 上限防止被改过的密钥包让解锁时内存耗尽（和 Android 端一致：m ≤ 1 GiB、t ≤ 10）
  if (!(p.memoryKiB >= 8192 && p.memoryKiB <= 1048576 && p.iterations >= 1 && p.iterations <= 10 && p.parallelism === 1)) throw new ZyllCryptoError("bad kdf params");
}

const aad = (vaultId: string, type: string) => utf8(`zyll-keybundle/v1|${vaultId}|${type}`);

export const passwordBytes = (password: string) => utf8(password.normalize("NFC"));

/** 解锁后的库：MK 只以不可导出的 CryptoKey 形式保留。 */
export interface UnlockedVault {
  vaultId: string;
  /** 包裹每个文件 DEK 的子密钥（不可导出）。 */
  wrapKey: CryptoKey;
}

/** 从 MK 原始字节派生 K_wrap 的原始字节（仅测试与 Android 互验用）。 */
export const deriveWrapKeyBytes = (mk: Uint8Array) => hkdfSha256(mk, new Uint8Array(0), utf8("zyll/v1/wrap"), 32);

/** 从 MK 派生不可导出的 K_wrap，并尽快清零 MK 原始字节。 */
export async function vaultFromMasterKey(vaultId: string, mk: Uint8Array): Promise<UnlockedVault> {
  const hkdf = await subtle().importKey("raw", new Uint8Array(mk), "HKDF", false, ["deriveKey"]);
  const wrapKey = await subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new Uint8Array(utf8("zyll/v1/wrap")) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  mk.fill(0);
  return { vaultId, wrapKey };
}

async function recoveryKek(recoveryKey: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  if (recoveryKey.length !== 32) throw new ZyllCryptoError("bad recovery key");
  return importAesKey(await hkdfSha256(recoveryKey, salt, utf8("zyll/v1/recovery-kek"), 32));
}

export async function passwordSlot(vaultId: string, mk: Uint8Array, password: string, params: Argon2Params, salt: Uint8Array, nonce: Uint8Array): Promise<KeySlot> {
  checkParams(params);
  const kek = await importAesKey(await argon2id(passwordBytes(password), salt, params.memoryKiB, params.iterations, params.parallelism));
  return {
    type: "password",
    kdf: { alg: "argon2id", v: 19, m: params.memoryKiB, t: params.iterations, p: params.parallelism, salt: toBase64(salt) },
    nonce: toBase64(nonce),
    wrappedMk: toBase64(await aesGcmEncrypt(kek, nonce, mk, aad(vaultId, "password"))),
  };
}

export async function recoverySlot(vaultId: string, mk: Uint8Array, recoveryKey: Uint8Array, salt: Uint8Array, nonce: Uint8Array): Promise<KeySlot> {
  const kek = await recoveryKek(recoveryKey, salt);
  return {
    type: "recovery",
    kdf: { alg: "hkdf-sha256", salt: toBase64(salt) },
    nonce: toBase64(nonce),
    wrappedMk: toBase64(await aesGcmEncrypt(kek, nonce, mk, aad(vaultId, "recovery"))),
  };
}

export interface CreateInputs {
  vaultId: string;
  masterKey: Uint8Array;
  recoveryKey: Uint8Array;
  pwSalt: Uint8Array;
  pwNonce: Uint8Array;
  rcSalt: Uint8Array;
  rcNonce: Uint8Array;
}

/** 确定性创建，供测试向量使用。 */
export async function createWith(i: CreateInputs, password: string, params: Argon2Params): Promise<KeyBundleFile> {
  return {
    format: FORMAT,
    version: 1,
    vaultId: i.vaultId,
    slots: [
      await passwordSlot(i.vaultId, i.masterKey, password, params, i.pwSalt, i.pwNonce),
      await recoverySlot(i.vaultId, i.masterKey, i.recoveryKey, i.rcSalt, i.rcNonce),
    ],
  };
}

export interface Created {
  json: string;
  vault: UnlockedVault;
  /** 展示给用户抄写的恢复密钥。 */
  recoveryKey: string;
}

/** 首次使用：本地生成 MK 与恢复密钥。 */
export async function create(password: string, params: Argon2Params = DEFAULT_ARGON2): Promise<Created> {
  const inputs: CreateInputs = {
    vaultId: globalThis.crypto.randomUUID(),
    masterKey: randomBytes(32),
    recoveryKey: randomBytes(32),
    pwSalt: randomBytes(16), pwNonce: randomBytes(12),
    rcSalt: randomBytes(16), rcNonce: randomBytes(12),
  };
  const file = await createWith(inputs, password, params);
  const recoveryKey = formatRecoveryKey(inputs.recoveryKey);
  inputs.recoveryKey.fill(0);
  return { json: JSON.stringify(file, null, 2), vault: await vaultFromMasterKey(file.vaultId, inputs.masterKey), recoveryKey };
}

export function parse(text: string): KeyBundleFile {
  let f: KeyBundleFile;
  try {
    f = JSON.parse(text);
  } catch {
    throw new ZyllCryptoError("malformed keybundle");
  }
  if (f?.format !== FORMAT || f.version !== 1 || typeof f.vaultId !== "string" || !Array.isArray(f.slots)) {
    throw new ZyllCryptoError("unsupported keybundle");
  }
  return f;
}

/** 返回 MK 原始字节；调用方应尽快交给 vaultFromMasterKey（会清零）。 */
export async function unwrapWithPassword(text: string, password: string): Promise<{ vaultId: string; masterKey: Uint8Array }> {
  const f = parse(text);
  const slot = f.slots.find((s) => s.type === "password");
  if (!slot) throw new ZyllCryptoError("no password slot");
  const k = slot.kdf;
  if (k.alg !== "argon2id" || k.v !== 19) throw new ZyllCryptoError("unsupported kdf");
  const params = { memoryKiB: k.m ?? 0, iterations: k.t ?? 0, parallelism: k.p ?? 0 };
  checkParams(params);
  const kek = await importAesKey(await argon2id(passwordBytes(password), fromBase64(k.salt), params.memoryKiB, params.iterations, params.parallelism));
  const masterKey = await aesGcmDecrypt(kek, fromBase64(slot.nonce), fromBase64(slot.wrappedMk), aad(f.vaultId, "password"));
  return { vaultId: f.vaultId, masterKey };
}

export async function unwrapWithRecoveryKey(text: string, recoveryKeyDisplay: string): Promise<{ vaultId: string; masterKey: Uint8Array }> {
  const f = parse(text);
  const slot = f.slots.find((s) => s.type === "recovery");
  if (!slot) throw new ZyllCryptoError("no recovery slot");
  if (slot.kdf.alg !== "hkdf-sha256") throw new ZyllCryptoError("unsupported kdf");
  const kek = await recoveryKek(parseRecoveryKey(recoveryKeyDisplay), fromBase64(slot.kdf.salt));
  const masterKey = await aesGcmDecrypt(kek, fromBase64(slot.nonce), fromBase64(slot.wrappedMk), aad(f.vaultId, "recovery"));
  return { vaultId: f.vaultId, masterKey };
}

export async function unlockWithPassword(text: string, password: string): Promise<UnlockedVault> {
  const r = await unwrapWithPassword(text, password);
  return vaultFromMasterKey(r.vaultId, r.masterKey);
}

export async function unlockWithRecoveryKey(text: string, recoveryKey: string): Promise<UnlockedVault> {
  const r = await unwrapWithRecoveryKey(text, recoveryKey);
  return vaultFromMasterKey(r.vaultId, r.masterKey);
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 Base32，大写无填充，每 4 字符一组。 */
export function formatRecoveryKey(key: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of key) {
    buffer = ((buffer << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

export function parseRecoveryKey(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s-]/g, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of clean) {
    const v = B32.indexOf(c);
    if (v < 0) throw new ZyllCryptoError("bad recovery key character");
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}
