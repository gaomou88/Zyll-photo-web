import { mount } from "svelte";
import LinkView from "./LinkView.svelte";
import { t } from "../lib/i18n";
import "../app.css";

// 外链分享页：先把 # 后面的部分取出来，马上从地址栏去掉（不留在浏览器历史、截图和书签里）。
// 同时存进 sessionStorage（只在这个标签页里，关掉就没了）：刷新、或者页面在后台被浏览器回收后重新加载，照样能打开
const KEY = "zyll-link";

function stored(): string {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

const fromHash = location.hash.slice(1);
const fragment = fromHash || stored();
if (fromHash) {
  history.replaceState(null, "", location.pathname + location.search);
  try {
    sessionStorage.setItem(KEY, fromHash);
  } catch {
    // 隐私模式等存不了：只是刷新后要重新点链接
  }
}

function framed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

const target = document.getElementById("app")!;
if (framed()) {
  // 不允许被嵌进别的网站（骗用户在别人的页面里输密码）：只给一句说明
  const p = document.createElement("p");
  p.style.cssText = "max-width:420px;margin:12vh auto 0;padding:0 16px;text-align:center;line-height:1.6";
  p.textContent = t("请直接在浏览器里打开这个链接。");
  target.append(p);
} else {
  mount(LinkView, { target, props: { fragment, forget: () => { try { sessionStorage.removeItem(KEY); } catch { /* 无 */ } } } });
}
