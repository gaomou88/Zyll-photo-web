<script lang="ts">
  import Tile from "./Tile.svelte";
  import { dayKey, dayLabel } from "../lib/media";
  import type { Photo } from "../lib/library.svelte";

  let { photos, selected, onopen, ontoggle, ontoggleday, empty = "这里还没有照片" }: {
    photos: Photo[];
    selected: Set<string>;
    onopen: (index: number) => void;
    ontoggle: (index: number, shift: boolean) => void;
    ontoggleday: (keys: string[]) => void;
    empty?: string;
  } = $props();

  // 按天分组（照片已经按时间从新到旧排好）
  const groups = $derived.by(() => {
    const out: { key: string; label: string; start: number; items: Photo[] }[] = [];
    photos.forEach((p, i) => {
      const k = dayKey(p.item.t);
      const last = out[out.length - 1];
      if (last && last.key === k) last.items.push(p);
      else out.push({ key: k, label: dayLabel(p.item.t), start: i, items: [p] });
    });
    return out;
  });

  // 一次只渲染一部分，滚到底再加（几万张照片也不卡）
  let limit = $state(400);
  const shown = $derived.by(() => {
    const out: typeof groups = [];
    let n = 0;
    for (const g of groups) {
      if (n >= limit) break;
      out.push(g);
      n += g.items.length;
    }
    return out;
  });
  let sentinel = $state<HTMLElement>();
  $effect(() => {
    if (!sentinel) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) limit += 400;
    }, { rootMargin: "1200px" });
    io.observe(sentinel);
    return () => io.disconnect();
  });
  const selecting = $derived(selected.size > 0);
</script>

{#if photos.length === 0}
  <p class="empty muted">{empty}</p>
{:else}
  {#each shown as g (g.key)}
    {@const all = g.items.every((p) => selected.has(p.key))}
    <section class="day">
      <h3>
        <button class="daycheck" class:on={all} class:show={selecting} onclick={() => ontoggleday(g.items.map((p) => p.key))} aria-label="选择这一天">✓</button>
        {g.label}
      </h3>
      <div class="grid">
        {#each g.items as p, j (p.key)}
          <Tile
            photo={p}
            selected={selected.has(p.key)}
            {selecting}
            onopen={() => onopen(g.start + j)}
            ontoggle={(shift) => ontoggle(g.start + j, shift)}
          />
        {/each}
      </div>
    </section>
  {/each}
  <div bind:this={sentinel} class="sentinel"></div>
{/if}

<style>
  /* 屏幕外的日期分组不排版不绘制，几千张照片滚动也流畅 */
  .day { margin-bottom: 18px; content-visibility: auto; contain-intrinsic-size: auto 420px; }
  h3 {
    margin: 0 0 8px; font-size: 15px; font-weight: 500; display: flex; align-items: center; gap: 8px;
  }
  .daycheck {
    width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid var(--muted); background: none;
    font-size: 12px; color: transparent; padding: 0; display: none;
  }
  h3:hover .daycheck, .daycheck.show { display: inline-grid; place-items: center; }
  .daycheck.on { background: var(--select); border-color: var(--select); color: #fff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 3px; }
  @media (max-width: 600px) { .grid { grid-template-columns: repeat(3, 1fr); gap: 2px; } }
  .empty { text-align: center; padding: 80px 16px; font-size: 15px; }
  .sentinel { height: 1px; }
</style>
