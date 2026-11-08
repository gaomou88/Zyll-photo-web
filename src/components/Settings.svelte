<script lang="ts">
  import Icon from "./Icon.svelte";
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

  function disconnect(a: Account) {
    if (confirm(`在这个浏览器里断开 ${a.label}？网盘里的照片不受影响。`)) library.disconnect(a);
  }

  const stateText: Record<string, string> = { loading: "正在读取…", ready: "已连接", locked: "有加密照片，需要解锁", signin: "登录已过期", error: "出错了" };
</script>

<div class="settings">
  <section>
    <h2>网盘账号</h2>
    {#each library.accounts as a (a.key)}
      <div class="acc">
        <div class="grow">
          <div class="name">{a.label}</div>
          <div class="muted">{stateText[a.state]}{#if a.state === "ready"} · {a.items.length} 项{#if a.quota.total} · 已用 {fmtSize(a.quota.used ?? 0)} / {fmtSize(a.quota.total)}{/if}{/if}</div>
          <div class="muted">{a.where}</div>
          {#if a.error}<div class="error">{a.error}</div>{/if}
          {#if a.readOnly}<div class="error">{a.readOnly}</div>{/if}
        </div>
        {#if a.state === "signin" || a.state === "error"}
          <button class="btn" disabled={!!busy} onclick={() => reconnect(a)}>{busy === a.key ? "等待登录…" : "重新连接"}</button>
        {/if}
        {#if a.state === "error"}<button class="icon-btn" onclick={() => a.load()} aria-label="重试"><Icon name="refresh" /></button>{/if}
        <button class="icon-btn" onclick={() => disconnect(a)} aria-label="断开"><Icon name="logout" /></button>
      </div>
    {/each}
    <div class="row">
      {#if configured("google")}<button class="btn" disabled={!!busy} onclick={() => connect("google")}><Icon name="plus" size={18} /> {busy === "google" ? "等待登录…" : "添加 Google 云端硬盘"}</button>{/if}
      {#if configured("onedrive")}<button class="btn" disabled={!!busy} onclick={() => connect("onedrive")}><Icon name="plus" size={18} /> {busy === "onedrive" ? "等待登录…" : "添加 OneDrive"}</button>{/if}
      {#if busy}<button class="btn text" onclick={cancelSignIn}>取消</button>{/if}
    </div>
    {#if error}<p class="error">{error}</p>{/if}
  </section>

  <section>
    <h2>端到端加密</h2>
    {#if !library.hasVault}
      <p class="muted">你的网盘里没有加密照片。端到端加密在手机 Zyll 的“我的 → 端到端加密”里开启。</p>
    {:else if library.unlocked}
      <p class="muted">已解锁。密钥只在这个页面的内存里，关闭页面或锁上后需要重新输入密码。</p>
      <label class="field inline">闲置多久自动锁上
        <select bind:value={autoLock}>
          <option value={5}>5 分钟</option>
          <option value={15}>15 分钟</option>
          <option value={60}>1 小时</option>
          <option value={0}>不自动锁</option>
        </select>
      </label>
      <div><button class="btn" onclick={onlock}><Icon name="lock" size={18} /> 现在锁上</button></div>
    {:else}
      <p class="muted">加密的照片需要输入密码才能查看和上传。</p>
      <div><button class="btn primary" onclick={onunlock}>解锁</button></div>
    {/if}
  </section>

  <section>
    <h2>关于网页版</h2>
    <ul class="muted">
      <li>网页版不做自动备份和 AI 功能（搜索、修图），这些在手机上用。</li>
      <li>从网页删除的照片只删网盘里的备份。手机上如果还留着这张照片，手机会再备份一次。</li>
      <li>登录令牌保存在这个浏览器里，只能访问 Zyll 自己的文件夹；在公用电脑上用完请断开账号。</li>
      <li>Google 的网页登录大约一小时过期，过期后点“重新连接”即可，加密照片不需要重新解锁。</li>
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
