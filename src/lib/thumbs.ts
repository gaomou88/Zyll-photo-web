import { makeThumbnail } from "./media";
import type { Photo } from "./library.svelte";

/**
 * 缩略图加载：最多同时下 6 张，解出来的图片以 blob: 地址缓存在内存（最多 800 张，先进先出）。
 * 没有网盘缩略图的旧备份：图片小于 25 MB 时下载原图现做一张（只在内存里）。
 */

const MAX = 800;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
let active = 0;
const waiting: (() => void)[] = [];

async function slot<T>(job: () => Promise<T>): Promise<T> {
  if (active >= 6) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await job();
  } finally {
    active--;
    waiting.shift()?.();
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

export function thumbUrl(p: Photo): Promise<string | null> {
  const hit = cache.get(p.key);
  if (hit) return Promise.resolve(hit);
  let job = inflight.get(p.key);
  if (job) return job;
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
  }).finally(() => inflight.delete(p.key));
  inflight.set(p.key, job);
  return job;
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
