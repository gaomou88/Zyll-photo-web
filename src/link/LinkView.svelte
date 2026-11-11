<script lang="ts">
  import { onDestroy } from "svelte";
  import { BlobKind, fromBase64, sharelink, zylc } from "@zyll/crypto";
  import { runKdf } from "../kdf";
  import { t, htmlLang } from "../lib/i18n";
  import { fmtSize, isHeic, heicToJpeg } from "../lib/media";
  import { FetchError, fetchPublic } from "./fetch";

  let { fragment, forget }: { fragment: string; forget: () => void } = $props();

  type Phase = "bad" | "password" | "busy" | "open" | "expired" | "gone";
  let frag: sharelink.Fragment | null = null;
  try {
    frag = sharelink.parseFragment(fragment);
  } catch {
    frag = null;
  }

  let phase = $state<Phase>(frag ? "password" : "bad");
  if (!frag) forget();
  let password = $state("");
  let showPassword = $state(false);
  let error = $state("");
  let manifest = $state<sharelink.LinkManifest | null>(null);
  let thumbs = $state<Record<number, string>>({});
  let viewing = $state<number | null>(null);
  let full = $state<{ url: string; video: boolean } | null>(null);
  let fullError = $state("");
  let fullBusy = $state(false);
  /** 正在看的大图的进度（已下载字节、总字节）。 */
  let fullProgress = $state<{ done: number; total: number } | null>(null);
  /** 很大的文件：手机上先问一下再下载（整个读进内存解密，几百 MB 的视频可能让手机浏览器崩掉）。 */
  let bigAsk = $state(false);
  let downloading = $state(false);
  /** 看大图时的提示（下载失败等），几秒后消失。 */
  let notice = $state("");
  /** 当前大图解密后的原始数据（下载原图时直接用，不再下载一遍）。 */
  let fullOrig: { idx: number; blob: Blob } | null = null;

  /** 下载回来的清单密文：密码输错重试时不用再下载。 */
  let sealed: Uint8Array | null = null;
  const urls: string[] = [];
  const abort = new AbortController();

  document.documentElement.lang = htmlLang;

  const items = $derived(manifest ? [...manifest.items].sort((a, b) => b.t - a.t) : []);
  const providerOf = (i: sharelink.LinkItem): sharelink.Provider => i.p ?? frag!.provider;

  async function unlock(e: Event) {
    e.preventDefault();
    if (!frag || phase === "busy") return;
    error = "";
    phase = "busy";
    try {
      if (!sealed) sealed = await fetchPublic(frag.provider, frag.loc, true, abort.signal);
      const { masterKey: key } = await runKdf({ op: "link", secret: frag.secret, password });
      let m: sharelink.LinkManifest;
      try {
        m = sharelink.parseManifest(await sharelink.openManifest(sealed, key!));
      } catch {
        error = t("密码不正确");
        phase = "password";
        return;
      } finally {
        key?.fill(0);
      }
      password = "";
      if (m.expires !== null && m.expires <= Date.now()) {
        phase = "expired";
        forget();
        return;
      }
      manifest = m;
      phase = "open";
      document.title = `${m.title || t("分享的照片")} · Zyll`;
      loadThumbs();
    } catch (err) {
      if (err instanceof FetchError && err.gone) {
        phase = "gone";
        forget();
      } else if (err instanceof FetchError && (err.status === 401 || err.status === 403 || err.status === 429)) {
        error = t("暂时打不开，请稍后再试");
        phase = "password";
      } else {
        error = t("读取失败，请检查网络后重试");
        phase = "password";
      }
    }
  }

  /** 缩略图同时最多下载 4 张。 */
  async function loadThumbs() {
    const list = items;
    let next = 0;
    const worker = async () => {
      while (next < list.length && !abort.signal.aborted) {
        const idx = next++;
        const it = list[idx];
        if (!it.tf || !it.tk) continue;
        try {
          const data = await fetchPublic(providerOf(it), it.tf, false, abort.signal);
          const plain = await zylc.decryptWithDek(data, fromBase64(it.tk), BlobKind.Thumbnail);
          const url = URL.createObjectURL(new Blob([plain as BlobPart], { type: "image/jpeg" }));
          urls.push(url);
          thumbs = { ...thumbs, [idx]: url };
        } catch {
          // 这张的缩略图读不到：格子上显示占位
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  let fullJob = 0;
  const BIG = 100 * 1024 * 1024;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

  /** 打开大图（[force]：很大的文件也直接下载）。 */
  async function open(idx: number, force = false) {
    if (viewing === null) {
      // 大图占一条浏览记录：手机上按返回键（或侧滑返回）关掉大图，而不是离开整个页面
      history.pushState({ zyllViewer: true }, "");
      pushed = true;
      // 看大图时下拉不触发浏览器的“下拉刷新”
      document.documentElement.style.overscrollBehaviorY = "none";
    }
    viewing = idx;
    const it = items[idx];
    const job = ++fullJob;
    if (full) URL.revokeObjectURL(full.url);
    full = null;
    fullOrig = null;
    fullError = "";
    fullProgress = null;
    notice = "";
    bigAsk = coarse && !force && it.s > BIG;
    if (bigAsk) {
      fullBusy = false;
      return;
    }
    fullBusy = true;
    try {
      const data = await fetchPublic(providerOf(it), it.f, false, abort.signal, (done, total) => {
        if (job === fullJob) fullProgress = { done, total: total || it.s };
      });
      const plain = await zylc.decryptWithDek(data, fromBase64(it.dk), BlobKind.Original);
      const orig = new Blob([plain as BlobPart], { type: it.m || "application/octet-stream" });
      const blob = isHeic(it.m, it.n) ? await heicToJpeg(orig) : orig;
      if (job !== fullJob) return;
      fullOrig = { idx, blob: orig };
      full = { url: URL.createObjectURL(blob), video: it.m.startsWith("video/") };
    } catch {
      if (job === fullJob) fullError = t("这张照片读取失败");
    } finally {
      if (job === fullJob) fullBusy = false;
    }
  }

  let pushed = false;

  /** 关掉大图：有浏览记录时退一步（由 popstate 真正关掉），这样返回键和 ✕ 的效果一样。 */
  function close() {
    if (pushed) history.back();
    else closeNow();
  }

  function closeNow() {
    pushed = false;
    document.documentElement.style.overscrollBehaviorY = "";
    fullJob++;
    viewing = null;
    if (full) URL.revokeObjectURL(full.url);
    full = null;
    fullOrig = null;
    bigAsk = false;
    notice = "";
  }

  function onPop(e: PopStateEvent) {
    if (viewing !== null) closeNow();
    // 刷新前看大图时留下的那条记录：退到它上面没有大图可关，直接再退一步，返回键不会“没反应”
    else if (!(e.state as { zyllViewer?: boolean } | null)?.zyllViewer) history.back();
  }

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function show(msg: string) {
    notice = msg;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = ""), 4000);
  }

  async function download() {
    if (viewing === null || !manifest?.originals || downloading) return;
    const idx = viewing;
    const it = items[idx];
    downloading = true;
    try {
      // 大图已经解开了：直接用（HEIC 给原始文件，不是转换后的 JPEG）
      let blob = fullOrig?.idx === idx ? fullOrig.blob : null;
      if (!blob) {
        const data = await fetchPublic(providerOf(it), it.f, false, abort.signal);
        const plain = await zylc.decryptWithDek(data, fromBase64(it.dk), BlobKind.Original);
        blob = new Blob([plain as BlobPart], { type: it.m || "application/octet-stream" });
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = it.n || "photo";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      show(t("下载失败，请稍后再试"));
    } finally {
      downloading = false;
    }
  }

  // 手机上左右滑切换、下滑关闭
  let touch: { x: number; y: number } | null = null;
  // 双指放大过（页面缩放 > 1）：单指拖动是在看细节，交给浏览器平移，不当成翻页或关闭
  const zoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;
  function onTouchStart(e: TouchEvent) {
    touch = e.touches.length === 1 && !zoomed() ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }
  function onTouchEnd(e: TouchEvent) {
    // 这次触摸里出现过第二根手指（在缩放）也不算
    if (e.touches.length > 0) touch = null;
    if (!touch || viewing === null || e.changedTouches.length !== 1 || zoomed()) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    // 视频的进度条上拖动不算
    if ((e.target as HTMLElement | null)?.tagName === "VIDEO" && Math.abs(dy) < 120) return;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && viewing < items.length - 1) open(viewing + 1);
      else if (dx > 0 && viewing > 0) open(viewing - 1);
    } else if (dy > 100 && dy > Math.abs(dx) * 1.5) {
      close();
    }
  }

  function onKey(e: KeyboardEvent) {
    if (viewing === null) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft" && viewing > 0) open(viewing - 1);
    else if (e.key === "ArrowRight" && viewing < items.length - 1) open(viewing + 1);
  }

  const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(htmlLang, { year: "numeric", month: "long", day: "numeric" });

  onDestroy(() => {
    clearTimeout(noticeTimer);
    abort.abort();
    urls.forEach((u) => URL.revokeObjectURL(u));
    if (full) URL.revokeObjectURL(full.url);
  });
</script>

<svelte:window onkeydown={onKey} onpopstate={onPop} />

<main class="link">
  {#if phase === "bad"}
    <section class="card">
      <h1>{t("链接不完整")}</h1>
      <p class="muted">{t("请把对方发来的链接完整复制到地址栏（包括 # 后面的部分）。")}</p>
    </section>
  {:else if phase === "gone"}
    <section class="card">
      <h1>{t("链接已失效")}</h1>
      <p class="muted">{t("分享者可能已经撤销了这个链接，或者它已经过期。")}</p>
    </section>
  {:else if phase === "expired"}
    <section class="card">
      <h1>{t("链接已过期")}</h1>
      <p class="muted">{t("这个链接的有效期已经过了，请联系分享者重新分享。")}</p>
    </section>
  {:else if phase === "password" || phase === "busy"}
    <form class="card" onsubmit={unlock}>
      <h1>{t("有人和你分享了照片")}</h1>
      <p class="muted">{t("输入分享者单独告诉你的密码。照片只在这个浏览器里解密，密码不会发送到任何地方。")}</p>
      <!-- svelte-ignore a11y_autofocus -->
      <div class="pw">
        <input type={showPassword ? "text" : "password"} autocomplete="off" autocapitalize="off" spellcheck="false" autofocus bind:value={password} placeholder={t("密码")} disabled={phase === "busy"} />
        <button type="button" class="eye" onclick={() => (showPassword = !showPassword)} aria-label={showPassword ? t("隐藏密码") : t("显示密码")} aria-pressed={showPassword}>
          {#if showPassword}
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 4.5 10 6-.4.7-1.5 2.1-3 3.4M6.4 7.4C4.4 8.7 2.9 10.6 2 12c1 1.5 5 6 10 6 1.6 0 3-.4 4.3-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M2 12c1-1.5 5-6 10-6s9 4.5 10 6c-1 1.5-5 6-10 6S3 13.5 2 12z"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
          {/if}
        </button>
      </div>
      {#if error}<p class="error">{error}</p>{/if}
      <button type="submit" class="primary" disabled={phase === "busy" || password.length === 0}>
        {phase === "busy" ? t("正在打开…") : t("打开")}
      </button>
    </form>
  {:else if manifest}
    <header class="head">
      <h1>{manifest.title || t("分享的照片")}</h1>
      <p class="muted">
        {t("{n} 项", { n: items.length })}
        {#if manifest.expires !== null} · {t("有效期至 {date}", { date: fmtDate(manifest.expires) })}{/if}
      </p>
    </header>
    <div class="grid">
      {#each items as it, idx (idx)}
        <button class="tile" onclick={() => open(idx)} aria-label={it.n}>
          {#if thumbs[idx]}<img src={thumbs[idx]} alt="" />{:else}<span class="ph">{it.m.startsWith("video/") ? "▶" : ""}</span>{/if}
          {#if it.m.startsWith("video/")}<span class="badge">▶</span>{/if}
        </button>
      {/each}
    </div>
    <p class="foot muted">{t("由 Zyll 相册分享。照片端到端加密，只在你的浏览器里解密。")}</p>
  {/if}
</main>

{#if viewing !== null && items[viewing]}
  {@const it = items[viewing]}
  <div class="viewer" role="dialog" aria-modal="true">
    <div class="bar">
      <span class="name">{it.n} · {fmtSize(it.s)}</span>
      {#if manifest?.originals}<button onclick={download} disabled={downloading}>{downloading ? t("正在下载…") : t("下载原图")}</button>{/if}
      <button onclick={close} aria-label={t("关闭")}>✕</button>
    </div>
    {#if notice}<p class="notice" role="status">{notice}</p>{/if}
    <div class="stage" ontouchstart={onTouchStart} ontouchend={onTouchEnd}>
      {#if viewing > 0}<button class="nav prev" onclick={() => open(viewing! - 1)} aria-label={t("上一张")}>‹</button>{/if}
      {#if full}
        {#if full.video}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video src={full.url} controls autoplay playsinline></video>
        {:else}
          <img src={full.url} alt={it.n} />
        {/if}
      {:else if fullError}
        <p class="error">{fullError}</p>
      {:else if bigAsk}
        <div class="big">
          <p>{t("这个文件有 {size}，在手机浏览器里可能打不开，建议在电脑上查看。", { size: fmtSize(it.s) })}</p>
          <button onclick={() => open(viewing!, true)}>{t("仍然打开")}</button>
        </div>
      {:else if fullBusy}
        {#if thumbs[viewing]}<img class="blur" src={thumbs[viewing]} alt="" />{/if}
        <p class="loading">
          {#if fullProgress && fullProgress.total > 0}
            {t("正在加载… {pct}%", { pct: Math.min(99, Math.floor((fullProgress.done / fullProgress.total) * 100)) })}
          {:else}
            {t("正在加载…")}
          {/if}
        </p>
      {/if}
      {#if viewing < items.length - 1}<button class="nav next" onclick={() => open(viewing! + 1)} aria-label={t("下一张")}>›</button>{/if}
    </div>
  </div>
{/if}

<style>
  .link { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  .card { max-width: 420px; margin: 12vh auto 0; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 24px; display: flex; flex-direction: column; gap: 12px; }
  h1 { font-size: 1.3rem; margin: 0; }
  .muted { color: var(--muted); margin: 0; line-height: 1.5; }
  .error { color: var(--danger); margin: 0; }
  .pw { position: relative; display: flex; }
  .pw input { flex: 1; padding-right: 44px; }
  .eye { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 36px; height: 36px; display: grid; place-items: center; border: none; background: none; color: var(--muted); border-radius: 8px; }
  input { font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); }
  button { font: inherit; cursor: pointer; }
  .primary { padding: 10px 16px; border-radius: 10px; border: none; background: var(--accent); color: var(--accent-text); }
  .primary:disabled { opacity: 0.5; cursor: default; }
  .head { margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 4px; }
  .tile { position: relative; aspect-ratio: 1; border: none; padding: 0; background: var(--tile-bg); overflow: hidden; }
  .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ph { color: var(--muted); }
  .badge { position: absolute; right: 6px; bottom: 4px; color: #fff; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6); }
  .foot { margin-top: 24px; font-size: 0.85rem; text-align: center; }
  .viewer { overscroll-behavior: contain; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.94); display: flex; flex-direction: column; z-index: 10; }
  .bar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; color: #eee; }
  .bar .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9rem; }
  .bar button { background: rgba(255, 255, 255, 0.12); color: #fff; border: none; border-radius: 8px; padding: 6px 12px; }
  .bar button:disabled { opacity: 0.6; cursor: default; }
  .notice { margin: 0 12px; padding: 8px 12px; border-radius: 8px; background: rgba(255, 255, 255, 0.14); color: #fff; font-size: 0.9rem; }
  .big { color: #eee; text-align: center; max-width: 320px; padding: 0 16px; display: flex; flex-direction: column; gap: 12px; align-items: center; }
  .big p { margin: 0; line-height: 1.5; }
  .big button { background: rgba(255, 255, 255, 0.16); color: #fff; border: none; border-radius: 8px; padding: 8px 16px; }
  .stage { touch-action: manipulation; position: relative; flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
  .stage img, .stage video { max-width: 100%; max-height: 100%; object-fit: contain; }
  .stage .blur { filter: blur(8px); opacity: 0.6; position: absolute; }
  .loading { color: #ddd; position: relative; }
  .nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255, 255, 255, 0.12); color: #fff; border: none; width: 44px; height: 64px; font-size: 2rem; border-radius: 8px; z-index: 1; }
  .prev { left: 8px; }
  .next { right: 8px; }
</style>
