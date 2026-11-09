<script lang="ts">
  import Icon from "./Icon.svelte";
  import { uploads } from "../lib/uploads.svelte";
  import { t } from "../lib/i18n";

  let open = $state(true);
  const total = $derived(uploads.jobs.length);
  const failed = $derived(uploads.jobs.filter((j) => j.state === "failed"));
  const skipped = $derived(uploads.jobs.filter((j) => j.state === "skipped").length);
  const current = $derived(uploads.jobs.find((j) => j.state === "working"));
</script>

{#if total > 0}
  <div class="panel">
    <div class="head">
      <button class="grow" onclick={() => (open = !open)}>
        {#if uploads.running}
          {t("正在上传 {d} / {n}", { d: uploads.done + 1, n: total })}
        {:else if uploads.needsUnlock}
          {t("需要解锁后才能继续上传")}
        {:else if uploads.waiting}
          {t("已暂停，还有 {n} 个没传", { n: uploads.waiting })}
        {:else}
          {t("上传完成：{n} 张", { n: total - failed.length - skipped })}{#if skipped}{t("，{n} 张已存在", { n: skipped })}{/if}{#if failed.length}{t("，{n} 张失败", { n: failed.length })}{/if}
        {/if}
      </button>
      {#if uploads.running}
        <button class="btn text" onclick={() => uploads.cancel()}>{t("取消")}</button>
      {:else}
        {#if uploads.waiting && !uploads.needsUnlock}<button class="btn text" onclick={() => uploads.resume()}>{t("继续上传")}</button>{/if}
        <button class="icon-btn" onclick={() => uploads.clear()} aria-label={t("关闭")}><Icon name="close" size={18} /></button>
      {/if}
    </div>
    {#if uploads.running && current}
      <div class="bar"><div style="width: {Math.round(((uploads.done + current.frac) / total) * 100)}%"></div></div>
      <p class="muted cur">{current.phase} · {current.file.name}</p>
    {/if}
    {#if open && failed.length}
      <ul>
        {#each failed as j}<li><span>{j.file.name}</span><span class="error">{j.error}</span></li>{/each}
      </ul>
    {/if}
    <p class="muted target">{t("上传到 {acc} · 相簿“{album}”", { acc: uploads.target?.label ?? "", album: uploads.album })}</p>
  </div>
{/if}

<style>
  .panel {
    position: fixed; right: 16px; bottom: 16px; z-index: 30; width: min(380px, calc(100vw - 32px));
    background: var(--surface); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow);
    padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; animation: zy-rise 0.22s cubic-bezier(0.2, 0, 0, 1);
  }
  .head { display: flex; align-items: center; gap: 8px; }
  .grow { flex: 1; text-align: left; background: none; border: none; padding: 0; font-weight: 500; }
  .bar { height: 4px; background: var(--surface-2); border-radius: 2px; overflow: hidden; }
  .bar div { height: 100%; background: var(--accent); transition: width 0.2s; }
  .cur, .target { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ul { margin: 0; padding: 0; list-style: none; max-height: 160px; overflow: auto; font-size: 13px; }
  li { display: flex; flex-direction: column; padding: 4px 0; border-top: 1px solid var(--border); }
</style>
