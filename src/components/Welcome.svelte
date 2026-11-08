<script lang="ts">
  import Icon from "./Icon.svelte";
  import { configured, cancelSignIn, type DriveKind } from "../lib/auth";
  import { library } from "../lib/library.svelte";

  let busy = $state<DriveKind | null>(null);
  let error = $state("");

  async function connect(kind: DriveKind) {
    error = "";
    busy = kind;
    try {
      await library.connect(kind);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = null;
    }
  }
</script>

<div class="welcome">
  <div class="card">
    <div class="logo"><Icon name="photos" size={34} /></div>
    <h1>Zyll 相册 · 网页版</h1>
    <p>在电脑上查看、上传和下载你手机备份到网盘的照片。照片存在<strong>你自己的</strong>网盘里，加密的照片只在这个浏览器里解密，网盘和任何服务器都看不到内容。</p>
    <div class="buttons">
      <button class="btn primary" disabled={!!busy || !configured("google")} onclick={() => connect("google")}>
        <Icon name="cloud" size={18} /> {busy === "google" ? "等待登录…" : "连接 Google 云端硬盘"}
      </button>
      <button class="btn primary" disabled={!!busy || !configured("onedrive")} onclick={() => connect("onedrive")}>
        <Icon name="cloud" size={18} /> {busy === "onedrive" ? "等待登录…" : "连接 OneDrive"}
      </button>
      {#if busy}<button class="btn text" onclick={cancelSignIn}>取消</button>{/if}
    </div>
    {#if !configured("google") || !configured("onedrive")}
      <p class="muted">这个网页版还没有配置{!configured("google") ? " Google" : ""}{!configured("google") && !configured("onedrive") ? " 和" : ""}{!configured("onedrive") ? " OneDrive" : ""} 的登录，对应按钮暂不可用。</p>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
    <p class="muted">登录在弹出的窗口里完成，请允许本网站弹出窗口。用和手机 Zyll 相同的网盘账号登录才能看到手机的备份。</p>
    <p class="muted legal">连接即表示你同意<a href="terms.html" target="_blank" rel="noopener">使用条款</a>和<a href="privacy.html" target="_blank" rel="noopener">隐私政策</a></p>
  </div>
</div>

<style>
  .welcome { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
  .card {
    width: min(520px, 100%); background: var(--surface); border: 1px solid var(--border); border-radius: 24px;
    padding: 32px 28px; display: flex; flex-direction: column; gap: 14px; text-align: center; align-items: center;
  }
  .logo { width: 64px; height: 64px; border-radius: 20px; background: var(--accent-soft); color: var(--accent); display: grid; place-items: center; }
  h1 { margin: 0; font-size: 24px; font-weight: 600; }
  p { margin: 0; }
  .legal a { color: var(--accent); }
  .buttons { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 300px; margin: 8px 0; }
  .buttons .btn { justify-content: center; padding: 11px 16px; }
</style>
