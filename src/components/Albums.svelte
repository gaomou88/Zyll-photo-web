<script lang="ts">
  import { thumbUrl } from "../lib/thumbs";
  import type { Photo } from "../lib/library.svelte";
  import { t } from "../lib/i18n";

  let { photos, onopen }: { photos: Photo[]; onopen: (name: string) => void } = $props();

  // 按相簿分组，封面用最新的一张
  const albums = $derived.by(() => {
    const m = new Map<string, Photo[]>();
    for (const p of photos) {
      const a = p.item.a || t("未命名");
      let list = m.get(a);
      if (!list) m.set(a, (list = []));
      list.push(p);
    }
    return [...m.entries()].map(([name, list]) => ({ name, count: list.length, cover: list[0]! })).sort((a, b) => b.cover.item.t - a.cover.item.t);
  });

  const covers = $state<Record<string, string>>({});
  $effect(() => {
    for (const a of albums) {
      if (covers[a.name]) continue;
      thumbUrl(a.cover).then((u) => u && (covers[a.name] = u)).catch(() => {});
    }
  });
</script>

{#if albums.length === 0}
  <p class="muted empty">{t("还没有相簿。手机备份的照片会按手机上的相簿分好。")}</p>
{:else}
  <div class="grid">
    {#each albums as a (a.name)}
      <button class="album" onclick={() => onopen(a.name)}>
        <div class="cover">{#if covers[a.name]}<img src={covers[a.name]} alt="" />{/if}</div>
        <div class="name">{a.name}</div>
        <div class="muted">{t("{n} 项", { n: a.count })}</div>
      </button>
    {/each}
  </div>
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px 16px; }
  @media (max-width: 600px) { .grid { grid-template-columns: repeat(2, 1fr); gap: 14px 10px; } }
  .album { all: unset; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
  .album:focus-visible .cover { outline: 3px solid var(--accent); }
  .cover { aspect-ratio: 1; border-radius: 14px; overflow: hidden; background: var(--tile-bg); }
  img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.2s; }
  .album:hover img { transform: scale(1.03); }
  .name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 4px; }
  .empty { text-align: center; padding: 80px 16px; }
</style>
