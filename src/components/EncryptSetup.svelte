<script lang="ts">
  import { library, type Account, type NewVault } from "../lib/library.svelte";
  import { passwordProblem } from "../lib/password";
  import { t } from "../lib/i18n";

  /** 给一个全新的网盘账号开启端到端加密（和首次上传的设置一样：先抄恢复密钥，确认后才写网盘）。 */
  let { acc, onclose, ondone }: { acc: Account; onclose: () => void; ondone: () => void } = $props();

  let pw = $state("");
  let pw2 = $state("");
  let busy = $state(false);
  let note = $state("");
  let vault = $state<NewVault | null>(null);
  let saved = $state(false);
  let copied = $state(false);

  async function next() {
    const bad = passwordProblem(pw);
    if (bad) return void (note = t(bad.key, bad.vars));
    if (pw !== pw2) return void (note = t("两次输入的密码不一样。"));
    busy = true;
    note = "";
    try {
      vault = await library.createVault(pw);
      pw = pw2 = "";
    } catch (e) {
      note = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function finish() {
    busy = true;
    note = "";
    try {
      await library.setupAccount(acc, { fresh: vault!, visible: false });
      vault = null;
      ondone();
    } catch (e) {
      note = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(vault!.recoveryKey);
      copied = true;
    } catch {
      copied = false;
    }
  }
</script>

<div class="scrim">
  <div class="dialog">
    {#if vault}
      <h2>{t("抄下恢复密钥")}</h2>
      <p>{t("忘了密码时，只能用这个恢复密钥打开加密的照片。请抄在纸上或存进密码管理器，Zyll 不会再显示它。")}</p>
      <div class="key">{vault.recoveryKey}</div>
      <button class="btn text" style="align-self: flex-start" onclick={copyKey}>{copied ? t("已复制") : t("复制")}</button>
      <label class="check"><input type="checkbox" bind:checked={saved} disabled={busy} /> {t("我已经保存好了")}</label>
      {#if note}<p class="error">{note}</p>{/if}
      <div class="actions">
        <button class="btn" onclick={onclose} disabled={busy}>{t("取消")}</button>
        <button class="btn primary" disabled={!saved || busy} onclick={finish}>{busy ? t("正在设置…") : t("开启加密")}</button>
      </div>
    {:else}
      <h2>{t("开启端到端加密")}</h2>
      <p class="muted">{acc.label}</p>
      <p class="muted">{t("共享相册只能放在加密的库里。照片在浏览器里加密后再上传，除了你自己谁都看不到。换设备时要用密码或恢复密钥解开，两样都丢了就再也打不开。")}</p>
      <label class="field">{t("设置加密密码")}<input type="password" bind:value={pw} autocomplete="new-password" disabled={busy} /></label>
      <label class="field">{t("再输一次")}<input type="password" bind:value={pw2} autocomplete="new-password" disabled={busy} /></label>
      <p class="muted">{t("至少 10 位，要同时有字母和数字，不能用常见的弱密码。请牢记。")}</p>
      {#if note}<p class="error">{note}</p>{/if}
      <div class="actions">
        <button class="btn" onclick={onclose} disabled={busy}>{t("取消")}</button>
        <button class="btn primary" onclick={next} disabled={busy || !pw}>{busy ? t("正在设置…") : t("下一步")}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .check { display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .key { font: 15px/1.6 ui-monospace, monospace; word-break: break-all; user-select: all; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
</style>
