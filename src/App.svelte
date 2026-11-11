<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import Icon from "./components/Icon.svelte";
  import Welcome from "./components/Welcome.svelte";
  import Timeline from "./components/Timeline.svelte";
  import Albums from "./components/Albums.svelte";
  import Viewer from "./components/Viewer.svelte";
  import Settings from "./components/Settings.svelte";
  import UnlockDialog from "./components/UnlockDialog.svelte";
  import UploadDialog from "./components/UploadDialog.svelte";
  import UploadPanel from "./components/UploadPanel.svelte";
  import AppBanner from "./components/AppBanner.svelte";
  import SiteFooter from "./components/SiteFooter.svelte";
  import Shared from "./components/Shared.svelte";
  import ShareDialog from "./components/ShareDialog.svelte";
  import { shared } from "./lib/sharing.svelte";
  import { t, htmlLang } from "./lib/i18n";
  import { library, type Photo } from "./lib/library.svelte";
  import { uploads } from "./lib/uploads.svelte";
  import { downloadPhotos } from "./lib/download";
  import { clearThumbs } from "./lib/thumbs";
  import { clearStreams, startServiceWorker } from "./lib/stream";

  type View = "photos" | "albums" | "videos" | "shared" | "settings";
  const VIEWS: View[] = ["photos", "albums", "videos", "shared", "settings"];

  // 当前页面记在地址的 # 后面（#/settings、#/albums/相机）：刷新、下拉刷新后还停在原来的页面，返回键也能用
  function parseRoute(): { view: View; album: string | null } {
    const m = /^#\/([a-z]+)(?:\/(.+))?$/.exec(location.hash);
    const v = (m?.[1] ?? "photos") as View;
    if (!VIEWS.includes(v)) return { view: "photos", album: null };
    let a: string | null = null;
    if (v === "albums" && m?.[2]) {
      try {
        a = decodeURIComponent(m[2]);
      } catch {
        a = null;
      }
    }
    return { view: v, album: a };
  }
  const initial = parseRoute();
  let view = $state<View>(initial.view);
  let album = $state<string | null>(initial.album);
  $effect(() => {
    const want = view === "photos" ? "" : `#/${view}${view === "albums" && album !== null ? "/" + encodeURIComponent(album) : ""}`;
    if (location.hash !== want && !(want === "" && location.hash === "")) {
      history.pushState(null, "", location.pathname + location.search + want);
    }
  });
  function onPop() {
    const r = parseRoute();
    view = r.view;
    album = r.album;
    viewerIndex = null;
  }
  let drawer = $state(false);
  let viewerIndex = $state<number | null>(null);
  let wall = $state<ReturnType<typeof Timeline>>();
  let showUnlock = $state(false);
  let unlockDismissed = $state(false);
  let pendingFiles = $state<File[] | null>(null);
  let confirmDelete = $state<Photo[] | null>(null);
  let deleting = $state(false);
  let toast = $state("");
  let dragging = $state(0);
  const selected = new SvelteSet<string>();
  let lastToggled = -1;
  let fileInput = $state<HTMLInputElement>();

  library.loadAll().then(() => shared.pushDirty());

  document.documentElement.lang = htmlLang;
  // 别人发来的共享链接（#card= 名片、#join= 邀请）：转到“共享”页处理，地址栏换回普通页面
  let incoming = $state<string | null>(null);
  if (/^#(card|join)=[A-Za-z0-9_-]+$/.test(location.hash)) {
    incoming = location.href;
    view = "shared";
    history.replaceState(null, "", location.pathname + location.search + "#/shared");
  }
  let sharing = $state<Photo[] | null>(null);
  startServiceWorker();

  // 解锁后把上次没推上去的共享相册列表再推一次
  $effect(() => {
    if (library.unlocked) shared.pushDirty();
  });
  // 第一次发现有加密内容时自动弹出解锁
  $effect(() => {
    if (library.needsUnlock && !library.unlocked && !unlockDismissed) showUnlock = true;
  });
  $effect(() => {
    if (uploads.needsUnlock) showUnlock = true;
  });

  const list = $derived.by((): Photo[] => {
    const all = library.photos;
    if (view === "videos") return all.filter((p) => p.item.m.startsWith("video/"));
    if (view === "albums" && album !== null) return all.filter((p) => (p.item.a || t("未命名")) === album);
    return all;
  });
  const title = $derived(
    view === "albums" && album !== null ? album : { photos: t("照片"), albums: t("相簿"), videos: t("视频"), shared: t("共享"), settings: t("设置") }[view],
  );
  const loading = $derived(library.accounts.some((a) => a.state === "loading"));
  const problems = $derived(library.accounts.filter((a) => a.state === "signin" || a.state === "error" || a.readOnly || a.migrating || a.lostUploads.length));

  function go(v: View) {
    view = v;
    album = null;
    drawer = false;
    selected.clear();
  }

  function toggle(i: number, shift: boolean) {
    const p = list[i];
    if (!p) return;
    if (shift && lastToggled >= 0) {
      const [a, b] = [Math.min(lastToggled, i), Math.max(lastToggled, i)];
      for (let k = a; k <= b; k++) selected.add(list[k]!.key);
    } else if (selected.has(p.key)) selected.delete(p.key);
    else selected.add(p.key);
    lastToggled = i;
  }

  function toggleDay(keys: string[]) {
    const all = keys.every((k) => selected.has(k));
    for (const k of keys) all ? selected.delete(k) : selected.add(k);
  }

  const selectedPhotos = () => list.filter((p) => selected.has(p.key));

  async function download(ps: Photo[]) {
    if (ps.some((p) => !p.acc.canOpen(p.item))) {
      showUnlock = true;
      return;
    }
    try {
      await downloadPhotos(ps, (d, n) => (toast = n > 1 ? t("正在下载 {d} / {n}", { d, n }) : t("正在下载…")));
      toast = "";
    } catch (e) {
      toast = t("下载失败：{msg}", { msg: (e as Error).message });
      setTimeout(() => (toast = ""), 5000);
    }
  }

  async function doDelete() {
    const ps = confirmDelete!;
    deleting = true;
    try {
      // 同一张照片在几个账号里的备份都删掉；按账号分批，每个账号只写一次目录
      const byAcc = new Map<typeof ps[0]["acc"], typeof ps[0]["item"][]>();
      for (const p of ps) for (const c of [{ acc: p.acc, item: p.item }, ...p.copies]) {
        if (!byAcc.has(c.acc)) byAcc.set(c.acc, []);
        byAcc.get(c.acc)!.push(c.item);
      }
      for (const [acc, items] of byAcc) await acc.remove(items);
      selected.clear();
      if (viewerIndex !== null && viewerIndex >= list.length) viewerIndex = list.length ? list.length - 1 : null;
      confirmDelete = null;
    } catch (e) {
      toast = t("删除失败：{msg}", { msg: (e as Error).message });
      setTimeout(() => (toast = ""), 6000);
      confirmDelete = null;
    } finally {
      deleting = false;
    }
  }

  function pickFiles(files: FileList | File[] | null | undefined) {
    const arr = Array.from(files ?? []);
    if (arr.length) pendingFiles = arr;
  }

  // ---- 闲置自动锁 ----
  let autoLock = $state(15);
  try {
    autoLock = Number(localStorage.getItem("zyll-autolock") ?? 15);
  } catch {
    /* ignore */
  }
  $effect(() => {
    try {
      localStorage.setItem("zyll-autolock", String(autoLock));
    } catch {
      /* ignore */
    }
  });
  let lastActive = Date.now();
  const touch = () => (lastActive = Date.now());
  function lockNow() {
    clearStreams();
    clearThumbs();
    viewerIndex = null;
    shared.forget();
    library.lock();
    unlockDismissed = true;
  }
  $effect(() => {
    const timer = setInterval(() => {
      if (library.unlocked && autoLock > 0 && !uploads.running && Date.now() - lastActive > autoLock * 60_000) lockNow();
    }, 30_000);
    return () => clearInterval(timer);
  });

  function beforeUnload(e: BeforeUnloadEvent) {
    if (uploads.running) e.preventDefault();
  }
