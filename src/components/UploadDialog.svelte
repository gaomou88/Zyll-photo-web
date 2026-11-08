<script lang="ts">
  import { library, type Account } from "../lib/library.svelte";
  import { uploads } from "../lib/uploads.svelte";
  import { fmtSize } from "../lib/media";

  let { files, defaultAlbum = "", onclose, onneedunlock }: {
    files: File[];
    defaultAlbum?: string;
    onclose: () => void;
    onneedunlock: () => void;
  } = $props();

  const writable = $derived(library.accounts.filter((a) => a.state === "ready" && !a.readOnly));
  let target = $state<Account | null>(null);
  $effect(() => {
    if (!target || !writable.includes(target)) target = writable[0] ?? null;
  });
  let album = $state(defaultAlbum || "网页上传");
  const albums = $derived([...new Set(library.photos.map((p) => p.item.a).filter(Boolean))].sort());
  const size = $derived(files.reduce((s, f) => s + f.size, 0));
  let note = $state("");

  function start() {
    if (!target) return;
    if (target.uploadEncrypted && !target.wrapKey()) {
      onneedunlock();
      return;
    }
    const ignored = uploads.add(files, target, album.trim() || "网页上传");
    if (ignored === files.length) {
      note = uploads.running ? "正在往另一个账号上传，等它传完再试" : "选中的文件里没有照片或视频";
      return;
    }
    onclose();
  }
</script>

<div class="scrim">
  <div class="dialog">
    <h2>上传 {files.length} 个文件</h2>
    <p class="muted">共 {fmtSize(size)}。和网盘里内容相同的照片会自动跳过。</p>
    {#if writable.length === 0}
      <p class="error">没有可以上传的网盘账号（未连接、需要续期或只读）。</p>
    {:else}
      {#if writable.length > 1}
        <label class="field">上传到
          <select bind:value={target}>
            {#each writable as a}<option value={a}>{a.label}</option>{/each}
          </select>
        </label>
      {/if}
      <label class="field">放进相簿
        <input type="text" bind:value={album} list="album-list" />
        <datalist id="album-list">{#each albums as a}<option value={a}></option>{/each}</datalist>
      </label>
      {#if target}
        <p class="muted">{target.uploadEncrypted ? "这个账号开着端到端加密：照片在浏览器里加密后再上传。" : "这个账号没开端到端加密：照片按原样上传。"}</p>
      {/if}
    {/if}
    {#if note}<p class="error">{note}</p>{/if}
    <div class="actions">
      <button class="btn" onclick={onclose}>取消</button>
      <button class="btn primary" disabled={!target} onclick={start}>开始上传</button>
    </div>
  </div>
</div>
