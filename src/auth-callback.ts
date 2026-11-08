// 登录弹窗的回调页：把结果原样交给主页面（同源 BroadcastChannel），然后关掉自己。
// 不依赖 window.opener：登录页带 COOP 时它会被清空。
const ch = new BroadcastChannel("zyll-auth");
ch.postMessage({ search: location.search, hash: location.hash });
// 地址栏里的令牌立即清掉
history.replaceState(null, "", location.pathname);
setTimeout(() => {
  ch.close();
  window.close();
}, 300);
