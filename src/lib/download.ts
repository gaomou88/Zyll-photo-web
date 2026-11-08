import { downloadZip } from "client-zip";
import { saveBlob } from "./media";
import type { Photo } from "./library.svelte";

/** 下载到电脑：一张直接存，几张打包成 zip（Chrome / Edge 边下边写进文件，不占满内存）。 */
export async function downloadPhotos(list: Photo[], onProgress: (done: number, total: number) => void, signal?: AbortSignal) {
  if (list.length === 1) {
    const p = list[0]!;
    onProgress(0, 1);
    saveBlob(await p.acc.original(p.item, signal), p.item.n || "photo");
    onProgress(1, 1);
    return;
  }
  const used = new Set<string>();
  const unique = (name: string) => {
    let n = name || "photo";
    const dot = n.lastIndexOf(".");
    const base = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : "";
    for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base} (${i})${ext}`;
    used.add(n.toLowerCase());
    return n;
  };
  let done = 0;
  async function* files() {
    for (const p of list) {
      signal?.throwIfAborted();
      const blob = await p.acc.original(p.item, signal);
      yield { name: unique(p.item.n), lastModified: new Date(p.item.t || Date.now()), input: blob };
      onProgress(++done, list.length);
    }
  }
  const name = `Zyll-${new Date().toISOString().slice(0, 10)}.zip`;
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  onProgress(0, list.length);
  if (picker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({ suggestedName: name, types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }] });
    } catch {
      return; // 用户取消
    }
    const w = await handle.createWritable();
    await downloadZip(files()).body!.pipeTo(w);
    return;
  }
  saveBlob(await downloadZip(files()).blob(), name);
}
