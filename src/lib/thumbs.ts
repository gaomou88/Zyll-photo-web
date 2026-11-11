import { makeThumbnail } from "./media";
import type { Photo } from "./library.svelte";

/**
 * 缩略图加载：最多同时下 6 张，解出来的图片以 blob: 地址缓存在内存（最多 800 张，先进先出）。
 * 没有网盘缩略图的旧备份：图片小于 25 MB 时下载原图现做一张（只在内存里）。
 */

const MAX = 800;
const cache = new Map<string, string>();
let active = 0;
/** 排队的任务：后进先出（眼前刚出现的图块先加载）；图块离开页面时从队列里撤掉。 */
const waiting: (() => void)[] = [];

class Cancelled extends Error {}

async function slot<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (active >= 6) {
    // 前一个任务做完时直接把名额交过来（active 不变），中间不会被别的任务插队
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener("abort", drop);
        resolve();
      };
      const drop = () => {
        const i = waiting.indexOf(go);
        if (i >= 0) waiting.splice(i, 1);
        reject(new Cancelled());
      };
      if (signal?.aborted) return drop();
      signal?.addEventListener("abort", drop, { once: true });
      waiting.push(go);
    });
  } else active++;
  try {
    return await job();
  } finally {
    const next = waiting.pop();
    if (next) next();
    else active--;
  }
}

function remember(key: string, url: string) {
  cache.set(key, url);
  while (cache.size > MAX) {
    const [k, v] = cache.entries().next().value!;
    cache.delete(k);
    URL.revokeObjectURL(v);
  }
}

export function cachedThumb(p: Photo): string | null {
  return cache.get(p.key) ?? null;
}

const CANCELLED = Symbol("cancelled");
const inflight = new Map<string, Promise<string | null | typeof CANCELLED>>();

/**
 * [signal] 中止时：还在排队就撤掉、返回 null（已经开始下载的照常做完、放进缓存）。
 * 排着队的任务被别的图块撤掉了，这里再自己排一次。
 */
export async function thumbUrl(p: Photo, signal?: AbortSignal): Promise<string | null> {
  for (;;) {
    const hit = cache.get(p.key);
    if (hit) return hit;
    if (signal?.aborted) return null;
    let job = inflight.get(p.key);
    if (!job) {
      job = slot(async () => {
        const { acc, item } = p;
        if (!acc.canOpen(item)) return null;
        let blob = await acc.thumbnail(item).catch((e) => (acc.noteError(e), null));
        if (!blob && item.m.startsWith("image/") && item.s > 0 && item.s < 25 * 1024 * 1024) {
          const orig = await acc.original(item).catch(() => null);
          if (orig) blob = await makeThumbnail(orig, item.m, item.n);
        }
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        remember(p.key, url);
        return url;
      }, signal)
        .catch((e): typeof CANCELLED => {
          if (e instanceof Cancelled) return CANCELLED;
          throw e;
        })
        .finally(() => inflight.delete(p.key));
      inflight.set(p.key, job);
    }
    const r = await job;
    if (r !== CANCELLED) return r;
  }
}

/** 锁上时清空（解密出来的图片不留在内存里）。 */
export function clearThumbs() {
  for (const v of cache.values()) URL.revokeObjectURL(v);
  cache.clear();
}

// 所有缩略图共用一个 IntersectionObserver（每张图各建一个在几千张时很卡）
const watchers = new Map<Element, () => void>();
let io: IntersectionObserver | null = null;

/** 元素快进入屏幕时调用一次 [cb]；返回取消函数。 */
export function whenNear(el: Element, cb: () => void): () => void {
  io ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const fn = watchers.get(e.target);
        watchers.delete(e.target);
        io!.unobserve(e.target);
        fn?.();
      }
    },
    { rootMargin: "800px 0px" },
  );
  watchers.set(el, cb);
  io.observe(el);
  return () => {
    watchers.delete(el);
    io?.unobserve(el);
  };
}
