import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";

// base 用相对路径：部署到 https://<user>.github.io/<repo>/ 或自定义域名都能用
export default defineConfig({
  base: "./",
  plugins: [svelte()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    rollupOptions: {
      input: { main: resolve(__dirname, "index.html"), callback: resolve(__dirname, "auth-callback.html"), link: resolve(__dirname, "s/index.html") },
    },
  },
});
