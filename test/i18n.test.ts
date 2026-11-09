import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { table } from "../src/lib/i18n-table";

// 界面里每一句 t("中文") 都要有繁体、英文、日文翻译
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|svelte)$/.test(e.name) && !e.name.startsWith("i18n") ? [join(dir, e.name)] : [],
  );
}

describe("i18n table", () => {
  it("covers every Chinese UI string", () => {
    const missing = new Set<string>();
    for (const f of sources(join(__dirname, "../src"))) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"|key: "((?:[^"\\]|\\.)*)"/g)) {
        const k = (m[1] ?? m[2])!;
        if (/[一-鿿]/.test(k) && !table[k]) missing.add(k);
      }
    }
    expect([...missing]).toEqual([]);
  });
  it("keeps placeholders in every translation", () => {
    for (const [k, v] of Object.entries(table)) {
      const want = (k.match(/\{\w+\}/g) ?? []).sort().join();
      for (const s of [v.en, v.ja, v["zh-Hant"]]) expect((s.match(/\{\w+\}/g) ?? []).sort().join(), `${k} → ${s}`).toBe(want);
    }
  });
});
