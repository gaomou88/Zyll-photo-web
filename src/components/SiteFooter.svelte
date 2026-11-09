<script lang="ts">
  import { legalPage, t } from "../lib/i18n";

  let { compact = false }: { compact?: boolean } = $props();
  const repos = [
    { name: "Zyll-photo-web", label: () => t("网页版"), url: "https://github.com/gaomou88/Zyll-photo-web" },
    { name: "Zyll-photo", label: () => t("App 版"), url: "https://github.com/gaomou88/Zyll-photo" },
  ];
</script>

<footer class:compact>
  <div class="oss">
    <span class="title">{t("开源代码")}</span>
    {#each repos as r}
      <a href={r.url} target="_blank" rel="noopener"><span>{r.label()}</span><span class="repo">{r.name}</span></a>
    {/each}
    <span class="license">{t("基于 {license} 协议开源", { license: "GPL-3.0" })}</span>
  </div>
  <div class="legal">
    <a href={legalPage("privacy")} target="_blank" rel="noopener">{t("隐私政策")}</a>
    <span aria-hidden="true">·</span>
    <a href={legalPage("terms")} target="_blank" rel="noopener">{t("使用条款")}</a>
  </div>
</footer>

<style>
  footer { display: flex; flex-direction: column; gap: 10px; font-size: 12px; color: var(--muted); }
  .oss { display: flex; flex-direction: column; gap: 2px; }
  .title { font-weight: 600; color: var(--text); margin-bottom: 2px; }
  a { color: var(--muted); text-decoration: none; display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; }
  a:hover { color: var(--accent); }
  .repo { font-family: ui-monospace, monospace; font-size: 11px; opacity: 0.85; }
  .license { margin-top: 2px; }
  .legal { display: flex; gap: 6px; align-items: center; padding-top: 8px; border-top: 1px solid var(--border); }
  .legal a { display: inline; padding: 0; }
  .compact { align-items: center; text-align: center; }
  .compact .oss { align-items: center; }
  .compact a { justify-content: center; }
  .compact .legal { border-top: none; padding-top: 0; }
</style>
