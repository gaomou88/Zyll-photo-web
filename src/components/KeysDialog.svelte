<script lang="ts">
  import { library } from "../lib/library.svelte";
  import { passwordProblem } from "../lib/password";
  import { t } from "../lib/i18n";

  /**
   * 换恢复密钥（mode = "recovery"：输入现在的密码）或改密码（mode = "password"：用现在的密码或恢复密钥证明身份，再设新密码）。
   * 主密钥不变，只是重新包一次、写回网盘上的密钥包，照片不用重新上传。和 App 里的同名功能一样。
   */
  let { mode, onclose }: { mode: "recovery" | "password"; onclose: () => void } = $props();

  let withRecovery = $state(false);
  let secret = $state("");
  let pw = $state("");
  let pw2 = $state("");
  let busy = $state(false);
  let note = $state("");
  let newKey = $state<string | null>(null);
  let failed = $state<string[]>([]);
  let saved = $state(false);
  let copied = $state(false);
  let done = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    if (!secret) return;
    if (mode === "password") {
      const bad = passwordProblem(pw);
      if (bad) return void (note = t(bad.key, bad.vars));
      if (pw !== pw2) return void (note = t("两次输入的密码不一样。"));
    }
    busy = true;
    note = "";
    try {
      const r = await library.rewrap(secret, mode === "password" && withRecovery, mode === "password" ? pw : undefined);
      secret = pw = pw2 = "";
      failed = r.failed;
      newKey = r.recoveryKey;
      done = true;
    } catch (err) {
      note = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(newKey!);
      copied = true;
    } catch {
      copied = false;
    }
  }
</script>

<div class="scrim">
  {#if done}
    <div class="dialog">
      {#if newKey}
        <h2>{t("抄下新的恢复密钥")}</h2>
        <p>{t("旧的恢复密钥已经作废。忘了密码时，要用这个新的才能打开加密的照片。请抄在纸上或存进密码管理器，关掉这个窗口后不会再显示。")}</p>
        <div class="key">{newKey}</div>
        <button class="btn text" style="align-self: flex-start" onclick={copyKey}>{copied ? t("已复制") : t("复制")}</button>
      {:else}
        <h2>{t("密码已修改")}</h2>
        <p>{t("以后在手机和网页版上请用新密码，旧密码已经作废。其他设备下次连网时会自动跟上。")}</p>
      {/if}
      {#if failed.length}
        <p class="error">{t("这些账号这次没写成，手机下次连网时会自动补上：{names}", { names: failed.join("、") })}</p>
      {/if}
      {#if newKey}<label class="check"><input type="checkbox" bind:checked={saved} /> {t("我已经保存好了")}</label>{/if}
      <div class="actions">
        <button class="btn primary" disabled={!!newKey && !saved} onclick={onclose}>{t("完成")}</button>
      </div>
    </div>
  {:else}
    <form class="dialog" onsubmit={submit}>
      <h2>{mode === "recovery" ? t("换新的恢复密钥") : t("修改密码")}</h2>
      <p class="muted">
        {mode === "recovery"
          ? t("请输入现在的密码。换好以后旧的恢复密钥就作废了，请抄下新的那个。照片不会重新上传。")
          : t("先用现在的密码或恢复密钥证明是你本人，再设新密码。改好以后旧密码就作废了。照片不会重新上传。")}
      </p>
      <label class="field">
        {withRecovery ? t("unlock.recovery") : t("现在的密码")}
        <!-- svelte-ignore a11y_autofocus -->
        <input type={withRecovery ? "text" : "password"} bind:value={secret} autocomplete="off" autofocus class:mono={withRecovery}
          placeholder={withRecovery ? "XXXX-XXXX-…" : ""} disabled={busy} />
      </label>
      {#if mode === "password"}
        <button type="button" class="btn text" style="align-self: flex-start" disabled={busy} onclick={() => ((withRecovery = !withRecovery), (secret = ""), (note = ""))}>
          {withRecovery ? t("unlock.usePassword") : t("忘了密码？用恢复密钥")}
        </button>
        <label class="field">{t("新密码")}<input type="password" bind:value={pw} autocomplete="new-password" disabled={busy} /></label>
        <label class="field">{t("再输一次新密码")}<input type="password" bind:value={pw2} autocomplete="new-password" disabled={busy} /></label>
        <p class="muted">{t("至少 10 位，要同时有字母和数字，不能用常见的弱密码。请牢记。")}</p>
      {/if}
      {#if note}<p class="error">{note}</p>{/if}
      <div class="actions">
        <button type="button" class="btn" onclick={onclose} disabled={busy}>{t("取消")}</button>
        <button type="submit" class="btn primary" disabled={busy || !secret || (mode === "password" && !pw)}>
          {busy ? t("正在处理密钥…") : mode === "recovery" ? t("换新的") : t("修改")}
        </button>
      </div>
    </form>
  {/if}
</div>

<style>
  .check { display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .key { font: 15px/1.6 ui-monospace, monospace; word-break: break-all; user-select: all; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
</style>
