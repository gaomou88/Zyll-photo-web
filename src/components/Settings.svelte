<script lang="ts">
  import Icon from "./Icon.svelte";
  import { t } from "../lib/i18n";
  import { configured, cancelSignIn, type DriveKind } from "../lib/auth";
  import { library, type Account } from "../lib/library.svelte";
  import { fmtSize } from "../lib/media";

  let { autoLock = $bindable(), onlock, onunlock }: { autoLock: number; onlock: () => void; onunlock: () => void } = $props();
  let busy = $state("");
  let error = $state("");

  async function connect(kind: DriveKind) {
    error = "";
    busy = kind;
    try {
      await library.connect(kind);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = "";
    }
  }

  async function reconnect(a: Account) {
    error = "";
    busy = a.key;
    try {
      await library.reconnect(a);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = "";
    }
  }

  async function disconnect(a: Account) {
    if (!confirm(t("在这个浏览器里断开 {name}？网盘里的照片不受影响。", { name: a.label }))) return;
    busy = a.key;
    try {
      await library.disconnect(a);
    } catch (e) {
      if (confirm(`${(e as Error).message}\n\n${t("建议先别断开，等网络恢复后刷新页面会自动补写。仍然要断开吗？")}`)) await library.disconnect(a, true);
    } finally {
      busy = "";
    }
  }

  async function trust(a: Account) {
    if (!confirm(t("确认网盘上的目录是手机上“以网盘为准”或你自己还原的？确认后网页按网盘现在的内容继续使用。"))) return;
    busy = a.key;
    try {
      await a.trustDrive();
    } finally {
      busy = "";
    }
  }

  const stateText: Record<string, string> = { loading: t("正在读取…"), ready: t("已连接"), locked: t("有加密照片，需要解锁"), signin: t("登录已过期"), error: t("出错了") };
</script>

<div class="settings">
  <section>
    <h2>{t("网盘账号")}</h2>
    {#each library.accounts as a (a.key)}
      <div class="acc">
        <div class="grow">
          <div class="name">{a.label}</div>
          <div class="muted">{stateText[a.state]}{#if a.state === "ready"} · {t("{n} 项", { n: a.items.length })}{#if a.quota.total} · {t("已用 {used} / {total}", { used: fmtSize(a.quota.used ?? 0), total: fmtSize(a.quota.total) })}{/if}{/if}</div>
          <div class="muted">{a.where}</div>
          {#if a.error}<div class="error">{a.error}</div>{/if}
          {#if a.readOnly}<div class="error">{a.readOnly}</div>{/if}
          {#if a.migrating}<div class="error">{t("手机正在搬迁存储位置，搬完前不能在这里上传或删除照片。")}</div>{/if}
          {#if a.migrationStale}
            <div class="error">{t("搬迁已经超过 3 天没有进展，搬的那台手机可能已经不用了。如果确定不会再搬，可以不再等它，恢复上传。")}</div>
            <button class="btn text" onclick={() => confirm(t("确定不再等那台手机搬完？如果它之后又继续搬，网页会重新等待。")) && a.stopWaitingMigration()}>{t("不再等它")}</button>
          {/if}
          {#if a.lostUploads.length}<div class="error">{t("这些照片在手机搬迁存储位置时丢了，请重新上传：{names}", { names: a.lostUploads.join(", ") })}</div>{/if}
          {#if a.rolledBack}<button class="btn text" disabled={busy === a.key} onclick={() => trust(a)}>{t("以网盘为准")}</button>{/if}
        </div>
        {#if a.state === "signin" || a.state === "error"}
          <button class="btn" disabled={!!busy} onclick={() => reconnect(a)}>{busy === a.key ? t("等待登录…") : t("重新连接")}</button>
        {/if}
        {#if a.state === "error"}<button class="icon-btn" onclick={() => a.load()} aria-label={t("重试")}><Icon name="refresh" /></button>{/if}
        <button class="icon-btn" onclick={() => disconnect(a)} aria-label={t("断开")}><Icon name="logout" /></button>
      </div>
    {/each}
    <div class="row">
      {#if configured("google")}<button class="btn" disabled={!!busy} onclick={() => connect("google")}><Icon name="plus" size={18} /> {busy === "google" ? t("等待登录…") : t("添加 Google 网盘")}</button>{/if}
      {#if configured("onedrive")}<button class="btn" disabled={!!busy} onclick={() => connect("onedrive")}><Icon name="plus" size={18} /> {busy === "onedrive" ? t("等待登录…") : t("添加 OneDrive")}</button>{/if}
      {#if busy}<button class="btn text" onclick={cancelSignIn}>{t("取消")}</button>{/if}
    </div>
    {#if error}<p class="error">{error}</p>{/if}
  </section>

  <section>
    <h2>{t("端到端加密")}</h2>
    {#if !library.hasVault}
      <p class="muted">{t("你的网盘里没有加密照片。端到端加密可以在手机 Zyll 的“我的 → 端到端加密”里开启，也可以在这里第一次往新网盘上传时开启。")}</p>
    {:else if library.unlocked}
      <p class="muted">{t("已解锁。密钥只在这个页面的内存里，关闭页面或锁上后需要重新输入密码。")}</p>
      <label class="field inline">{t("闲置多久自动锁上")}
        <select bind:value={autoLock}>
          <option value={5}>{t("{n} 分钟", { n: 5 })}</option>
          <option value={15}>{t("{n} 分钟", { n: 15 })}</option>
          <option value={60}>{t("1 小时")}</option>
          <option value={0}>{t("不自动锁")}</option>
        </select>
      </label>
      <div><button class="btn" onclick={onlock}><Icon name="lock" size={18} /> {t("现在锁上")}</button></div>
    {:else}
      <p class="muted">{t("加密的照片需要输入密码才能查看和上传。")}</p>
      <div><button class="btn primary" onclick={onunlock}>{t("解锁")}</button></div>
    {/if}
  </section>

  <section>
    <h2>{t("关于网页版")}</h2>
    <ul class="muted">
      <li>{t("网页版不做自动备份和 AI 功能（搜索、修图），这些在手机上用。")}</li>
      <li>{t("从网页删除的照片只删网盘里的备份。手机相册里还在的照片，手机会再备份一次；在手机上“释放空间”过或已经删掉的照片，网盘里那份就是唯一一份，删了就没了。")}</li>
      <li>{t("网页版上传只传到你选的那一个账号，手机上设的“每种网盘各一份”对网页上传的照片不生效。")}</li>
      <li>{t("手机上的敏感画面保护只在手机上生效，网页版会直接显示所有照片，在别人面前打开时请注意。")}</li>
      <li>{t("登录令牌保存在这个浏览器里，只能访问 Zyll 自己的文件夹；在公用电脑上用完请断开账号。")}</li>
      <li>{t("Google 的网页登录大约一小时过期，过期后点“重新连接”即可，加密照片不需要重新解锁。")}</li>
    </ul>
      </section>
</div>

<style>
  .settings { max-width: 720px; display: flex; flex-direction: column; gap: 28px; }
  h2 { font-size: 17px; font-weight: 600; margin: 0 0 12px; }
  section { display: flex; flex-direction: column; gap: 12px; }
  section p { margin: 0; }
  .acc { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; }
  .grow { flex: 1; min-width: 0; }
  .name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .inline { max-width: 260px; }
  ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
</style>
