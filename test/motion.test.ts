import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blobReader, findMotionVideo, livePairKey, xmpTailLengths } from "../src/lib/motion";

const dir = new URL("../spec/test-vectors/motion/", import.meta.url);
const spec = JSON.parse(readFileSync(new URL("motion.json", dir), "utf8")) as {
  vectors: { file: string; size: number; quick: unknown; scan: unknown }[];
};

describe("findMotionVideo（共用测试向量）", () => {
  for (const v of spec.vectors) {
    it(v.file, async () => {
      const b = new Blob([readFileSync(new URL(v.file, dir))]);
      expect(b.size).toBe(v.size);
      expect(await findMotionVideo(blobReader(b), b.size, false)).toEqual(v.quick);
      expect(await findMotionVideo(blobReader(b), b.size, true)).toEqual(v.scan);
    });
  }
});

describe("xmpTailLengths", () => {
  it("只取视频那一项的长度", () => {
    const x = '<rdf:li><Container:Item Item:Mime="image/jpeg" Item:Length="0"/></rdf:li><rdf:li><Container:Item Item:Mime="video/mp4" Item:Length="1234"/></rdf:li>';
    expect(xmpTailLengths(x)).toEqual([1234]);
  });
  it("新旧写法都有时按出现顺序、去重", () => {
    expect(xmpTailLengths('GCamera:MicroVideoOffset="99" <rdf:li Item:Semantic="MotionPhoto" Item:Length="99"/></rdf:li>')).toEqual([99]);
  });
});

describe("livePairKey", () => {
  it("同相簿同名的 HEIC 和 MOV 配成一对", () => {
    const a = livePairKey("相机", "IMG_1234.HEIC", "image/heic");
    const b = livePairKey("相机", "img_1234.mov", "video/quicktime");
    expect(a?.still).toBe(true);
    expect(b?.still).toBe(false);
    expect(a?.key).toBe(b?.key);
  });
  it("别的相簿、MP4、没有扩展名的不配", () => {
    expect(livePairKey("A", "IMG_1.HEIC", "image/heic")?.key).not.toBe(livePairKey("B", "IMG_1.MOV", "video/quicktime")?.key);
    expect(livePairKey("A", "IMG_1.MP4", "video/mp4")).toBeNull();
    expect(livePairKey("A", "IMG", "image/jpeg")).toBeNull();
  });
});
