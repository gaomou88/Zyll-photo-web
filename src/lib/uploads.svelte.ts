import { NeedsSignIn } from "./auth";
import { Locked, type Account } from "./library.svelte";
import { isMedia, mimeOf } from "./media";

/** 上传队列：一次传一个文件，每传完 10 个写一次目录，全部传完再写一次。 */

export interface UploadJob {
  file: File;
  state: "waiting" | "working" | "done" | "skipped" | "failed";
  phase: string;
  frac: number;
  error: string;
}

class Uploads {
  jobs = $state<UploadJob[]>([]);
  running = $state(false);
  target = $state<Account | null>(null);
  album = $state("");
  /** 需要先解锁才能继续 */
  needsUnlock = $state(false);
  private ctl: AbortController | null = null;

  get done() {
    return this.jobs.filter((j) => j.state === "done" || j.state === "skipped" || j.state === "failed").length;
  }

  /** 只收照片和视频。返回被忽略的文件数。 */
  add(files: File[], target: Account, album: string): number {
    const ok = files.filter((f) => isMedia(mimeOf(f)));
    if (this.running && this.target !== target) return files.length;
    if (!this.running) {
      this.jobs = this.jobs.filter((j) => j.state === "waiting");
      this.target = target;
      this.album = album;
    }
    this.jobs = [...this.jobs, ...ok.map((file) => ({ file, state: "waiting" as const, phase: "", frac: 0, error: "" }))];
    if (!this.running) void this.run();
    return files.length - ok.length;
  }

  cancel() {
    this.ctl?.abort();
  }

  clear() {
    if (!this.running) this.jobs = [];
  }

  private async run() {
    const acc = this.target!;
    this.running = true;
    this.needsUnlock = false;
    this.ctl = new AbortController();
    let sinceCommit = 0;
    try {
      for (let i = 0; i < this.jobs.length; i++) {
        const job = this.jobs[i]!;
        if (job.state !== "waiting") continue;
        if (this.ctl.signal.aborted) break;
        job.state = "working";
        try {
          const item = await acc.uploadFile(job.file, this.album, (phase, frac) => {
            job.phase = phase;
            job.frac = frac;
          }, this.ctl.signal);
          job.state = item ? "done" : "skipped";
          if (item && ++sinceCommit >= 10) {
            await acc.commitUploads();
            sinceCommit = 0;
          }
        } catch (e) {
          if (e instanceof Locked) {
            job.state = "waiting";
            this.needsUnlock = true;
            break;
          }
          if (e instanceof NeedsSignIn) {
            // 登录过期：停下来，重新连接后点“继续上传”
            job.state = "waiting";
            acc.noteError(e);
            break;
          }
          job.state = (e as Error).name === "AbortError" ? "waiting" : "failed";
          job.error = (e as Error).message;
        }
      }
    } finally {
      try {
        await acc.commitUploads();
      } catch (e) {
        // 文件已经在网盘上了，条目留在本机待写清单，下次打开时补写
        console.warn("写目录失败", e);
      }
      this.running = false;
      this.ctl = null;
    }
  }

  /** 还有没传的（取消、登录过期、需要解锁后） */
  get waiting() {
    return this.jobs.filter((j) => j.state === "waiting").length;
  }

  /** 解锁或重新连接后接着传 */
  resume() {
    if (!this.running && this.target && this.jobs.some((j) => j.state === "waiting")) void this.run();
  }
}

export const uploads = new Uploads();
