import { describe, expect, it } from "vitest";
import { mp4CreationTime } from "../src/lib/media";

function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

describe("mp4CreationTime", () => {
  it("reads mvhd creation time after mdat", async () => {
    const when = Date.UTC(2024, 4, 1, 12, 0, 0);
    const mvhd = new Uint8Array(100);
    new DataView(mvhd.buffer).setUint32(4, when / 1000 + 2082844800);
    const file = new Blob([box("ftyp", new Uint8Array(8)), box("mdat", new Uint8Array(1000)), box("moov", box("mvhd", mvhd))]);
    expect(await mp4CreationTime(file)).toBe(when);
  });
  it("returns null for zero time or non-mp4", async () => {
    const file = new Blob([box("moov", box("mvhd", new Uint8Array(100)))]);
    expect(await mp4CreationTime(file)).toBeNull();
    expect(await mp4CreationTime(new Blob([new Uint8Array(3)]))).toBeNull();
  });
});
