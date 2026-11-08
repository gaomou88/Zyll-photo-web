<script lang="ts">
  // 安卓手机打开网页时，提示有 Zyll 安卓版（还在开发测试，下载链接先留空）
  const KEY = "zyll-android-banner";
  const DOWNLOAD_URL = "";
  const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  let hidden = $state(read());

  function read() {
    try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
  }
  function close() {
    hidden = true;
    try { localStorage.setItem(KEY, "1"); } catch { /* 无痕模式 */ }
  }
</script>

{#if isAndroid && !hidden}
  <div class="banner" role="status">
    <div class="text">
      <strong>手机上用 Zyll 安卓版更好</strong>
      <span>自动备份、AI 搜索都在 App 里。{DOWNLOAD_URL ? "" : "App 还在开发测试中，很快开放下载。"}</span>
    </div>
    {#if DOWNLOAD_URL}
      <a class="btn primary" href={DOWNLOAD_URL}>下载</a>
    {:else}
      <button class="btn" disabled>即将推出</button>
    {/if}
    <button class="icon-btn" aria-label="关闭" onclick={close}>✕</button>
  </div>
{/if}

<style>
  .banner {
    position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 40; display: flex; align-items: center; gap: 10px;
    padding: 12px 10px 12px 16px; border-radius: 16px; background: var(--surface); border: 1px solid var(--border);
    box-shadow: var(--shadow); animation: zy-rise 0.3s cubic-bezier(0.2, 0, 0, 1);
  }
  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
  .text strong { font-size: 14px; font-weight: 600; }
  .text span { color: var(--muted); }
  .btn { white-space: nowrap; }
</style>
