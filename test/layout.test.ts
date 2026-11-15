import { describe, expect, it } from "vitest";
import { legacyPlaces, place, placeDir } from "../src/lib/layout";

// 和安卓 DriveLayout.place 必须一致（spec/vault-layout.md v3）
describe("layout v3", () => {
  it("maps fixed files into settings", () => {
    expect(place(["vault", "keybundle.json"])).toEqual({ dir: "settings", rest: ["keybundle.json"] });
    expect(place(["vault", "index.zylc"])).toEqual({ dir: "settings", rest: ["index.zylc"] });
    expect(place(["index.json"])).toEqual({ dir: "settings", rest: ["index.json"] });
    expect(place(["vault", "index-broken-1.zylc"])).toEqual({ dir: "settings", rest: ["index-broken-1.zylc"] });
  });
  it("maps photos into albums", () => {
    expect(place(["vault", "ab.zylc"])).toEqual({ dir: "albums", rest: ["ab.zylc"] });
    expect(place(["vault", "t-ab.zylc"])).toEqual({ dir: "albums", rest: ["t-ab.zylc"] });
    expect(place([".thumbs", "x.jpg"])).toEqual({ dir: "albums", rest: [".thumbs", "x.jpg"] });
    expect(place(["相机", "IMG.jpg"])).toEqual({ dir: "albums", rest: ["相机", "IMG.jpg"] });
  });
  it("maps sharing", () => {
    expect(place(["共享", "a", "album.json"])).toEqual({ dir: "shared", rest: ["a", "album.json"] });
    expect(placeDir(["共享", "a"])).toEqual({ dir: "shared", rest: ["a"] });
    expect(placeDir(["共享", "links", "x"])).toEqual({ dir: "links", rest: ["x"] });
    expect(placeDir(["共享", "links"])).toEqual({ dir: "links", rest: [] });
  });
  it("keeps the storage marker at the root", () => {
    expect(place(["storage.json"])).toEqual({ dir: null, rest: ["storage.json"] });
  });
  it("knows where old copies of fixed files may be", () => {
    expect(legacyPlaces(["vault", "keybundle.json"])).toEqual([
      { dir: "albums", rest: ["keybundle.json"] },
      { dir: null, rest: ["vault", "keybundle.json"] },
    ]);
    expect(legacyPlaces(["index.json"])).toEqual([{ dir: null, rest: ["index.json"] }]);
    expect(legacyPlaces(["vault", "x.zylc"])).toEqual([]);
  });
});
