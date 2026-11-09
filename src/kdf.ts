import type { KdfRequest, KdfResponse } from "./workers/kdf.worker";
import KdfWorker from "./workers/kdf.worker?worker";
import { t } from "./lib/i18n";

/** 每次调用新建一个 Worker，用完即销毁，Argon2 的 64 MiB 内存随之释放。 */
export function runKdf(req: KdfRequest): Promise<Extract<KdfResponse, { ok: true }>> {
  return new Promise((resolve, reject) => {
    const w = new KdfWorker();
    w.onmessage = (e: MessageEvent<KdfResponse>) => {
      w.terminate();
      if (e.data.ok) resolve(e.data);
      else reject(new Error(e.data.error === "authentication failed" ? t("密码或恢复密钥不正确") : e.data.error));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message));
    };
    w.postMessage(req);
  });
}
