<script lang="ts">
  import Icon from "./Icon.svelte";
  import SharedAlbum from "./SharedAlbum.svelte";
  import EncryptSetup from "./EncryptSetup.svelte";
  import { t } from "../lib/i18n";
  import { library, type Account } from "../lib/library.svelte";
  import { parseCard, parseInvite, problemText, shared, type ShareCard } from "../lib/sharing.svelte";

  let { incoming = null, onunlock }: { incoming?: string | null; onunlock: () => void } = $props();

  /** 能用共享的账号（加载好了、开着加密、网盘支持）。 */
  const accounts = $derived(library.accounts.filter((a) => a.state === "ready"));
  const usable = $derived(accounts.filter((a) => !shared.problem(a)));
  const problems = $derived(accounts.filter((a) => shared.problem(a)).map((a) => ({ a, p: shared.problem(a) })));
  /** 能接收共享（发名片、加入）的账号：只要库开着加密并且已解锁。 */
  const receivers = $derived(accounts.filter((a) => !shared.joinProblem(a)));
  let encrypting = $state<Account | null>(null);
  let connectErr = $state("");
  async function connectOneDrive() {
    connectErr = "";
    try {
      await library.connect("onedrive");
    } catch (e) {
      connectErr = (e as Error).message;
    }
  }

  let open = $state<string | null>(null);
  let syncErrors = $state<string[]>([]);
  let syncing = $state(false);
  let lastSync = "";
  $effect(() => {
    // 解锁、连上新账号后再同步一次列表
    const sig = usable.map((a) => a.key).join(",");
    if (!sig || sig === lastSync) return;
    lastSync = sig;
    syncing = true;
    shared.sync().then((e) => (syncErrors = e)).finally(() => (syncing = false));
  });

  // ---------- 我的名片 ----------
  let cardFor = $state<Account | null>(null);
  let card = $state<{ link: string; code: string } | null>(null);
  let cardErr = $state("");
  let copied = $state(false);
  async function showCard(a: Account) {
    cardFor = a;
    card = null;
    cardErr = "";
    copied = false;
    try {
      card = await shared.myCard(a);
    } catch (e) {
      cardErr = (e as Error).message;
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = false;
    }
  }

  // ---------- 别人发来的链接 ----------
  let joinText = $state("");
  let joinAcc = $state<Account | null>(null);
  let joining = $state(false);
  let joinErr = $state("");
  let incomingCard = $state<ShareCard | null>(null);
  $effect(() => {
    if (!incoming) return;
    if (parseInvite(incoming)) joinText = incoming;
    else parseCard(incoming).then((c) => (incomingCard = c));
  });
  const invite = $derived(parseInvite(joinText));
  const joinChoices = $derived(invite ? receivers.filter((a) => a.stored.kind === invite.provider) : []);
  /** 同一家网盘、还不能用来加入的账号（没开加密、没解锁）。 */
  const joinBlocked = $derived(invite ? accounts.filter((a) => a.stored.kind === invite.provider && shared.joinProblem(a)) : []);
  $effect(() => {
    if (!joinAcc || !joinChoices.includes(joinAcc)) joinAcc = joinChoices[0] ?? null;
  });
  async function join() {
    if (!invite || !joinAcc) return;
    joining = true;
    joinErr = "";
    try {
      const ref = await shared.join(joinAcc, invite);
      joinText = "";
      open = ref.albumId;
    } catch (e) {
      joinErr = (e as Error).message;
    } finally {
      joining = false;
    }
  }

  const albums = $derived([...shared.albums].sort((a, b) => b.addedAt - a.addedAt));
  const accLabel = (key: string) => library.accounts.find((a) => a.key === key)?.label ?? "";
  const roleText = (r: string | null) => (r === null ? t("主人") : r === "manager" ? t("可管理") : r === "contributor" ? t("可添加") : t("仅查看"));
</script>

