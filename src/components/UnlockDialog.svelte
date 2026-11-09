<script lang="ts">
  import { library } from "../lib/library.svelte";
  import { uploads } from "../lib/uploads.svelte";
  import { t } from "../lib/i18n";

  let { onclose }: { onclose: () => void } = $props();
  let secret = $state("");
  let recovery = $state(false);
  let busy = $state(false);
  let error = $state("");

  async function submit(e: Event) {
    e.preventDefault();
    if (!secret) return;
    error = "";
    busy = true;
    try {
      await library.unlock(secret, recovery);
      secret = "";
      uploads.resume();
      onclose();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="scrim">
  <form class="dialog" onsubmit={submit}>
    <h2>{t("unlock.title")}</h2>
    <p class="muted">{t("unlock.desc")}</p>
    <label class="field">
      {recovery ? t("unlock.recovery") : t("unlock.password")}
      <!-- svelte-ignore a11y_autofocus -->
      <input type={recovery ? "text" : "password"} bind:value={secret} autocomplete="off" autofocus class:mono={recovery}
        placeholder={recovery ? "XXXX-XXXX-…" : ""} />
    </label>
    <button type="button" class="btn text" style="align-self: flex-start" onclick={() => (recovery = !recovery)}>
      {recovery ? t("unlock.usePassword") : t("unlock.useRecovery")}
    </button>
    {#if error}<p class="error">{error}</p>{/if}
    <div class="actions">
      <button type="button" class="btn" onclick={onclose}>{t("unlock.later")}</button>
      <button type="submit" class="btn primary" disabled={busy || !secret}>{busy ? t("unlock.busy") : t("unlock.ok")}</button>
    </div>
  </form>
</div>
