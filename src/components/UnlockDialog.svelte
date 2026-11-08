<script lang="ts">
  import { library } from "../lib/library.svelte";
  import { uploads } from "../lib/uploads.svelte";

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
    <h2>解锁加密照片</h2>
    <p class="muted">输入你在手机 Zyll 里设置的端到端加密密码。密码只在这个浏览器里用来解开密钥，不会发送到任何地方。</p>
    <label class="field">
      {recovery ? "恢复密钥" : "解锁密码"}
      <!-- svelte-ignore a11y_autofocus -->
      <input type={recovery ? "text" : "password"} bind:value={secret} autocomplete="off" autofocus class:mono={recovery}
        placeholder={recovery ? "XXXX-XXXX-…" : ""} />
    </label>
    <button type="button" class="btn text" style="align-self: flex-start" onclick={() => (recovery = !recovery)}>
      {recovery ? "改用密码" : "忘了密码？用恢复密钥"}
    </button>
    {#if error}<p class="error">{error}</p>{/if}
    <div class="actions">
      <button type="button" class="btn" onclick={onclose}>以后再说</button>
      <button type="submit" class="btn primary" disabled={busy || !secret}>{busy ? "正在解锁…" : "解锁"}</button>
    </div>
  </form>
</div>
