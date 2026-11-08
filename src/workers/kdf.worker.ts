/// <reference lib="webworker" />
// Argon2id 64 MiB 需要约 1 秒，放在 Worker 里避免卡住界面。
// 只把 MK 原始字节传回主线程，主线程立即导入为不可导出的 CryptoKey 并清零。
import { keybundle } from "@zyll/crypto";

export type KdfRequest =
  | { op: "create"; password: string }
  | { op: "unlockPassword"; json: string; password: string }
  | { op: "unlockRecovery"; json: string; recoveryKey: string };

export type KdfResponse =
  | { ok: true; json?: string; recoveryKey?: string; vaultId: string; masterKey: Uint8Array }
  | { ok: false; error: string };

self.onmessage = async (e: MessageEvent<KdfRequest>) => {
  const req = e.data;
  try {
    let res: KdfResponse;
    if (req.op === "create") {
      const i: keybundle.CreateInputs = {
        vaultId: crypto.randomUUID(),
        masterKey: crypto.getRandomValues(new Uint8Array(32)),
        recoveryKey: crypto.getRandomValues(new Uint8Array(32)),
        pwSalt: crypto.getRandomValues(new Uint8Array(16)),
        pwNonce: crypto.getRandomValues(new Uint8Array(12)),
        rcSalt: crypto.getRandomValues(new Uint8Array(16)),
        rcNonce: crypto.getRandomValues(new Uint8Array(12)),
      };
      const file = await keybundle.createWith(i, req.password, keybundle.DEFAULT_ARGON2);
      res = {
        ok: true,
        json: JSON.stringify(file, null, 2),
        recoveryKey: keybundle.formatRecoveryKey(i.recoveryKey),
        vaultId: file.vaultId,
        masterKey: i.masterKey,
      };
      i.recoveryKey.fill(0);
    } else if (req.op === "unlockPassword") {
      res = { ok: true, ...(await keybundle.unwrapWithPassword(req.json, req.password)) };
    } else {
      res = { ok: true, ...(await keybundle.unwrapWithRecoveryKey(req.json, req.recoveryKey)) };
    }
    self.postMessage(res, res.ok ? [res.masterKey.buffer as ArrayBuffer] : []);
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies KdfResponse);
  }
};
