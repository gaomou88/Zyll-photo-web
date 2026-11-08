<script lang="ts">
  // 自绘的线条图标（24×24，描边），不使用第三方图标集
  let { name, size = 22 }: { name: string; size?: number } = $props();
  const paths: Record<string, string> = {
    photos: "M4 5h16v14H4z M4 15l4.5-4.5 4 4 2.5-2.5L20 17 M15.5 9.5a1.5 1.5 0 1 0 0-.01",
    albums: "M7 4h11a2 2 0 0 1 2 2v11 M4 8h12v12H4z M4 17l3.5-3.5 3 3 2-2L16 18",
    video: "M3 6h13v12H3z M16 10l5-3v10l-5-3",
    shared: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M3 19c0-3 2.7-5 6-5s6 2 6 5 M16 5.5a3 3 0 0 1 0 5.5 M18 14.5c2 .6 3 2.2 3 4.5",
    settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3 M5.3 5.3l2.1 2.1 M16.6 16.6l2.1 2.1 M5.3 18.7l2.1-2.1 M16.6 7.4l2.1-2.1",
    upload: "M12 16V4 M7 9l5-5 5 5 M4 15v4h16v-4",
    download: "M12 4v12 M7 11l5 5 5-5 M4 15v4h16v-4",
    trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6",
    close: "M6 6l12 12 M18 6L6 18",
    menu: "M4 7h16 M4 12h16 M4 17h16",
    back: "M15 5l-7 7 7 7",
    left: "M15 5l-7 7 7 7",
    right: "M9 5l7 7-7 7",
    info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M12 11v6 M12 7.5v.5",
    lock: "M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3",
    check: "M5 12.5l4.5 4.5L19 7.5",
    plus: "M12 5v14 M5 12h14",
    cloud: "M7 18a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 8.5a4.5 4.5 0 0 1 .5 9.5z",
    play: "M8 5v14l11-7z",
    refresh: "M20 12a8 8 0 1 1-2.3-5.6 M20 4v5h-5",
    warn: "M12 3l9.5 17h-19z M12 10v4.5 M12 17.5v.5",
    logout: "M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h10",
  };
</script>

<svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={paths[name] ?? ""} fill={name === "play" ? "currentColor" : "none"} />
</svg>

<style>
  .icon { flex: none; display: block; }
</style>
