<script lang="ts">
  import Tile from "./Tile.svelte";
  import { dayKey, dayLabel } from "../lib/media";
  import type { Photo } from "../lib/library.svelte";
  import { t } from "../lib/i18n";

  let { photos, selected, onopen, ontoggle, ontoggleday, empty = t("这里还没有照片") }: {
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

  // ---------- 窗口化：只渲染屏幕附近的行，滚过去的图块会被移出页面 ----------

  let box = $state<HTMLElement>();
  let width = $state(0);
  let narrow = $state(false);
  let viewTop = $state(0);
  let viewH = $state(800);

  // 和原来的 CSS 网格一样：宽屏每格至少 150px、间隔 3px；手机每行 3 张、间隔 2px
  const gap = $derived(narrow ? 2 : 3);
  const cols = $derived(narrow ? 3 : Math.max(1, Math.floor((width + gap) / (150 + gap))));
  const size = $derived(width ? (width - gap * (cols - 1)) / cols : 150);
  const HEAD = 38;
  const DAY_GAP = 18;

  type Row = { key: string; top: number; h: number } & ({ head: true; g: (typeof groups)[number] } | { head: false; g: (typeof groups)[number]; from: number });
  const layout = $derived.by(() => {
    const rows: Row[] = [];
    let y = 0;
    for (const g of groups) {
      rows.push({ key: "h" + g.key, top: y, h: HEAD, head: true, g });
      y += HEAD;
      for (let i = 0; i < g.items.length; i += cols) {
        rows.push({ key: `${g.key}/${i}`, top: y, h: size, head: false, g, from: i });
        y += size + gap;
      }
      y += DAY_GAP - gap;
    }
    return { rows, height: y };
  });

  /** 第一个底边在 y 下面的行（二分）。 */
  function firstBelow(y: number): number {
    const rows = layout.rows;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const r = rows[mid]!;
      if (r.top + r.h < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  const visible = $derived.by(() => {
    const margin = viewH; // 上下各多渲染一屏
    const from = firstBelow(viewTop - margin);
    const out: Row[] = [];
    for (let i = from; i < layout.rows.length; i++) {
      const r = layout.rows[i]!;
      if (r.top > viewTop + viewH + margin) break;
      out.push(r);
    }
    return out;
  });

  function measure() {
    if (!box) return;
    const rect = box.getBoundingClientRect();
    viewTop = -rect.top;
    viewH = window.innerHeight;
  }
  $effect(() => {
    if (!box) return;
    const el = box;
    const mq = window.matchMedia("(max-width: 600px)");
    const onMq = () => (narrow = mq.matches);
    onMq();
    mq.addEventListener("change", onMq);
    const ro = new ResizeObserver(() => {
      width = el.clientWidth;
      measure();
    });
    ro.observe(el);
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    measure();
    return () => {
      mq.removeEventListener("change", onMq);
      ro.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  });

  const selecting = $derived(selected.size > 0);
</script>

{#if photos.length === 0}
  <p class="empty muted">{empty}</p>
{:else}
  <div class="wall" bind:this={box} style:height="{layout.height}px">
    {#each visible as r (r.key)}
      {#if r.head}
        {@const all = r.g.items.every((p) => selected.has(p.key))}
        <h3 style:top="{r.top}px">
          <button class="daycheck" class:on={all} class:show={selecting} onclick={() => ontoggleday(r.g.items.map((p) => p.key))} aria-label={t("选择这一天")}>✓</button>
          {r.g.label}
        </h3>
      {:else}
        {@const g = r.g}
        {@const from = r.from}
        <div class="row" style:top="{r.top}px" style:height="{r.h}px" style:grid-template-columns="repeat({cols}, 1fr)" style:gap="{gap}px">
          {#each g.items.slice(from, from + cols) as p, j (p.key)}
            <Tile
              photo={p}
              selected={selected.has(p.key)}
              {selecting}
              onopen={() => onopen(g.start + from + j)}
              ontoggle={(shift) => ontoggle(g.start + from + j, shift)}
            />
          {/each}
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .wall { position: relative; }
  h3 {
    position: absolute; left: 0; right: 0; height: 38px; margin: 0; padding-bottom: 8px; box-sizing: border-box;
    font-size: 15px; font-weight: 500; display: flex; align-items: flex-end; gap: 8px;
  }
  .row { position: absolute; left: 0; right: 0; display: grid; }
  .daycheck {
    width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid var(--muted); background: none;
    font-size: 12px; color: transparent; padding: 0; display: none;
  }
  h3:hover .daycheck, .daycheck.show { display: inline-grid; place-items: center; }
  .daycheck.on { background: var(--select); border-color: var(--select); color: #fff; }
  .empty { text-align: center; padding: 80px 16px; font-size: 15px; }
</style>
