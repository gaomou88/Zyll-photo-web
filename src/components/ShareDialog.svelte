<script lang="ts">
  import { t } from "../lib/i18n";
  import type { Account, Photo } from "../lib/library.svelte";
  import { problemText, shared } from "../lib/sharing.svelte";

  let { photos, onclose, ondone }: { photos: Photo[]; onclose: () => void; ondone: (albumId: string, msg: string) => void } = $props();

  // 选中的照片可能来自几个账号：按账号分开，一个共享相册只能放同一个账号里的照片
  const byAcc = $derived.by(() => {
    const m = new Map<Account, Photo[]>();
    for (const p of photos) m.set(p.acc, [...(m.get(p.acc) ?? []), p]);
    return [...m.entries()];
  });
  let acc = $state<Account | null>(null);
  $effect(() => {
    if (!acc || !byAcc.some(([a]) => a === acc)) acc = byAcc.find(([a]) => !shared.problem(a))?.[0] ?? byAcc[0]?.[0] ?? null;
  });
  const chosen = $derived(byAcc.find(([a]) => a === acc)?.[1] ?? []);
  const encrypted = $derived(chosen.filter((p) => p.item.e && !p.item.k));
  const problem = $derived(acc ? shared.problem(acc) : null);
  const targets = $derived(shared.albums.filter((a) => a.acc === acc?.key && (a.myRole === null || a.myRole === "manager")));

  let mode = $state<"new" | string>("new");
  let name = $state(photos[0]?.item.a || "");
  let originals = $state(true);
  let busy = $state(false);
  let note = $state("");

  async function go() {
    if (!acc) return;
    busy = true;
    note = "";
    try {
      const items = encrypted.map((p) => p.item);
      if (mode === "new") {
        const ref = await shared.create(acc, name.trim() || t("共享相册"), items, originals);
        ondone(ref.albumId, t("已建好共享相册，放进 {n} 张。", { n: ref.count }));
      } else {
        const n = await shared.addPhotos(mode, items);
        ondone(mode, n ? t("已加进 {n} 张。", { n }) : t("这些照片已经在相册里了。"));
      }
    } catch (e) {
      note = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="scrim">
  <div class="dialog">
    <h2>{t("共享 {n} 项", { n: photos.length })}</h2>
    {#if byAcc.length > 1}
      <label class="field">{t("来自账号")}
        <select bind:value={acc} disabled={busy}>
          {#each byAcc as [a, list]}<option value={a}>{a.label}（{list.length}）</option>{/each}
        </select>
      </label>
      <p class="muted small">{t("一个共享相册只能放同一个网盘账号里的照片。")}</p>
    {/if}
    {#if problem}
      <p class="error">{problemText(problem)}</p>
    {:else}
      {#if encrypted.length < chosen.length}
        <p class="muted small">{t("其中 {n} 张没有加密（或是用旧密钥加密的），不能共享，会跳过。", { n: chosen.length - encrypted.length })}</p>
      {/if}
      {#if targets.length}
        <label class="field">{t("放到")}
          <select bind:value={mode} disabled={busy}>
            <option value="new">{t("新的共享相册")}</option>
            {#each targets as a}<option value={a.albumId}>{a.name}</option>{/each}
          </select>
        </label>
      {/if}
      {#if mode === "new"}
        <label class="field">{t("相册名")}<input type="text" bind:value={name} disabled={busy} /></label>
        <label class="check"><input type="checkbox" bind:checked={originals} disabled={busy} /> {t("允许成员看原图和下载原图")}</label>
        <p class="muted small">{originals ? t("关掉后成员只能看预览图。") : t("成员只能看预览图。")}</p>
      {/if}
      <p class="muted small">{t("照片不会重新上传，只是把它们的解密钥匙用相册钥匙另存一份。建好后在“共享”里邀请别人。")}</p>
    {/if}
    {#if note}<p class="error">{note}</p>{/if}
    <div class="actions">
      <button class="btn" onclick={onclose} disabled={busy}>{t("取消")}</button>
      <button class="btn primary" onclick={go} disabled={busy || !!problem || !encrypted.length}>{busy ? t("正在处理…") : mode === "new" ? t("建共享相册") : t("加进去")}</button>
    </div>
  </div>
</div>

<style>
  .small { font-size: 13px; margin: 0; }
  .check { display: flex; align-items: center; gap: 8px; font-size: 14px; }
</style>
