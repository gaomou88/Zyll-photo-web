<script lang="ts">
  import Icon from "./Icon.svelte";
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

  const photo = $derived(photos[index]);
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
    const p = photo;
    if (!p) return;
    let cancelled = false;
    let made: string | null = null;
    let streamed: string | null = null;
    const ctl = new AbortController();
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
        throw new Error("这张照片里没找到动态视频");
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
          throw new Error(p.acc.wrapKey() ? "这张照片用以前的密钥加密，手机上转换完成后就能看" : "这张照片是加密的，请先解锁");
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
        const raw = await p.acc.original(p.item, ctl.signal);
        gotRaw(raw);
        const b = isHeicItem(p.item) ? await heicToJpeg(raw) : raw;
        if (cancelled) return;
        url = made = URL.createObjectURL(b);
        kind = "image";
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
    if (e.key === "Escape") onclose();
    else if (e.key === "ArrowLeft") prev();
    else if (e.key === "ArrowRight") next();
    else if (e.key === "Delete" && photo) ondelete(photo);
    else if (e.key === "i") showInfo = !showInfo;
  }

  // 触屏左右滑动
  let sx = 0;
  const ts = (e: TouchEvent) => (sx = e.touches[0]!.clientX);
  const te = (e: TouchEvent) => {
    const dx = e.changedTouches[0]!.clientX - sx;
    if (Math.abs(dx) > 60) (dx > 0 ? prev : next)();
  };
</script>

<svelte:window onkeydown={onkey} />

{#if photo}
  <div class="viewer" role="dialog" aria-modal="true" aria-label={photo.item.n}>
    <div class="bar">
      <button class="icon-btn" onclick={onclose} aria-label="关闭"><Icon name="back" /></button>
      <span class="title">{photo.item.n}</span>
      {#if motion}
        <button class="icon-btn" class:on={!!motionUrl} onclick={playMotion} aria-label={motionUrl ? "停止播放动态照片" : "播放动态照片"} title="动态照片">
          <Icon name="live" />
        </button>
      {/if}
      <button class="icon-btn" onclick={() => (showInfo = !showInfo)} aria-label="信息"><Icon name="info" /></button>
      <button class="icon-btn" onclick={() => ondownload(photo)} aria-label="下载"><Icon name="download" /></button>
      <button class="icon-btn" onclick={() => ondelete(photo)} aria-label="删除"><Icon name="trash" /></button>
    </div>
    <div class="stage" ontouchstart={ts} ontouchend={te}>
      {#if kind === "video" && url}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={url} controls autoplay playsinline></video>
      {:else if url}
        {#key photo.key}<img src={url} alt={photo.item.n} decoding="async" />{/key}
      {/if}
      {#if motionUrl}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="motion" src={motionUrl} autoplay playsinline
          onended={() => (motionUrl = null)}
          onclick={() => (motionUrl = null)}
          onerror={() => {
            motionUrl = null;
            motionError = motionFrom ? `这个浏览器播放不了这段视频，可以下载 ${motionFrom} 在手机上看` : "这个浏览器播放不了这段视频，可以下载原图在手机上看";
          }}
        ></video>
      {/if}
      {#if motionError && !error}
        <div class="msg"><Icon name="warn" /> {motionError}</div>
      {/if}
      {#if error}
        <div class="msg"><Icon name="warn" /> {error}</div>
      {:else if loading || motionBusy}
        <div class="spinner" aria-label="加载中"></div>
      {/if}
      {#if index > 0}<button class="nav left" onclick={prev} aria-label="上一张"><Icon name="left" size={28} /></button>{/if}
      {#if index < photos.length - 1}<button class="nav right" onclick={next} aria-label="下一张"><Icon name="right" size={28} /></button>{/if}
    </div>
    {#if showInfo}
      <aside class="info">
        <h3>详细信息</h3>
        <dl>
          <dt>拍摄时间</dt><dd>{photo.item.t ? fmtTime(photo.item.t) : "未知"}</dd>
          <dt>文件名</dt><dd>{photo.item.n}</dd>
          <dt>大小</dt><dd>{fmtSize(photo.item.s)}</dd>
          <dt>相簿</dt><dd>{photo.item.a || "未命名"}</dd>
          <dt>存放位置</dt><dd>{photo.acc.label}{#each photo.copies as c}<br />{c.acc.label}{/each}</dd>
          <dt>端到端加密</dt><dd>{photo.item.e ? "是" : "否"}</dd>
          {#if motion}<dt>动态照片</dt><dd>{photo.live ? `是（实况照片，配对 ${photo.live.item.n}）` : "是（视频在原图里）"}</dd>{/if}
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
  .stage { position: relative; display: grid; place-items: center; overflow: hidden; min-height: 0; }
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
