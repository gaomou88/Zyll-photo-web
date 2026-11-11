<script lang="ts">
  import { onDestroy } from "svelte";
  import { BlobKind, fromBase64, sharelink, zylc } from "@zyll/crypto";
  import { runKdf } from "../kdf";
  import { t, htmlLang } from "../lib/i18n";
  import { fmtSize, isHeic, heicToJpeg } from "../lib/media";
  import { FetchError, fetchPublic } from "./fetch";

  let { fragment }: { fragment: string } = $props();

  type Phase = "bad" | "password" | "busy" | "open" | "expired" | "gone";
  let frag: sharelink.Fragment | null = null;
  try {
    frag = sharelink.parseFragment(fragment);
  } catch {
    frag = null;
  }

  let phase = $state<Phase>(frag ? "password" : "bad");
  let password = $state("");
  let error = $state("");
  let manifest = $state<sharelink.LinkManifest | null>(null);
  let thumbs = $state<Record<number, string>>({});
  let viewing = $state<number | null>(null);
  let full = $state<{ url: string; video: boolean } | null>(null);
  let fullError = $state("");
  let fullBusy = $state(false);

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
        return;
      }
      manifest = m;
      phase = "open";
      document.title = `${m.title || t("分享的照片")} · Zyll`;
      loadThumbs();
    } catch (err) {
      if (err instanceof FetchError && (err.status === 404 || err.status === 403 || err.status === 401)) {
        phase = "gone";
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
  async function open(idx: number) {
    viewing = idx;
    const it = items[idx];
    const job = ++fullJob;
    if (full) URL.revokeObjectURL(full.url);
    full = null;
    fullError = "";
    fullBusy = true;
    try {
      const data = await fetchPublic(providerOf(it), it.f, false, abort.signal);
      const plain = await zylc.decryptWithDek(data, fromBase64(it.dk), BlobKind.Original);
      let blob = new Blob([plain as BlobPart], { type: it.m || "application/octet-stream" });
      if (isHeic(it.m, it.n)) blob = await heicToJpeg(blob);
      if (job !== fullJob) return;
      full = { url: URL.createObjectURL(blob), video: it.m.startsWith("video/") };
    } catch {
      if (job === fullJob) fullError = t("这张照片读取失败");
    } finally {
      if (job === fullJob) fullBusy = false;
    }
  }

  function close() {
    fullJob++;
    viewing = null;
    if (full) URL.revokeObjectURL(full.url);
    full = null;
  }

  async function download() {
    if (viewing === null || !manifest?.originals) return;
    const it = items[viewing];
    try {
      const data = await fetchPublic(providerOf(it), it.f, false, abort.signal);
      const plain = await zylc.decryptWithDek(data, fromBase64(it.dk), BlobKind.Original);
      const url = URL.createObjectURL(new Blob([plain as BlobPart], { type: it.m || "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = it.n || "photo";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      fullError = t("这张照片读取失败");
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
    abort.abort();
    urls.forEach((u) => URL.revokeObjectURL(u));
    if (full) URL.revokeObjectURL(full.url);
  });
</script>

<svelte:window onkeydown={onKey} />

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
      <input type="password" autocomplete="off" autofocus bind:value={password} placeholder={t("密码")} disabled={phase === "busy"} />
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
      {#if manifest?.originals}<button onclick={download}>{t("下载原图")}</button>{/if}
      <button onclick={close} aria-label={t("关闭")}>✕</button>
    </div>
    <div class="stage">
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
      {:else if fullBusy}
        {#if thumbs[viewing]}<img class="blur" src={thumbs[viewing]} alt="" />{/if}
        <p class="loading">{t("正在加载…")}</p>
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
  .viewer { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.94); display: flex; flex-direction: column; z-index: 10; }
  .bar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; color: #eee; }
  .bar .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9rem; }
  .bar button { background: rgba(255, 255, 255, 0.12); color: #fff; border: none; border-radius: 8px; padding: 6px 12px; }
  .stage { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
  .stage img, .stage video { max-width: 100%; max-height: 100%; object-fit: contain; }
  .stage .blur { filter: blur(8px); opacity: 0.6; position: absolute; }
  .loading { color: #ddd; position: relative; }
  .nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255, 255, 255, 0.12); color: #fff; border: none; width: 44px; height: 64px; font-size: 2rem; border-radius: 8px; z-index: 1; }
  .prev { left: 8px; }
  .next { right: 8px; }
</style>
