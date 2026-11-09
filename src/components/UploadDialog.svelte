<script lang="ts">
  import { Locked, library, type Account } from "../lib/library.svelte";
  import { passwordProblem } from "../lib/password";
  import { uploads } from "../lib/uploads.svelte";
  import { fmtSize } from "../lib/media";
  import { t } from "../lib/i18n";

  let { files, defaultAlbum = "", onclose, onneedunlock }: {
    files: File[];
    defaultAlbum?: string;
    onclose: () => void;
    onneedunlock: () => void;
  } = $props();

  const writable = $derived(library.accounts.filter((a) => a.state === "ready" && !a.readOnly && !a.migrating));
  let target = $state<Account | null>(null);
  $effect(() => {
    if (!target || !writable.includes(target)) target = writable[0] ?? null;
  });
  let album = $state(defaultAlbum || t("网页上传"));
  const albums = $derived([...new Set(library.photos.map((p) => p.item.a).filter(Boolean))].sort());
  const size = $derived(files.reduce((s, f) => s + f.size, 0));
  let note = $state("");

  // 第一次往这个网盘传：先选要不要加密、放在哪里
  const fresh = $derived(!!target?.isFresh);
  const reuse = $derived(target ? library.unlockedVaultAccount(target) : null);
  const lockedVault = $derived(!reuse && library.accounts.some((a) => a !== target && a.bundleJson));
  let enc = $state(true);
  let pw = $state("");
  let pw2 = $state("");
  let visible = $state(false);
  let busy = $state(false);
  let recovery = $state<string | null>(null);
  let saved = $state(false);
  let copied = $state(false);

  async function start() {
    if (!target) return;
    if (fresh) {
      if (enc && lockedVault) {
        onneedunlock();
        return;
      }
      if (enc && !reuse) {
        const bad = passwordProblem(pw);
        if (bad) {
          note = t(bad.key, bad.vars);
          return;
        }
        if (pw !== pw2) {
          note = t("两次输入的密码不一样。");
          return;
        }
      }
      busy = true;
      note = "";
      try {
        recovery = await library.setupAccount(target, {
          password: enc && !reuse ? pw : undefined,
          reuse: enc && !!reuse,
          visible: target.stored.kind === "google" && visible,
        });
      } catch (e) {
        if (e instanceof Locked) onneedunlock();
        else note = (e as Error).message;
        return;
      } finally {
        busy = false;
      }
      pw = pw2 = "";
      if (recovery) return; // 先让用户抄恢复密钥
    }
    begin();
  }

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(recovery!);
      copied = true;
    } catch {
      copied = false;
    }
  }

  function begin() {
    if (!target) return;
    if (target.uploadEncrypted && !target.wrapKey()) {
      onneedunlock();
      return;
    }
    const ignored = uploads.add(files, target, album.trim() || t("网页上传"));
    if (ignored === files.length) {
      note = uploads.running ? t("正在往另一个账号上传，等它传完再试") : t("选中的文件里没有照片或视频");
      return;
    }
    onclose();
  }
</script>

<div class="scrim">
  <div class="dialog">
    {#if recovery}
      <h2>{t("抄下恢复密钥")}</h2>
      <p>{t("忘了密码时，只能用这个恢复密钥打开加密的照片。请抄在纸上或存进密码管理器，Zyll 不会再显示它。")}</p>
      <div class="key">{recovery}</div>
      <button class="btn text" style="align-self: flex-start" onclick={copyKey}>{copied ? t("已复制") : t("复制")}</button>
      <label class="check"><input type="checkbox" bind:checked={saved} /> {t("我已经保存好了")}</label>
      <div class="actions">
        <button class="btn primary" disabled={!saved} onclick={begin}>{t("开始上传")}</button>
      </div>
    {:else}
    <h2>{t("上传 {n} 个文件", { n: files.length })}</h2>
    <p class="muted">{t("共 {size}。和网盘里内容相同的照片会自动跳过。只传到选中的这一个账号，手机上设的“每种网盘各一份”对网页上传不生效。", { size: fmtSize(size) })}</p>
    {#if writable.length === 0}
      <p class="error">{t("没有可以上传的网盘账号（未连接、需要续期或只读）。")}</p>
    {:else}
      {#if writable.length > 1}
        <label class="field">{t("上传到")}
          <select bind:value={target} disabled={busy}>
            {#each writable as a}<option value={a}>{a.label}</option>{/each}
          </select>
        </label>
      {/if}
      <label class="field">{t("放进相簿")}
        <input type="text" bind:value={album} list="album-list" />
        <datalist id="album-list">{#each albums as a}<option value={a}></option>{/each}</datalist>
      </label>
      {#if target && fresh}
        <div class="setup">
          <p class="muted">{t("第一次往这个网盘上传，先选两件事：")}</p>
          <label class="check"><input type="checkbox" bind:checked={enc} disabled={busy} /> <strong>{t("端到端加密（推荐）")}</strong></label>
          <p class="muted">{t("照片在浏览器里加密后再上传，除了你自己谁都看不到。换设备时要用密码或恢复密钥解开，两样都丢了就再也打不开。")}</p>
          {#if enc}
            {#if reuse}
              <p class="muted">{t("沿用你其他网盘的加密密码（{name}）。", { name: reuse.label })}</p>
            {:else if lockedVault}
              <p class="notice">{t("你的其他网盘开着加密，请先解锁，这个网盘会沿用同一套密码。")}</p>
            {:else}
              <label class="field">{t("设置加密密码")}<input type="password" bind:value={pw} autocomplete="new-password" disabled={busy} /></label>
              <label class="field">{t("再输一次")}<input type="password" bind:value={pw2} autocomplete="new-password" disabled={busy} /></label>
              <p class="muted">{t("至少 10 位，要同时有字母和数字，不能用常见的弱密码。请牢记。")}</p>
            {/if}
          {/if}
          {#if target.stored.kind === "google"}
            <div class="field">{t("存放位置")}
              <label class="check"><input type="radio" name="where" value={false} bind:group={visible} disabled={busy} /> {t("隐藏区（只有 Zyll 能看到，不能共享）")}</label>
              <label class="check"><input type="radio" name="where" value={true} bind:group={visible} disabled={busy} /> {t("可见的“Zyll 相册”文件夹（以后可以共享相册）")}</label>
            </div>
            {#if visible && !enc}<p class="muted">{t("共享相册只能共享加密的照片。")}</p>{/if}
          {/if}
        </div>
      {:else if target}
        <p class="muted">{target.uploadEncrypted ? t("这个账号开着端到端加密：照片在浏览器里加密后再上传。") : t("这个账号没开端到端加密：照片按原样上传。想加密，请先在手机 Zyll 里给这个网盘开启加密。")}</p>
      {/if}
    {/if}
    {#if note}<p class="error">{note}</p>{/if}
    <div class="actions">
      <button class="btn" onclick={onclose} disabled={busy}>{t("取消")}</button>
      <button class="btn primary" disabled={!target || busy} onclick={start}>{busy ? t("正在设置…") : t("开始上传")}</button>
    </div>
    {/if}
  </div>
</div>

<style>
  .setup { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 14px; }
  .setup p { margin: 0; }
  .check { display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .key { font: 15px/1.6 ui-monospace, monospace; word-break: break-all; user-select: all; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
</style>
