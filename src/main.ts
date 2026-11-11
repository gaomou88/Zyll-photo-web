import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

// 不允许被嵌进别的网站（GitHub Pages 不能设 frame-ancestors 响应头，CSP 的 meta 标签也不支持它）：
// 被放进 iframe 时不渲染，并尝试让最外层直接打开本站
function framed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

let app: ReturnType<typeof mount> | undefined;
if (framed()) {
  try {
    window.top!.location.href = location.href;
  } catch {
    /* 跨站时改不了，至少不渲染 */
  }
} else {
  app = mount(App, { target: document.getElementById("app")! });
}
export default app;
