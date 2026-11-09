<script lang="ts">
  import Icon from "./Icon.svelte";
  import { configured, cancelSignIn, type DriveKind } from "../lib/auth";
  import { library } from "../lib/library.svelte";
  import { t } from "../lib/i18n";

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
    <img class="logo" src="./icon-192.png" alt="Zyll" width="72" height="72" />
    <h1>{t("welcome.title")}</h1>
    <p>{t("welcome.intro1")}<strong>{t("welcome.introStrong")}</strong>{t("welcome.intro2")}</p>
    <div class="buttons">
      <button class="btn primary" disabled={!!busy || !configured("google")} onclick={() => connect("google")}>
        <Icon name="cloud" size={18} /> {busy === "google" ? t("welcome.waiting") : t("welcome.google")}
      </button>
      <button class="btn primary" disabled={!!busy || !configured("onedrive")} onclick={() => connect("onedrive")}>
        <Icon name="cloud" size={18} /> {busy === "onedrive" ? t("welcome.waiting") : t("welcome.onedrive")}
      </button>
      {#if busy}<button class="btn text" onclick={cancelSignIn}>{t("common.cancel")}</button>{/if}
    </div>
    {#if !configured("google") || !configured("onedrive")}
      <p class="muted">这个网页版还没有配置{!configured("google") ? " Google" : ""}{!configured("google") && !configured("onedrive") ? " 和" : ""}{!configured("onedrive") ? " OneDrive" : ""} 的登录，对应按钮暂不可用。</p>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
    <p class="muted">{t("welcome.popup")}</p>
    <p class="muted legal">{t("legal.agree1")}<a href="terms.html" target="_blank" rel="noopener">{t("legal.terms")}</a>{t("legal.and")}<a href="privacy.html" target="_blank" rel="noopener">{t("legal.privacy")}</a></p>
  </div>
</div>

<style>
  .welcome { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
  .card {
    width: min(520px, 100%); background: var(--surface); border: 1px solid var(--border); border-radius: 24px;
    padding: 32px 28px; display: flex; flex-direction: column; gap: 14px; text-align: center; align-items: center;
  }
  .logo { width: 72px; height: 72px; }
  h1 { margin: 0; font-size: 24px; font-weight: 600; }
  p { margin: 0; }
  .legal a { color: var(--accent); }
  .buttons { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 300px; margin: 8px 0; }
  .buttons .btn { justify-content: center; padding: 11px 16px; }
</style>
