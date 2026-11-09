import { BlobKind, ZyllCryptoError, importAesKey, sha256, zylc } from "@zyll/crypto";
import type { Account } from "./library.svelte";
import type { IndexItem } from "./indexdoc";
import { t } from "./i18n";

/**
 * 视频边下边播：把网盘文件登记给 Service Worker（public/sw.js），<video> 的地址指向 __zyll_stream/<token>。
 * 加密视频的 DEK 以不可导出的 CryptoKey 交给 Service Worker，不出浏览器。
 */

interface StreamInfo {
  token: string;
  plainLen: number;
  mime: string;
  encrypted: boolean;
  url: string;
  headers: Record<string, string>;
  chunkSize?: number;
  chunkCount?: number;
  headerLen?: number;
  headerHash?: Uint8Array;
  dek?: CryptoKey;
}

const registry = new Map<string, () => Promise<StreamInfo>>();
let ready: Promise<ServiceWorkerRegistration | null> | null = null;

export function startServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (ready) return ready;
  if (!("serviceWorker" in navigator)) return (ready = Promise.resolve(null));
  ready = navigator.serviceWorker.register("./sw.js", { scope: "./" }).then(
    async () => {
      // Service Worker 被回收后来要登记信息
      navigator.serviceWorker.addEventListener("message", async (e) => {
        if (e.data?.type !== "need-stream") return;
        const make = registry.get(e.data.token);
        e.ports[0]?.postMessage(make ? await make().catch(() => null) : null);
      });
      return navigator.serviceWorker.ready;
    },
    () => null,
  );
  return ready;
}

/** 能不能边下边播（Service Worker 可用并已接管页面）。 */
export async function canStream(): Promise<boolean> {
  const reg = await startServiceWorker();
  return !!reg && !!navigator.serviceWorker.controller;
}

/** 登记一个视频，返回给 <video src> 用的地址。 */
export async function streamUrl(acc: Account, i: IndexItem): Promise<string> {
  const reg = await startServiceWorker();
  if (!reg?.active) throw new Error(t("浏览器不支持边下边播"));
  const token = crypto.randomUUID();
  const make = async (): Promise<StreamInfo> => {
    const req = await acc.drive.mediaRequest(i.r);
    if (!i.e) return { token, plainLen: i.s, mime: i.m, encrypted: false, ...req };
    const key = acc.wrapKey();
    if (!key) throw new Error(t("需要解锁"));
    const head = await acc.drive.download(i.r, [0, zylc.HEADER_LEN]);
    const h = zylc.decodeHeader(head);
    if (h.kind !== BlobKind.Original) throw new ZyllCryptoError("unexpected blob kind");
    const dekRaw = await zylc.unwrapDek(head, key);
    const dek = await importAesKey(dekRaw);
    dekRaw.fill(0);
    return {
      token, plainLen: h.plainLen, mime: i.m, encrypted: true, ...req,
      chunkSize: zylc.chunkSize(h), chunkCount: zylc.chunkCount(h), headerLen: zylc.HEADER_LEN, headerHash: await sha256(head), dek,
    };
  };
  registry.set(token, make);
  reg.active.postMessage({ type: "stream", token, info: await make() });
  return new URL(`__zyll_stream/${token}`, location.href).toString();
}

export function dropStream(url: string) {
  const token = url.split("/__zyll_stream/")[1];
  if (!token) return;
  registry.delete(token);
  navigator.serviceWorker?.controller?.postMessage({ type: "drop", token });
}

/** 锁上时：清掉 Service Worker 里的所有密钥。 */
export function clearStreams() {
  registry.clear();
  navigator.serviceWorker?.controller?.postMessage({ type: "clear" });
}