</script>

<svelte:window onpointerdown={touch} onkeydown={touch} onbeforeunload={beforeUnload} onpopstate={onPop} />

{#if library.accounts.length === 0}
  <Welcome />
{:else}
  <div
    class="shell"
    role="application"
    ondragenter={(e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); dragging++; } }}
    ondragover={(e) => e.dataTransfer?.types.includes("Files") && e.preventDefault()}
    ondragleave={() => (dragging = Math.max(0, dragging - 1))}
    ondrop={(e) => { e.preventDefault(); dragging = 0; pickFiles(e.dataTransfer?.files); }}
  >
    <aside class="side" class:open={drawer}>
      <div class="brand"><img class="mark" src="./icon-192.png" alt="" width="30" height="30" /> {t("Zyll 相册")}</div>
      <nav>
        <button class:active={view === "photos"} onclick={() => go("photos")}><Icon name="photos" /> {t("照片")}</button>
        <button class:active={view === "albums"} onclick={() => go("albums")}><Icon name="albums" /> {t("相簿")}</button>
        <button class:active={view === "videos"} onclick={() => go("videos")}><Icon name="video" /> {t("视频")}</button>
        <button class:active={view === "shared"} onclick={() => go("shared")}><Icon name="shared" /> {t("共享")}</button>
        <hr />
        <button class:active={view === "settings"} onclick={() => go("settings")}><Icon name="settings" /> {t("设置")}</button>
      </nav>
      <div class="accounts muted">
        {#each library.accounts as a}<div>{a.label}</div>{/each}
      </div>
      <div class="foot"><SiteFooter /></div>
    </aside>
    {#if drawer}<button class="drawer-scrim" aria-label={t("关闭菜单")} onclick={() => (drawer = false)}></button>{/if}

    <main>
      <header class="top">
        {#if selected.size}
          <button class="icon-btn" onclick={() => selected.clear()} aria-label={t("取消选择")}><Icon name="close" /></button>
          <h1>{t("已选择 {n} 项", { n: selected.size })}</h1>
          <button class="btn" onclick={() => (sharing = selectedPhotos())}><Icon name="shared" size={18} /> {t("共享")}</button>
          <button class="btn" onclick={() => download(selectedPhotos())}><Icon name="download" size={18} /> {t("下载")}</button>
          <button class="btn danger" onclick={() => (confirmDelete = selectedPhotos())}><Icon name="trash" size={18} /> {t("删除")}</button>
        {:else}
          <button class="icon-btn menu" onclick={() => (drawer = true)} aria-label={t("菜单")}><Icon name="menu" /></button>
          {#if view === "albums" && album !== null}
            <button class="icon-btn" onclick={() => (album = null)} aria-label={t("返回")}><Icon name="back" /></button>
          {/if}
          <h1>{title}</h1>
          {#if loading}<span class="muted">{t("正在读取…")}</span>{/if}
          {#if library.hasVault}
            {#if library.unlocked}
              <button class="icon-btn" onclick={lockNow} title={t("锁上加密照片")} aria-label={t("锁上")}><Icon name="lock" /></button>
            {:else}
              <button class="btn" onclick={() => (showUnlock = true)}><Icon name="lock" size={18} /> {t("解锁")}</button>
            {/if}
          {/if}
          <button class="btn primary" onclick={() => fileInput?.click()}><Icon name="upload" size={18} /> {t("上传")}</button>
        {/if}
        <input bind:this={fileInput} type="file" multiple accept="image/*,video/*,.heic,.heif" hidden
          onchange={(e) => { pickFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
      </header>

      <div class="content">
        {#each problems as a (a.key)}
          <div class="notice">
            <Icon name="warn" />
            <span class="grow">
              {a.label}：{a.state === "signin" ? t("登录已过期") : a.state === "error" ? a.error : a.readOnly || (a.migrating ? t("手机正在搬迁存储位置，暂时不能在这里上传或删除照片") : t("这些照片在手机搬迁存储位置时丢了，请重新上传：{names}", { names: a.lostUploads.join(", ") }))}
            </span>
            {#if a.state === "signin"}<button class="btn" onclick={() => library.reconnect(a).catch((e) => (toast = e.message))}>{t("重新连接")}</button>{/if}
            {#if a.state === "error"}<button class="btn" onclick={() => a.load()}>{t("重试")}</button>{/if}
            {#if a.rolledBack}<button class="btn" onclick={() => go("settings")}>{t("去处理")}</button>{/if}
          </div>
        {/each}

        {#key view + "/" + (album ?? "")}
        <div class="view">
        {#if view === "settings"}
          <Settings bind:autoLock onlock={lockNow} onunlock={() => (showUnlock = true)} />
        {:else if view === "shared"}
          <Shared {incoming} onunlock={() => (showUnlock = true)} />
        {:else if view === "albums" && album === null}
          <Albums photos={library.photos} onopen={(name) => (album = name)} />
        {:else}
          <Timeline
            bind:this={wall}
            photos={list}
            {selected}
            onopen={(i) => (viewerIndex = i)}
            ontoggle={toggle}
            ontoggleday={toggleDay}
            empty={loading ? t("正在读取网盘里的备份…") : view === "videos" ? t("还没有视频") : t("还没有照片。点右上角“上传”，或把照片拖进这个窗口。")}
          />
        {/if}
        </div>
        {/key}
      </div>
    </main>

    {#if dragging}
      <div class="drop"><div><Icon name="upload" size={40} /><p>{t("松开即可上传")}</p></div></div>
    {/if}
  </div>
{/if}

{#if viewerIndex !== null}
  <Viewer
    photos={list}
    bind:index={viewerIndex}
    onclose={() => {
      const i = viewerIndex!;
      viewerIndex = null;
      wall?.reveal(i);
    }}
    ondelete={(p) => (confirmDelete = [p])}
    ondownload={(p) => download([p])}
  />
{/if}

{#if pendingFiles}
  <UploadDialog
    files={pendingFiles}
    defaultAlbum={view === "albums" && album ? album : ""}
    onclose={() => (pendingFiles = null)}
    onneedunlock={() => (showUnlock = true)}
  />
{/if}

{#if confirmDelete}
  <div class="scrim">
    <div class="dialog">
      <h2>{t("delete.title", { n: confirmDelete.length })}</h2>
      <p class="muted">{t("delete.body")}</p>
      <p class="notice">{t("delete.warn")}</p>
      <div class="actions">
        <button class="btn" disabled={deleting} onclick={() => (confirmDelete = null)}>{t("common.cancel")}</button>
        <button class="btn primary" disabled={deleting} onclick={doDelete}>{deleting ? t("delete.busy") : t("delete.ok")}</button>
      </div>
    </div>
  </div>
{/if}

{#if sharing}
  <ShareDialog
    photos={sharing}
    onclose={() => (sharing = null)}
    ondone={(_, msg) => { sharing = null; selected.clear(); toast = msg; go("shared"); }}
  />
{/if}

{#if showUnlock}
  <UnlockDialog onclose={() => { showUnlock = false; unlockDismissed = true; uploads.needsUnlock = false; }} />
{/if}

<UploadPanel />
{#if toast}<div class="toast">{toast}</div>{/if}
<AppBanner />

<style>
  .shell { display: grid; grid-template-columns: 248px 1fr; min-height: 100vh; }
  .side {
    position: sticky; top: 0; height: 100vh; height: 100dvh; padding: 14px 12px max(14px, env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 8px;
    background: var(--bg); border-right: 1px solid var(--border); z-index: 20; overflow-y: auto; overscroll-behavior: contain;
  }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 19px; font-weight: 600; padding: 6px 10px 14px; }
  .mark { width: 32px; height: 32px; display: block; }
  nav { display: flex; flex-direction: column; gap: 2px; }
  nav button {
    display: flex; align-items: center; gap: 14px; padding: 10px 14px; border: none; border-radius: 999px;
    background: none; text-align: left; font-size: 15px; transition: background-color 0.15s, color 0.15s;
  }
  nav button:hover { background: var(--surface-2); }
  nav button.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  hr { border: none; border-top: 1px solid var(--border); margin: 8px 6px; width: auto; }
  .foot { padding: 4px 12px 6px; }
  .accounts { margin-top: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
  .accounts div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  main { min-width: 0; }
  .top {
    position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 8px; padding: 10px 20px;
    background: var(--bg); box-shadow: 0 1px 0 var(--border);
  }
  .top h1 { flex: 1; margin: 0; font-size: 20px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu { display: none; }
  .content { padding: 4px 20px 80px; display: flex; flex-direction: column; gap: 12px; }
  .grow { flex: 1; }
  .drop {
    position: fixed; inset: 0; z-index: 60; background: color-mix(in srgb, var(--accent) 22%, transparent);
    display: grid; place-items: center; pointer-events: none; border: 3px dashed var(--accent);
  }
  .drop div { background: var(--surface); padding: 24px 36px; border-radius: 20px; text-align: center; color: var(--accent); display: flex; flex-direction: column; align-items: center; }
  .drop p { margin: 8px 0 0; font-weight: 500; }
  .view { display: flex; flex-direction: column; gap: 12px; animation: zy-rise 0.22s cubic-bezier(0.2, 0, 0, 1); }
  .toast { animation: zy-rise 0.2s cubic-bezier(0.2, 0, 0, 1);
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 70; background: var(--text); color: var(--bg);
    padding: 10px 18px; border-radius: 12px; font-size: 14px; box-shadow: var(--shadow); max-width: calc(100vw - 32px);
  }
  .drawer-scrim { display: none; }

  @media (max-width: 860px) {
    .shell { grid-template-columns: 1fr; }
    .side {
      position: fixed; left: 0; top: 0; width: 280px; transform: translateX(-100%); visibility: hidden; z-index: 50; gap: 4px; padding-top: 8px;
      transition: transform 0.26s cubic-bezier(0.2, 0, 0, 1), visibility 0s 0.26s; box-shadow: var(--shadow); background: var(--surface);
    }
    .side.open { transform: none; visibility: visible; transition: transform 0.26s cubic-bezier(0.2, 0, 0, 1); }
    .brand { padding: 6px 10px 8px; }
    nav button { padding: 9px 14px; }
    .drawer-scrim { display: block; position: fixed; inset: 0; z-index: 45; background: rgba(0, 0, 0, 0.35); border: none; animation: zy-fade 0.2s; }
    .menu { display: inline-grid; }
    .top { padding: 8px 12px; }
    .content { padding: 4px 4px 80px; }
    .top :global(.btn) { padding: 8px 12px; }
  }
  @media (max-width: 480px) {
    .top h1 { font-size: 18px; }
  }
</style>
