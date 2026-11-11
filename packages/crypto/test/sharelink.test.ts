import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ZyllCryptoError, fromBase64, fromHex, toHex } from "../src/primitives";
import * as sl from "../src/sharelink";

/** 读取 Kotlin 端生成的 share-link.json：两端必须逐字节一致。 */
const dir = fileURLToPath(new URL("../../../spec/test-vectors/", import.meta.url));
const v = JSON.parse(readFileSync(dir + "share-link.json", "utf8"));

describe("share link", () => {
  it("salt + key + manifest", async () => {
    const secret = fromHex(v.secret);
    expect(toHex(await sl.salt(secret))).toBe(v.salt);
    const k = await sl.linkKeyBytes(secret, v.password);
    expect(toHex(k)).toBe(v.linkKey);
    expect(await sl.openManifest(fromHex(v.manifestSealed), k)).toEqual(fromBase64(v.manifestPlain));
    expect(sl.parseManifest(fromBase64(v.manifestPlain)).id).toBe("00112233445566778899aabbccddeeff");
  }, 30_000);

  it("wrong password fails", async () => {
    const k = await sl.linkKeyBytes(fromHex(v.secret), v.password + "!");
    await expect(sl.openManifest(fromHex(v.manifestSealed), k)).rejects.toThrow();
  }, 30_000);

  it("fragments", () => {
    const g = sl.parseFragment("#" + v.fragmentGoogle);
    expect(g.provider).toBe("g");
    expect(toHex(g.secret)).toBe(v.secret);
    expect(sl.encodeFragment(g)).toBe(v.fragmentGoogle);
    const o = sl.parseFragment(v.fragmentOneDrive);
    expect(sl.decodeUrlLoc(o.loc)).toBe(v.oneDriveUrl);
    expect(sl.encodeUrlLoc(v.oneDriveUrl)).toBe(o.loc);
    for (const bad of ["", "2" + v.fragmentGoogle.slice(1), v.fragmentGoogle.replace(".g.", ".x."), v.fragmentGoogle + ".x", v.fragmentGoogle.slice(0, -2), v.fragmentGoogle.replace("1AbC", "1A/C")]) {
      expect(() => sl.parseFragment(bad)).toThrow(ZyllCryptoError);
    }
  });
});
