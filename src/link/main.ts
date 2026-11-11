import { mount } from "svelte";
import LinkView from "./LinkView.svelte";
import "../app.css";

// 外链分享页：先把 # 后面的部分取出来，马上从地址栏去掉（不留在浏览器历史、截图和书签里）
const fragment = location.hash.slice(1);
if (fragment) history.replaceState(null, "", location.pathname + location.search);

function framed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

// 不允许被嵌进别的网站：骗用户在别人的页面里输密码
if (!framed()) mount(LinkView, { target: document.getElementById("app")!, props: { fragment } });