{#if open}
  <SharedAlbum albumId={open} card={incomingCard} onback={() => (open = null)} oninvited={() => (incomingCard = null)} />
{:else}
  <div class="page">
    {#if library.hasVault && !library.unlocked}
      <div class="notice"><Icon name="lock" /><span class="grow">{t("共享相册是加密的，请先解锁。")}</span><button class="btn" onclick={onunlock}>{t("解锁")}</button></div>
    {/if}
    {#each problems as { a, p } (a.key)}
      {#if p !== "locked"}<p class="muted small">{a.label}：{problemText(p)}</p>{/if}
    {/each}
    {#each syncErrors as e}<p class="error small">{e}</p>{/each}

    {#if incomingCard}
      <div class="box">
        <h3>{t("收到一张分享名片")}</h3>
        <p>{t("{email} 想接收你的共享相册。打开你要分享的相册，点“邀请成员”就会用这张名片。", { email: incomingCard.email })}</p>
        <p class="muted">{t("请先和对方当面或打电话核对安全码：")} <code>{incomingCard.member.code}</code></p>
        <button class="btn text" onclick={() => (incomingCard = null)}>{t("忽略")}</button>
      </div>
    {/if}

    <section>
      <div class="row head">
        <h3 class="grow">{t("共享相册列表")}</h3>
        {#if syncing}<span class="muted small">{t("正在同步…")}</span>{/if}
      </div>
      {#if albums.length === 0}
        <p class="muted">{t("还没有共享相册。在照片里选中几张，点“共享”就能建一个；别人邀请你时，把对方发来的链接粘贴到下面。")}</p>
      {:else}
        <div class="list">
          {#each albums as a (a.albumId)}
            <button class="album" onclick={() => (open = a.albumId)}>
              <Icon name="shared" />
              <span class="grow">
                <strong>{a.name || t("共享相册")}</strong>
                <span class="muted small">{t("{n} 项", { n: a.count })} · {roleText(a.myRole)}{a.myRole !== null && a.ownerEmail ? ` · ${a.ownerEmail}` : ""}</span>
              </span>
              {#if library.accounts.length > 1}<span class="muted small">{accLabel(a.acc)}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <section>
      <h3>{t("加入别人的共享相册")}</h3>
      <div class="row">
        <input type="text" class="grow" placeholder={t("粘贴对方发来的加入链接")} bind:value={joinText} disabled={joining} />
      </div>
      {#if joinText && !invite}<p class="error small">{t("这不是 Zyll 的加入链接。")}</p>{/if}
      {#if invite}
        <p>{t("{owner} 邀请你加入“{name}”。", { owner: invite.owner || t("对方"), name: invite.name || t("共享相册") })}</p>
        <p class="muted small">{t("主人的安全码：")}<code>{invite.code}</code>{t("（请和对方核对）")}</p>
        {#if invite.provider === "google"}
          <p class="notice small">{t("Google 账号暂时只能在手机 Zyll 里加入共享相册，网页版还不能接收。请在手机上打开这个链接。")}</p>
        {:else}
          {#each joinBlocked as a (a.key)}
            <div class="row wrap">
              <span class="muted small grow">{a.label}：{shared.joinProblem(a) === "locked" ? t("请先解锁加密的照片。") : a.isFresh ? t("还没开端到端加密，开启后才能加入。") : t("这个 OneDrive 没开端到端加密，请先在手机 Zyll 里开启加密。")}</span>
              {#if shared.joinProblem(a) === "locked"}<button class="btn" onclick={onunlock}>{t("解锁")}</button>
              {:else if a.isFresh}<button class="btn" onclick={() => (encrypting = a)}>{t("开启加密")}</button>{/if}
            </div>
          {/each}
          {#if !accounts.some((a) => a.stored.kind === "onedrive")}
            <div class="row wrap">
              <span class="muted small grow">{t("要加入这个相册，请先连接你的 OneDrive 账号。")}</span>
              <button class="btn" onclick={connectOneDrive}>{t("连接 OneDrive")}</button>
            </div>
            {#if connectErr}<p class="error small">{connectErr}</p>{/if}
          {/if}
          {#if joinChoices.length}
            <div class="row">
              {#if joinChoices.length > 1}
                <select bind:value={joinAcc} disabled={joining}>{#each joinChoices as a}<option value={a}>{a.label}</option>{/each}</select>
              {/if}
              <button class="btn primary" onclick={join} disabled={joining || !joinAcc}>{joining ? t("正在加入…") : t("加入")}</button>
            </div>
          {/if}
        {/if}
        {#if joinErr}<p class="error small">{joinErr}</p>{/if}
      {/if}
    </section>

    <section>
      <h3>{t("我的分享名片")}</h3>
      <p class="muted small">{t("想让别人把相册共享给你，就把名片链接发给对方。名片里只有公钥，没有任何密钥。")}</p>
      {#if receivers.length === 0}
        <p class="muted small">{t("需要一个开着端到端加密、已经解锁的网盘账号。")}</p>
      {:else}
        <div class="row wrap">
          {#each receivers as a (a.key)}<button class="btn" onclick={() => showCard(a)}>{a.label}</button>{/each}
        </div>
      {/if}
    </section>
  </div>
{/if}

{#if encrypting}
  <EncryptSetup acc={encrypting} onclose={() => (encrypting = null)} ondone={() => (encrypting = null)} />
{/if}

{#if cardFor}
  <div class="scrim">
    <div class="dialog">
      <h2>{t("我的分享名片")}</h2>
      <p class="muted">{cardFor.label}</p>
      {#if cardErr}
        <p class="error">{cardErr}</p>
      {:else if !card}
        <p class="muted">{t("正在准备…")}</p>
      {:else}
        <p>{t("把这个链接发给要共享相册给你的人：")}</p>
        <div class="link">{card.link}</div>
        <p>{t("安全码：")}<code>{card.code}</code></p>
        <p class="muted small">{t("请和对方当面或打电话核对安全码，防止链接在传递中被人调包。")}</p>
        {#if copied}<p class="muted small">{t("已复制")}</p>{/if}
      {/if}
      <div class="actions">
        <button class="btn" onclick={() => (cardFor = null)}>{t("关闭")}</button>
        {#if card}<button class="btn primary" onclick={() => copy(card!.link)}>{t("复制链接")}</button>{/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .page { display: flex; flex-direction: column; gap: 24px; max-width: 760px; }
  section { display: flex; flex-direction: column; gap: 8px; }
  h3 { margin: 0; font-size: 16px; font-weight: 600; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row.wrap { flex-wrap: wrap; }
  .grow { flex: 1; min-width: 0; }
  .small { font-size: 13px; margin: 0; }
  p { margin: 0; }
  select { width: auto; }
  input[type="text"], select { font: inherit; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg); color: inherit; }
  .box { border: 1px solid var(--border); border-radius: 14px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
  .list { display: flex; flex-direction: column; gap: 4px; }
  .album { all: unset; cursor: pointer; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 12px; }
  .album:hover, .album:focus-visible { background: var(--hover, rgba(127, 127, 127, 0.1)); }
  .album .grow { display: flex; flex-direction: column; gap: 2px; }
  code { font: 14px ui-monospace, monospace; letter-spacing: 0.04em; }
  .link { font: 13px/1.5 ui-monospace, monospace; word-break: break-all; user-select: all; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; max-height: 120px; overflow: auto; }
</style>
