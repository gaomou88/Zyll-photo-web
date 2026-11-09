import { describe, expect, it } from "vitest";
import { applyChange, mergeDocs, parseIndex, serializeIndex, type IndexItem } from "../src/lib/indexdoc";

const item = (r: string, extra: Partial<IndexItem> = {}): IndexItem => ({
  r, e: false, n: `${r}.jpg`, a: "相机", m: "image/jpeg", t: 1, s: 10, h: `h${r}`, th: `t${r}`, d: "phone", k: "", ...extra,
});

const doc = (o: Record<string, unknown>) => parseIndex(JSON.stringify(o));

describe("备份目录", () => {
  it("读安卓写的目录，未知字段忽略，缺字段给默认值", () => {
    const d = doc({ v: 2, seq: 5, items: [{ r: "a", e: true, n: "x.jpg", extra: 1 }], del: ["z"], trash: ["q"], mode: { enc: true, at: 9 }, settings: { backup: {} } });
    expect(d.seq).toBe(5);
    expect(d.items[0]).toMatchObject({ r: "a", e: true, n: "x.jpg", a: "", th: "", k: "" });
    expect(d.mode).toEqual({ enc: true, at: 9 });
    expect(d.settings).toEqual({ backup: {} });
  });

  it("动态照片标记 mo：只认 true，写回时保留，没有就不写", () => {
    const d = doc({ seq: 1, items: [{ r: "a", mo: true }, { r: "b", mo: 1 }, { r: "c" }] });
    expect(d.items.map((i) => i.mo)).toEqual([true, undefined, undefined]);
    const out = JSON.parse(serializeIndex(mergeDocs([d]), 2, true)) as { items: Record<string, unknown>[] };
    expect(out.items.map((i) => "mo" in i)).toEqual([true, false, false]);
    expect(out.items[0]!.mo).toBe(true);
  });

  it("格式不对时报损坏", () => {
    expect(() => parseIndex("{")).toThrow();
    expect(() => parseIndex("[]")).toThrow();
    expect(() => parseIndex(JSON.stringify({ items: 3 }))).toThrow();
  });

  it("合并：新的那份优先，墓碑里的去掉，trash 取并集", () => {
    const older = doc({ seq: 3, items: [item("a", { n: "old.jpg" }), item("b")], del: [], trash: ["x"] });
    const newer = doc({ seq: 7, items: [item("a", { n: "new.jpg" })], del: ["b"], trash: ["y"], mode: { enc: false, at: 1 } });
    const m = mergeDocs([older, newer]);
    expect(m.seq).toBe(7);
    expect(m.items.map((i) => i.n)).toEqual(["new.jpg"]);
    expect([...m.trash].sort()).toEqual(["x", "y"]);
    expect(m.mode).toEqual({ enc: false, at: 1 });
  });

  it("改动：新增、删除写墓碑，在用的文件不进待删除", () => {
    const m = mergeDocs([doc({ seq: 1, items: [item("a"), item("b")] })]);
    const n = applyChange(m, { add: [item("c", { d: "web-1", th: "ta" })], remove: ["b"], trash: ["b", "tb", "ta"] });
    expect(n.items.map((i) => i.r)).toEqual(["a", "c"]);
    expect(n.delList).toEqual(["b"]);
    // ta 还被 a 和 c 用着
    expect([...n.trash].sort()).toEqual(["b", "tb"]);
    const done = applyChange(n, { trashDone: ["b"] });
    expect([...done.trash]).toEqual(["tb"]);
  });

  it("已经删掉的文件不会被重新加回来", () => {
    const m = mergeDocs([doc({ seq: 1, items: [], del: ["a"] })]);
    expect(applyChange(m, { add: [item("a")] }).items).toEqual([]);
  });

  it("写明文目录时不写加密条目；保留 mode 和 settings；k 只在有值时写", () => {
    const m = mergeDocs([doc({ seq: 4, items: [item("a"), item("b", { e: true, k: "old" })], mode: { enc: true, at: 2 }, settings: { s: 1 } })]);
    const plain = JSON.parse(serializeIndex(m, 5, false));
    expect(plain.items.map((i: IndexItem) => i.r)).toEqual(["a"]);
    expect(plain.items[0]).not.toHaveProperty("k");
    const enc = JSON.parse(serializeIndex(m, 5, true));
    expect(enc).toMatchObject({ v: 2, seq: 5, mode: { enc: true, at: 2 }, settings: { s: 1 } });
    expect(enc.items[1].k).toBe("old");
    // 再读回来和原来一致
    expect(parseIndex(serializeIndex(m, 5, true)).items).toEqual(m.items);
  });
});
