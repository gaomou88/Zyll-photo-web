<script lang="ts">
  import { untrack } from "svelte";
  import { fade } from "svelte/transition";
  import Icon from "./Icon.svelte";
  import { t } from "../lib/i18n";
  import { cachedThumb } from "../lib/thumbs";
  import { fmtSize, fmtTime, heicToJpeg } from "../lib/media";
  import { canStream, dropStream, streamUrl } from "../lib/stream";
  import { blobReader, findMotionVideo, mayHaveMotion } from "../lib/motion";
  import { isHeicItem, type Photo } from "../lib/library.svelte";

  let { photos, index = $bindable(), onclose, ondelete, ondownload }: {
    photos: Photo[];
    index: number;
    onclose: () => void;
    ondelete: (p: Photo) => void;
    ondownload: (p: Photo) => void;
  } = $props();

  // 按照片的 key 跟踪当前看的是哪张：后台刷新（上传、目录复查）会重建整个列表，
  // 前面插进新照片时同一个下标就成了别的照片。列表变了按 key 重新找到它。
  let curKey: string | null = null;
  $effect.pre(() => {
    const list = photos;
    const k = curKey;
    if (!k) return;
    const i = list.findIndex((p) => p.key === k);
    if (i >= 0 && i !== untrack(() => index)) index = i;
  });
  const photo = $derived(photos[index]);
  $effect.pre(() => {
    curKey = photo?.key ?? null;
  });
  // 相邻两张的原图提前下载（只限不太大的照片），翻页时不用等
  const PRELOAD_MAX = 30 * 1024 * 1024;
  const preloaded = new Map<string, { blob: Promise<Blob>; ctl: AbortController }>();
  const preloadable = (p: Photo | undefined): p is Photo =>
    !!p && !p.item.m.startsWith("video/") && p.item.s > 0 && p.item.s < PRELOAD_MAX && p.acc.canOpen(p.item);
  function preloadAround() {
    const want = [photos[index - 1], photos[index + 1]].filter(preloadable);
    const keep = new Set([photos[index]?.key, ...want.map((p) => p.key)]);
    for (const [k, v] of preloaded) {
      if (keep.has(k)) continue;
      v.ctl.abort();
      preloaded.delete(k);
    }
    for (const p of want) {
      if (preloaded.has(p.key)) continue;
      const ctl = new AbortController();
      const blob = p.acc.original(p.item, ctl.signal);
      blob.catch(() => preloaded.delete(p.key));
      preloaded.set(p.key, { blob, ctl });
    }
  }
  $effect(() => () => {
    for (const v of preloaded.values()) v.ctl.abort();
    preloaded.clear();
  });

  /** 只在换了一张照片时才重新加载（列表重建、同一张照片换了新对象不算）。 */
  const photoKey = $derived(photo?.key ?? null);
  let url = $state<string | null>(null);
  let kind = $state<"image" | "video" | "none">("none");
  let loading = $state(false);
  let error = $state("");
  let showInfo = $state(false);
  /** 动态照片里那段视频（或实况照片配对的 MOV）：要播放时才取 */
  let motion = $state<(() => Promise<Blob>) | null>(null);
  let motionUrl = $state<string | null>(null);
  let motionBusy = $state(false);
  let motionError = $state("");
  /** 视频来自实况照片配对的 MOV 时，那个 MOV 的文件名（播放失败时提示下载它） */
  let motionFrom = $state<string | null>(null);

  $effect(() => {
    if (!photoKey) return;
    const p = untrack(() => photo)!;
    let cancelled = false;
    let made: string | null = null;
    let streamed: string | null = null;
    const ctl = new AbortController();
    zoom = 1;
    tx = ty = 0;
    // 滑动翻页：新照片先放在屏幕外那一侧，下一帧滑到中间
    const from = slideIn;
    dragX = from;
    slideIn = 0;
    if (from) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          settling = true;
          dragX = 0;
        }),
      );
    }
    motion = null;
    motionUrl = null;
    motionError = "";
    motionBusy = false;
    motionFrom = null;
    // 原图（大图本来就要下载）；动态视频从它里面切
    let gotRaw!: (b: Blob) => void;
    let noRaw!: (e: unknown) => void;
    const rawP = new Promise<Blob>((res, rej) => ((gotRaw = res), (noRaw = rej)));
    rawP.catch(() => {});
    const live = p.live && p.live.acc.canOpen(p.live.item) ? p.live : null;
    const fromLive = live
      ? async () => {
          const b = new Blob([await live.acc.original(live.item, ctl.signal)], { type: "video/mp4" });
          motionFrom = live.item.n;
          return b;
        }
      : null;
    const fromRaw = async (raw: Blob) => {
      const found = mayHaveMotion(p.item.m, p.item.n) ? await findMotionVideo(blobReader(raw), raw.size, true).catch(() => null) : null;
      return found ? raw.slice(found.offset, found.offset + found.length, "video/mp4") : null;
    };
    // 照片墙上已经有标记（目录里的 mo、实况配对）：按钮先显示，点了再找视频，不用等原图下载完
    if (!p.item.m.startsWith("video/") && (p.motion || live)) {
      motion = async () => {
        const v = await fromRaw(await rawP);
        if (v) return v;
        if (fromLive) return fromLive();
        throw new Error(t("这张照片里没找到动态视频"));
      };
    }
    // 先显示缩略图（用局部变量判断，不读 url，避免它成为这个 effect 的依赖）
    const thumb = cachedThumb(p);
    url = thumb;
    kind = thumb ? "image" : "none";
    error = "";
    loading = true;
    (async () => {
      try {
        if (!p.acc.canOpen(p.item)) {
          throw new Error(p.acc.wrapKey() ? t("这张照片用以前的密钥加密，手机上转换完成后就能看") : t("这张照片是加密的，请先解锁"));
        }
        if (p.item.m.startsWith("video/")) {
          if (await canStream()) {
            streamed = await streamUrl(p.acc, p.item);
            if (cancelled) return;
            url = streamed;
          } else {
            const b = await p.acc.original(p.item, ctl.signal);
            if (cancelled) return;
            url = made = URL.createObjectURL(b);
          }
          kind = "video";
          return;
        }
        const raw = await (preloaded.get(p.key)?.blob ?? p.acc.original(p.item, ctl.signal));
        gotRaw(raw);
        const b = isHeicItem(p.item) ? await heicToJpeg(raw) : raw;
        if (cancelled) return;
        url = made = URL.createObjectURL(b);
        kind = "image";
        untrack(preloadAround);
        // 没有标记的照片：原图到手后按内容找一次，找到了才显示按钮
        if (!motion) {
          const v = await fromRaw(raw);
          if (cancelled) return;
          if (v) motion = async () => v;
        }
      } catch (e) {
        noRaw(e);
        if (cancelled) return;
        error = (e as Error).message;
        p.acc.noteError(e);
      } finally {
        if (!cancelled) loading = false;
      }
    })();
    return () => {
      cancelled = true;
      ctl.abort();
      if (made) URL.revokeObjectURL(made);
      if (streamed) dropStream(streamed);
    };
  });

  // 视频地址跟着这张照片走，换照片或关掉时释放
  $effect(() => {
    const u = motionUrl;
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  });

  async function playMotion() {
    const get = motion;
    if (!get || motionBusy) return;
    if (motionUrl) {
      motionUrl = null; // 再点一次：停下回到照片
      return;
    }
    const key = photo?.key;
    motionBusy = true;
    motionError = "";
    try {
      const b = await get();
      if (photo?.key !== key) return;
      motionUrl = URL.createObjectURL(b);
    } catch (e) {
      if (photo?.key === key) motionError = (e as Error).message;
    } finally {
      if (photo?.key === key) motionBusy = false;
    }
  }

  const prev = () => index > 0 && (index -= 1);
  const next = () => index < photos.length - 1 && (index += 1);

  function onkey(e: KeyboardEvent) {
    // 上面还开着别的弹窗（删除确认等）、或者在输入框里：按键不归大图
    if (document.querySelector(".scrim") || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest("input, textarea, select")) return;
    // 视频获得焦点时方向键留给视频快进快退
    if (el?.tagName === "VIDEO" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
    if (e.key === "Escape") {
      if (zoom > 1) return void (zoom = 1, (tx = ty = 0));
      onclose();
    }
    else if (e.key === "ArrowLeft") prev();
    else if (e.key === "ArrowRight") next();
    else if (e.key === "Delete" && photo) ondelete(photo);
    else if (e.key === "i") showInfo = !showInfo;
  }

  // ---------- 手势：滑动翻页（跟手）、双击或双指缩放、放大后拖动 ----------
  let zoom = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  /** 没放大时手指拖动的横向距离（图片跟着走） */
  let dragX = $state(0);
  let settling = $state(false);
  let panning = $state(false);
  const pts = new Map<number, { x: number; y: number }>();
  let start = { x: 0, y: 0, tx: 0, ty: 0, dist: 0, zoom: 1 };
  /** 这次按下之后在做什么：还没定（可能是点按）、跟手翻页、拖动、双指缩放（之后剩一根手指也不再算点按或翻页） */
  let mode: "none" | "swipe" | "pan" | "pinch" = "none";
  let lastTap = 0;
  /** 翻页动画：新照片从这一侧滑进来 */
  let slideIn = 0;
  let stageEl = $state<HTMLElement>();
  let imgEl = $state<HTMLImageElement>();

  const clampZoom = (z: number) => Math.min(5, Math.max(1, z));
  /** 放大后图片边缘不能离开舞台边缘。 */
  function clampPan() {
    if (!stageEl || !imgEl) return;
    const mx = Math.max(0, (imgEl.offsetWidth * zoom - stageEl.clientWidth) / 2);
    const my = Math.max(0, (imgEl.offsetHeight * zoom - stageEl.clientHeight) / 2);
    tx = Math.min(mx, Math.max(-mx, tx));
    ty = Math.min(my, Math.max(-my, ty));
  }
  function zoomAt(z: number, cx: number, cy: number) {
    const r = stageEl!.getBoundingClientRect();
    const ox = cx - r.left - r.width / 2;
    const oy = cy - r.top - r.height / 2;
    const nz = clampZoom(z);
    // 让手指（鼠标）下面那一点保持不动
    tx = ox - ((ox - tx) * nz) / zoom;
    ty = oy - ((oy - ty) * nz) / zoom;
    zoom = nz;
    if (zoom === 1) tx = ty = 0;
    clampPan();
  }
  /** 按钮不归手势；视频底部那条控制栏（进度条）也不归，免得拖进度条变成翻页。 */
  function skip(e: PointerEvent | WheelEvent) {
    const el = e.target as HTMLElement;
    if (el.closest("button")) return true;
    const v = el.closest("video");
    return !!v && v.getBoundingClientRect().bottom - e.clientY < 56;
  }
  /** 缩放、拖动、双击只对图片；视频页和没加载出来的页面只能滑动翻页。 */
  const zoomable = () => kind === "image";
  function capture(id: number) {
    try {
      stageEl!.setPointerCapture(id);
    } catch {}
  }
  const restart = (x: number, y: number) => (start = { x, y, tx, ty, zoom, dist: 0 });

  function down(e: PointerEvent) {
    if (skip(e)) return;
    // 视频上先不抓指针，点按照样能暂停、调出控制条；确定是滑动时再抓
    if (zoomable()) capture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    settling = false;
    const [a, b] = [...pts.values()];
    if (a && b && zoomable()) {
      // 第二根手指落下：改成缩放，之前那点横向拖动作废
      mode = "pinch";
      dragX = 0;
      start = { x: e.clientX, y: e.clientY, tx, ty, zoom, dist: Math.hypot(a.x - b.x, a.y - b.y) };
    } else if (pts.size === 1) {
      mode = zoom > 1 ? "pan" : "none";
      restart(e.clientX, e.clientY);
    }
  }
  function move(e: PointerEvent) {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...pts.values()];
    if (a && b) {
      if (start.dist && zoomable()) zoomAt((start.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / start.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (zoom > 1) {
      panning = true;
      tx = start.tx + dx;
      ty = start.ty + dy;
      clampPan();
    } else if (mode === "none" && e.pointerType !== "mouse" && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      mode = "swipe";
      capture(e.pointerId);
      motionUrl = null; // 动态照片正在播：开始翻页就停掉
    }
    if (mode === "swipe") {
      // 到头了：拖动距离减半，松手弹回
      const stuck = (dx > 0 && index === 0) || (dx < 0 && index >= photos.length - 1);
      dragX = stuck ? dx / 2 : dx;
    }
  }
  function up(e: PointerEvent) {
    if (!pts.delete(e.pointerId)) return;
    panning = false;
    if (pts.size) {
      // 双指里先抬起一根：从剩下那根手指的位置接着拖
      const [rest] = [...pts.values()];
      restart(rest!.x, rest!.y);
      return;
    }
    if (mode === "swipe") {
      mode = "none";
      settling = true;
      const dx = dragX;
      const dir = dx < 0 ? 1 : -1;
      const can = dir > 0 ? index < photos.length - 1 : index > 0;
      if (Math.abs(dx) > 60 && can && e.type === "pointerup") {
        // 旧图顺着方向滑出去，新图从另一侧滑进来
        const w = stageEl!.clientWidth;
        dragX = -dir * w;
        setTimeout(() => {
          settling = false;
          slideIn = dir * w;
          index += dir;
        }, 160);
      } else dragX = 0;
      return;
    }
    if (mode === "pinch") {
      mode = "none";
      if (zoom < 1.05) {
        settling = true;
        zoomAt(1, 0, 0);
      }
      return;
    }
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    mode = "none";
    if (moved < 10 && e.type === "pointerup" && zoomable()) {
      const now = Date.now();
      if (now - lastTap < 300) {
        lastTap = 0;
        settling = true;
        zoomAt(zoom > 1 ? 1 : 2.5, e.clientX, e.clientY);
      } else lastTap = now;
    }
  }
  function wheel(e: WheelEvent) {
    if (skip(e) || !zoomable()) return;
    e.preventDefault();
    settling = false;
    zoomAt(zoom * Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
  }
  // 窗口大小变了也要守住边界
  $effect(() => {
    const onResize = () => clampPan();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });
</script>

<svelte:window onkeydown={onkey} />

{#if photo}
  <div class="viewer" role="dialog" aria-modal="true" aria-label={photo.item.n} out:fade|global={{ duration: 160 }}>
    <div class="bar">
      <button class="icon-btn" onclick={onclose} aria-label={t("关闭")}><Icon name="back" /></button>
      <span class="title">{photo.item.n}</span>
      {#if motion}
        <button class="icon-btn" class:on={!!motionUrl} onclick={playMotion} aria-label={motionUrl ? t("停止播放动态照片") : t("播放动态照片")} title={t("动态照片")}>
          <Icon name="live" />
        </button>
      {/if}
      <button class="icon-btn" onclick={() => (showInfo = !showInfo)} aria-label={t("信息")}><Icon name="info" /></button>
      <button class="icon-btn" onclick={() => ondownload(photo)} aria-label={t("下载")}><Icon name="download" /></button>
      <button class="icon-btn" onclick={() => ondelete(photo)} aria-label={t("删除")}><Icon name="trash" /></button>
    </div>
    <div class="stage" bind:this={stageEl} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onwheel={wheel}>
      {#if kind === "video" && url}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={url} controls autoplay playsinline class:settling style:transform={dragX ? `translateX(${dragX}px)` : null}></video>
      {:else if url}
        {#key photo.key}<img
          bind:this={imgEl} src={url} alt={photo.item.n} decoding="async" draggable="false" class:settling class:zoomed={zoom > 1} class:panning
          style:transform="translate({tx + dragX}px, {ty}px) scale({zoom})"
        />{/key}
      {/if}
      {#if motionUrl}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="motion" src={motionUrl} autoplay playsinline
          onended={() => (motionUrl = null)}
          onclick={() => (motionUrl = null)}
          onerror={() => {
            motionUrl = null;
            motionError = motionFrom ? t("这个浏览器播放不了这段视频，可以下载 {name} 在手机上看", { name: motionFrom }) : t("这个浏览器播放不了这段视频，可以下载原图在手机上看");
          }}
        ></video>
      {/if}
      {#if motionError && !error}
        <div class="msg"><Icon name="warn" /> {motionError}</div>
      {/if}
      {#if error}
        <div class="msg"><Icon name="warn" /> {error}</div>
      {:else if loading || motionBusy}
        <div class="spinner" aria-label={t("加载中")}></div>
      {/if}
      {#if index > 0}<button class="nav left" onclick={prev} aria-label={t("上一张")}><Icon name="left" size={28} /></button>{/if}
      {#if index < photos.length - 1}<button class="nav right" onclick={next} aria-label={t("下一张")}><Icon name="right" size={28} /></button>{/if}
    </div>
    {#if showInfo}
      <aside class="info">
        <h3>{t("详细信息")}</h3>
        <dl>
          <dt>{t("拍摄时间")}</dt><dd>{photo.item.t ? fmtTime(photo.item.t) : t("未知")}</dd>
          <dt>{t("文件名")}</dt><dd>{photo.item.n}</dd>
          <dt>{t("大小")}</dt><dd>{fmtSize(photo.item.s)}</dd>
          <dt>{t("相簿")}</dt><dd>{photo.item.a || t("未命名")}</dd>
          <dt>{t("存放位置")}</dt><dd>{photo.acc.label}{#each photo.copies as c}<br />{c.acc.label}{/each}</dd>
          <dt>{t("端到端加密")}</dt><dd>{photo.item.e ? t("是") : t("否")}</dd>
          {#if motion}<dt>{t("动态照片")}</dt><dd>{photo.live ? t("是（实况照片，配对 {name}）", { name: photo.live.item.n }) : t("是（视频在原图里）")}</dd>{/if}
        </dl>
      </aside>
    {/if}
  </div>
{/if}

<style>
  .viewer {
    position: fixed; inset: 0; z-index: 40; background: #000; color: #eee;
    display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto 1fr;
    animation: zy-fade 0.18s ease-out;
  }
  .stage img, .stage video { animation: zy-fade 0.22s ease-out; }
  .bar { grid-column: 1 / -1; display: flex; align-items: center; gap: 4px; padding: 6px 8px; background: linear-gradient(#000c, #0000); }
  .bar .icon-btn:hover { background: #ffffff22; }
  .bar .icon-btn.on { background: #ffffff33; }
  .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; opacity: 0.85; }
  .stage { position: relative; display: grid; place-items: center; overflow: hidden; min-height: 0; touch-action: none; }
  .stage img { will-change: transform; user-select: none; -webkit-user-drag: none; }
  .stage img.zoomed { cursor: grab; }
  .stage img.panning { cursor: grabbing; }
  .stage video.settling, .stage img.settling { transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1); }
  img, video { max-width: 100%; max-height: 100%; object-fit: contain; grid-area: 1 / 1; }
  .motion { z-index: 1; width: 100%; height: 100%; object-fit: contain; }
  .nav {
    position: absolute; top: 50%; transform: translateY(-50%); width: 48px; height: 48px; border-radius: 50%;
    border: none; background: #ffffff1f; color: #fff; display: grid; place-items: center;
  }
  .nav:hover { background: #ffffff38; }
  .left { left: 12px; }
  .right { right: 12px; }
  @media (hover: none) { .nav { display: none; } }
  .msg { grid-area: 1 / 1; background: #000a; padding: 10px 16px; border-radius: 10px; display: flex; gap: 8px; align-items: center; max-width: 90%; }
  .spinner {
    grid-area: 1 / 1; align-self: end; margin-bottom: 24px; width: 28px; height: 28px; border-radius: 50%;
    border: 3px solid #ffffff44; border-top-color: #fff; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .info { animation: zy-fade 0.18s ease-out; width: 300px; background: #151514; padding: 16px 20px; overflow: auto; }
  @media (max-width: 700px) { .info { position: absolute; inset: auto 0 0 0; width: auto; max-height: 50%; } }
  .info h3 { margin: 0 0 12px; font-size: 16px; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 8px 14px; font-size: 13px; }
  dt { opacity: 0.6; white-space: nowrap; }
  dd { margin: 0; word-break: break-all; }
</style>
