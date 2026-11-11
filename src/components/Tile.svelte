<script lang="ts">
  import Icon from "./Icon.svelte";
  import { t } from "../lib/i18n";
  import { cachedThumb, thumbUrl, whenNear } from "../lib/thumbs";
  import type { Photo } from "../lib/library.svelte";

  let { photo, selected, selecting, onopen, ontoggle }: {
    photo: Photo;
    selected: boolean;
    selecting: boolean;
    onopen: () => void;
    ontoggle: (shift: boolean) => void;
  } = $props();

  let src = $state<string | null>(null);
  let failed = $state(false);
  let shown = $state(false);
  let el: HTMLElement;
  const locked = $derived(!photo.acc.canOpen(photo.item));
  const video = $derived(photo.item.m.startsWith("video/"));

  $effect(() => {
    const p = photo;
    const hit = cachedThumb(p);
    src = hit;
    shown = !!hit;
    failed = false;
    if (hit || !p.acc.canOpen(p.item)) return;
    let cancelled = false;
    const ctl = new AbortController();
    const stop = whenNear(el, () => {
      thumbUrl(p, ctl.signal).then((u) => {
        if (cancelled) return;
        if (u) src = u;
        else failed = true;
      });
    });
    return () => {
      cancelled = true;
      ctl.abort();
      stop();
    };
  });
</script>

<div class="tile" class:selected bind:this={el}>
  <button
    class="hit"
    aria-label={photo.item.n}
    onclick={(e) => (selecting || e.ctrlKey || e.metaKey || e.shiftKey ? ontoggle(e.shiftKey) : onopen())}
  >
    {#if src}
      <img {src} alt="" draggable="false" decoding="async" class:shown onload={() => (shown = true)} />
    {:else}
      <div class="ph">
        {#if locked}<Icon name="lock" />{:else if failed}<Icon name={video ? "video" : "photos"} />{/if}
      </div>
    {/if}
    {#if video}<span class="badge"><Icon name="play" size={14} /></span>{/if}
    {#if !video && (photo.motion || photo.live)}<span class="badge live" title={t("动态照片")}><Icon name="live" size={14} /></span>{/if}
  </button>
  <button class="check" class:on={selected} class:show={selecting} aria-label={t("选择")} onclick={(e) => ontoggle(e.shiftKey)}>
    <Icon name="check" size={16} />
  </button>
</div>

<style>
  .tile { position: relative; aspect-ratio: 1; background: var(--tile-bg); overflow: hidden; }
  .hit { all: unset; position: absolute; inset: 0; cursor: pointer; display: block; }
  .hit:focus-visible { outline: 3px solid var(--accent); outline-offset: -3px; }
  img {
    width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0;
    transition: transform 0.18s cubic-bezier(0.2, 0, 0, 1), border-radius 0.18s, opacity 0.25s ease;
  }
  img.shown { opacity: 1; }
  .hit:hover img.shown { filter: brightness(0.94); }
  .selected img { transform: scale(0.86); border-radius: 6px; }
  .selected { background: var(--accent-soft); }
  .ph { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); }
  .badge {
    position: absolute; right: 6px; bottom: 6px; color: #fff; background: rgba(0, 0, 0, 0.45);
    border-radius: 999px; padding: 3px 6px; display: flex; pointer-events: none;
  }
  .badge.live { bottom: auto; top: 6px; padding: 3px; }
  .check {
    position: absolute; left: 6px; top: 6px; width: 24px; height: 24px; border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.9); background: rgba(0, 0, 0, 0.18); color: transparent;
    display: grid; place-items: center; padding: 0; opacity: 0; transition: opacity 0.12s;
  }
  .tile:hover .check, .check.show, .check:focus-visible { opacity: 1; }
  .check.on { background: var(--select); border-color: var(--select); color: #fff; opacity: 1; }
</style>
