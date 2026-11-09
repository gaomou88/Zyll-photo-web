<script lang="ts">
  import Icon from "./Icon.svelte";
  import { t } from "../lib/i18n";
  import { fmtTime, saveBlob } from "../lib/media";
  import { whenNear } from "../lib/thumbs";
  import { ROLES, parseCard, shared, type Member, type ShareCard, type ShareRole, type SharedItem } from "../lib/sharing.svelte";

  let { albumId, card = null, onback, oninvited }: { albumId: string; card?: ShareCard | null; onback: () => void; oninvited: () => void } = $props();

  const ref = $derived(shared.albums.find((a) => a.albumId === albumId) ?? null);
  let data = $state<{ items: SharedItem[]; owner: Member; members: Member[]; canManage: boolean; originals: boolean } | null>(null);
  let err = $state("");
  let busy = $state(false);
  let note = $state("");

  async function reload() {
    err = "";
    try {
      data = await shared.open(albumId);
    } catch (e) {
      err = (e as Error).message;
    }
  }
  reload();

  const items = $derived([...(data?.items ?? [])].sort((a, b) => b.t - a.t));
  const roleText = (r: ShareRole | null) => (r === null ? t("主人") : r === "manager" ? t("可管理") : r === "contributor" ? t("可添加") : t("仅查看"));

  async function run(job: () => Promise<unknown>, done = "") {
    busy = true;
    note = "";
    try {
      await job();
      note = done;
      await reload();
    } catch (e) {
      note = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  // ---------- 缩略图 ----------
  const thumbs = $state<Record<string, string>>({});
  const failed = $state<Record<string, boolean>>({});
  function lazy(el: HTMLElement, it: SharedItem) {
    const stop = whenNear(el, () => {
      shared.file(albumId, it, false).then(
        (b) => (b ? (thumbs[it.r] = URL.createObjectURL(b)) : (failed[it.r] = true)),
        () => (failed[it.r] = true),
      );
    });
    return { destroy: stop };
  }
  $effect(() => () => {
    for (const u of Object.values(thumbs)) URL.revokeObjectURL(u);
  });

  // ---------- 查看大图 ----------
  let viewing = $state<SharedItem | null>(null);
  let full = $state<{ url: string; blob: Blob } | null>(null);
  let fullErr = $state("");
  async function view(it: SharedItem) {
    viewing = it;
    full = null;
    fullErr = "";
    try {
      const b = await shared.file(albumId, it, true);
      if (viewing !== it) return;
      if (!b) fullErr = t("主人只共享了预览图，不能看原图。");
      else full = { url: URL.createObjectURL(b), blob: b };
    } catch (e) {
      fullErr = (e as Error).message;
    }
  }
  const pos = $derived(viewing ? items.indexOf(viewing) : -1);
  function step(d: number) {
    const it = items[pos + d];
    if (!it) return;
    if (full) URL.revokeObjectURL(full.url);
    view(it);
  }
  function onKey(e: KeyboardEvent) {
    if (!viewing || confirmDelete) return;
    if (e.key === "Escape") closeView();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  }
  function closeView() {
    if (full) URL.revokeObjectURL(full.url);
    full = null;
    viewing = null;
  }

  // ---------- 邀请 ----------
  let inviting = $state(false);
  let cardText = $state("");
  let parsed = $state<ShareCard | null>(null);
  let role = $state<ShareRole>("viewer");
  let checked = $state(false);
  let link = $state("");
  let copied = $state(false);
  $effect(() => {
    if (card && !cardText) {
      inviting = true;
      parsed = card;
    }
  });
  $effect(() => {
    const text = cardText;
    if (!text) return;
    parseCard(text).then((c) => {
      parsed = c;
      checked = false;
    });
  });
  async function invite() {
    if (!parsed) return;
    await run(async () => {
      link = await shared.invite(albumId, parsed!, role);
      oninvited();
    });
  }
  async function copy(s: string) {
    try {
      await navigator.clipboard.writeText(s);
      copied = true;
    } catch {
      copied = false;
    }
  }
  function closeInvite() {
    inviting = false;
    cardText = "";
    parsed = null;
    checked = false;
    link = "";
    copied = false;
  }

  /** 改权限；失败时下拉框退回原来的值。 */
  async function setRole(m: Member, el: HTMLSelectElement) {
    const old = m.role ?? "viewer";
    busy = true;
    note = "";
    try {
      await shared.setRole(albumId, m.fpHex, el.value as ShareRole);
      await reload();
    } catch (e) {
      el.value = old;
      note = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  let confirmRemove = $state<Member | null>(null);
  let confirmLeave = $state(false);
  let confirmDelete = $state<SharedItem | null>(null);
  let confirmStop = $state(false);
</script>

<div class="page">
  <div class="row head">
    <button class="icon-btn" onclick={onback} aria-label={t("返回")}><Icon name="back" /></button>
    <h2 class="grow">{ref?.name || t("共享相册")}</h2>
    {#if data?.canManage}<button class="btn primary" onclick={() => (inviting = true)} disabled={busy}>{t("邀请成员")}</button>{/if}
  </div>
  {#if err}<p class="error">{err}</p>{/if}
  {#if note}<p class="muted">{note}</p>{/if}

  {#if data}
    {#if !data.originals}<p class="muted small">{t("这个相册只共享预览图，不能下载原图。")}</p>{/if}
    {#if items.length === 0}
      <p class="muted">{t("相册里还没有照片。")}</p>
    {:else}
      <div class="grid">
        {#each items as it (it.r)}
          <button class="tile" use:lazy={it} onclick={() => view(it)} aria-label={it.n}>
            {#if thumbs[it.r]}<img src={thumbs[it.r]} alt="" />{:else if failed[it.r]}<Icon name={it.m.startsWith("video/") ? "video" : "photos"} />{/if}
            {#if it.m.startsWith("video/")}<span class="badge"><Icon name="play" size={14} /></span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    <section>
      <h3>{t("成员")}</h3>
      <div class="member">
        <span class="grow"><strong>{data.owner.email}</strong><span class="muted small">{t("安全码")} {data.owner.code}</span></span>
        <span class="muted small">{t("主人")}</span>
      </div>
      {#each data.members as m (m.fpHex)}
        <div class="member">
          <span class="grow"><strong>{m.email}</strong><span class="muted small">{t("安全码")} {m.code}</span></span>
          {#if data.canManage}
            <select value={m.role} disabled={busy} onchange={(e) => setRole(m, e.target as HTMLSelectElement)}>
              {#each ROLES as r}<option value={r}>{roleText(r)}</option>{/each}
            </select>
            <button class="btn text" disabled={busy} onclick={() => (confirmRemove = m)}>{t("移除")}</button>
          {:else}
            <span class="muted small">{roleText(m.role)}</span>
          {/if}
        </div>
      {/each}
      {#if data.members.length === 0}<p class="muted small">{t("还没有邀请别人。")}</p>{/if}
    </section>

    <div class="row wrap">
      {#if data.canManage && ref}<button class="btn" disabled={busy} onclick={() => copy(shared.joinLink(albumId))}>{t("复制加入链接")}</button>{/if}
      {#if ref?.myRole === null}
        <button class="btn danger" disabled={busy} onclick={() => (confirmStop = true)}>{t("停止共享")}</button>
      {:else}
        <button class="btn" disabled={busy} onclick={() => (confirmLeave = true)}>{t("退出这个相册")}</button>
      {/if}
      {#if copied && !inviting}<span class="muted small">{t("已复制")}</span>{/if}
    </div>
  {:else if !err}
    <p class="muted">{t("正在读取…")}</p>
  {/if}
</div>

<svelte:window onkeydown={onKey} />

{#if viewing}
  <div class="viewer">
    <div class="bar">
      <button class="icon-btn" onclick={closeView} aria-label={t("关闭")}><Icon name="close" /></button>
      <span class="grow">{viewing.n} · {fmtTime(viewing.t)}</span>
      {#if full}<button class="btn" onclick={() => saveBlob(full!.blob, viewing!.n)}><Icon name="download" size={18} /> {t("下载")}</button>{/if}
      {#if data?.canManage}<button class="icon-btn" onclick={() => (confirmDelete = viewing)} aria-label={t("删除")} title={t("删除")}><Icon name="trash" /></button>{/if}
    </div>
    {#if pos > 0}<button class="nav prev" onclick={() => step(-1)} aria-label={t("上一张")}><Icon name="back" /></button>{/if}
    {#if pos >= 0 && pos < items.length - 1}<button class="nav next" onclick={() => step(1)} aria-label={t("下一张")}><Icon name="back" /></button>{/if}
    <div class="stage">
      {#if full}
        {#if viewing.m.startsWith("video/")}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video src={full.url} controls autoplay playsinline></video>
        {:else}
          <img src={full.url} alt={viewing.n} />
        {/if}
      {:else if fullErr}
        {#if thumbs[viewing.r]}<img src={thumbs[viewing.r]} alt={viewing.n} />{/if}
        <p class="muted">{fullErr}</p>
      {:else}
        {#if thumbs[viewing.r]}<img src={thumbs[viewing.r]} alt={viewing.n} />{/if}
        <p class="muted">{t("正在下载…")}</p>
      {/if}
    </div>
  </div>
{/if}

{#if inviting}
  <div class="scrim">
    <div class="dialog">
      <h2>{t("邀请到“{name}”", { name: ref?.name ?? "" })}</h2>
      {#if link}
        <p>{t("已经邀请。把这个加入链接发给对方：")}</p>
        <div class="link">{link}</div>
        {#if copied}<p class="muted small">{t("已复制")}</p>{/if}
        <div class="actions">
          <button class="btn" onclick={closeInvite}>{t("完成")}</button>
          <button class="btn primary" onclick={() => copy(link)}>{t("复制链接")}</button>
        </div>
      {:else}
        <label class="field">{t("对方的分享名片链接")}
          <input type="text" bind:value={cardText} placeholder={card ? t("已使用收到的名片") : ""} disabled={busy} />
        </label>
        {#if cardText && !parsed}<p class="error small">{t("这不是 Zyll 的分享名片。")}</p>{/if}
        {#if parsed}
          <p>{parsed.email}</p>
          <p class="muted small">{t("安全码：")}<code>{parsed.member.code}</code>{t("（请和对方当面或打电话核对）")}</p>
          <label class="check"><input type="checkbox" bind:checked disabled={busy} /> {t("我已经和对方核对过安全码")}</label>
        {/if}
        <label class="field">{t("权限")}
          <select bind:value={role} disabled={busy}>{#each ROLES as r}<option value={r}>{roleText(r)}</option>{/each}</select>
        </label>
        <p class="muted small">{role === "viewer" ? t("只能浏览和下载。") : role === "contributor" ? t("以后还能往相册里添加照片（即将支持）。") : t("还能删照片、邀请和移除成员、改权限。")}</p>
        {#if note}<p class="error small">{note}</p>{/if}
        <div class="actions">
          <button class="btn" onclick={closeInvite} disabled={busy}>{t("取消")}</button>
          <button class="btn primary" onclick={invite} disabled={busy || !parsed || !checked}>{busy ? t("正在邀请…") : t("邀请")}</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

{#if confirmRemove}
  <div class="scrim">
    <div class="dialog">
      <h2>{t("移除 {email}？", { email: confirmRemove.email })}</h2>
      <p>{t("会撤掉对方的网盘权限，并换一把新的相册钥匙，对方以后看不到新加的照片。对方已经下载过的照片收不回来。")}</p>
      <div class="actions">
        <button class="btn" onclick={() => (confirmRemove = null)}>{t("取消")}</button>
        <button class="btn danger" onclick={() => { const m = confirmRemove!; confirmRemove = null; run(() => shared.removeMember(albumId, m.fpHex), t("已移除")); }}>{t("移除")}</button>
      </div>
    </div>
  </div>
{/if}

{#if confirmLeave}
  <div class="scrim">
    <div class="dialog">
      <h2>{t("退出这个相册？")}</h2>
      <p>{t("相册会从你的列表里去掉。以后要再加入，需要对方重新发链接。")}</p>
      <div class="actions">
        <button class="btn" onclick={() => (confirmLeave = false)}>{t("取消")}</button>
        <button class="btn danger" onclick={() => { confirmLeave = false; shared.leave(albumId); onback(); }}>{t("退出")}</button>
      </div>
    </div>
  </div>
{/if}

{#if confirmDelete}
  <div class="scrim">
    <div class="dialog">
      <h2>{t("从共享相册里删掉这张？")}</h2>
      <p>{t("成员以后看不到它。照片本身还留在原来的备份里；别人已经下载过的收不回来。")}</p>
      <div class="actions">
        <button class="btn" onclick={() => (confirmDelete = null)}>{t("取消")}</button>
        <button class="btn danger" onclick={() => { const it = confirmDelete!; confirmDelete = null; closeView(); run(() => shared.removePhotos(albumId, [it.r]), t("已从共享相册删掉")); }}>{t("删除")}</button>
      </div>
    </div>
  </div>
{/if}

{#if confirmStop}
  <div class="scrim">
    <div class="dialog">
      <h2>{t("停止共享？")}</h2>
      <p>{t("会撤掉所有成员的权限并删掉共享文件夹，照片本身还留在你的备份里。别人已经下载过的照片收不回来。")}</p>
      <div class="actions">
        <button class="btn" onclick={() => (confirmStop = false)}>{t("取消")}</button>
        <button class="btn danger" onclick={() => { confirmStop = false; run(() => shared.stopSharing(albumId)).then(() => { if (!shared.albums.some((a) => a.albumId === albumId)) onback(); }); }}>{t("停止共享")}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page { display: flex; flex-direction: column; gap: 16px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row.wrap { flex-wrap: wrap; }
  .head h2 { margin: 0; font-size: 20px; }
  .grow { flex: 1; min-width: 0; }
  h3 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
  p { margin: 0; }
  .small { font-size: 13px; }
  section { display: flex; flex-direction: column; gap: 6px; }
  select, input[type="text"] { font: inherit; padding: 6px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg); color: inherit; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 4px; }
  @media (max-width: 600px) { .grid { grid-template-columns: repeat(3, 1fr); gap: 2px; } }
  .tile { all: unset; cursor: pointer; position: relative; aspect-ratio: 1; background: var(--tile-bg); display: grid; place-items: center; overflow: hidden; border-radius: 4px; }
  .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tile:focus-visible { outline: 3px solid var(--accent); }
  .badge { position: absolute; right: 6px; top: 6px; color: #fff; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6)); }
  .check { display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .member { display: flex; align-items: center; gap: 10px; padding: 6px 0; flex-wrap: wrap; }
  .member .grow { display: flex; flex-direction: column; flex: 1 1 200px; overflow-wrap: anywhere; }
  .member select { width: auto; flex: none; }
  code { font: 14px ui-monospace, monospace; }
  .link { font: 13px/1.5 ui-monospace, monospace; word-break: break-all; user-select: all; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; max-height: 120px; overflow: auto; }
  .viewer { position: fixed; inset: 0; z-index: 50; background: #000; color: #fff; display: flex; flex-direction: column; }
  .viewer .bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
  .viewer .icon-btn { color: #fff; }
  .nav { all: unset; cursor: pointer; position: absolute; top: 50%; z-index: 2; width: 44px; height: 44px; margin-top: -22px; display: grid; place-items: center; border-radius: 50%; background: rgba(255, 255, 255, 0.15); color: #fff; }
  .nav:hover, .nav:focus-visible { background: rgba(255, 255, 255, 0.3); }
  .nav.prev { left: 12px; }
  .nav.next { right: 12px; transform: scaleX(-1); }
  .stage { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
  .stage img, .stage video { max-width: 100%; max-height: 100%; object-fit: contain; }
</style>
