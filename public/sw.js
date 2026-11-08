// Zyll 网页版的 Service Worker：只做一件事，让 <video> 边下边播网盘里的视频。
// 加密视频按 ZYLC 块（64 KiB）随取随解密（spec/crypto-format.md），明文视频直接转发 Range 请求（补上 Authorization）。
// 密钥只在内存里：页面通过 postMessage 交给它，Service Worker 被浏览器回收后再向页面要。
const streams = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
  const m = e.data;
  if (m?.type === "stream") streams.set(m.token, m.info);
  if (m?.type === "drop") streams.delete(m.token);
  if (m?.type === "clear") streams.clear();
});

const MAX_SPAN = 4 * 1024 * 1024;

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const at = url.pathname.lastIndexOf("/__zyll_stream/");
  if (at < 0 || url.origin !== location.origin) return;
  const token = url.pathname.slice(at + "/__zyll_stream/".length);
  e.respondWith(serve(token, e.request, e.clientId || e.resultingClientId));
});

async function infoFor(token, clientId) {
  if (streams.has(token)) return streams.get(token);
  // 被回收过：向页面要回来
  const list = await self.clients.matchAll({ type: "window" });
  const ordered = list.sort((a, b) => (a.id === clientId ? -1 : b.id === clientId ? 1 : 0));
  for (const c of ordered) {
    const info = await new Promise((resolve) => {
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve(null), 3000);
      ch.port1.onmessage = (ev) => {
        clearTimeout(t);
        resolve(ev.data);
      };
      c.postMessage({ type: "need-stream", token }, [ch.port2]);
    });
    if (info) {
      streams.set(token, info);
      return info;
    }
  }
  return null;
}

function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h || "");
  if (!m) return [0, Math.min(size, MAX_SPAN) - 1];
  let start, end;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return [start, Math.min(end, start + MAX_SPAN - 1)];
}

function u64(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v));
  return b;
}

async function serve(token, req, clientId) {
  const info = await infoFor(token, clientId);
  if (!info) return new Response("expired", { status: 410 });
  const size = info.plainLen;
  if (size === 0) return new Response(new Uint8Array(0), { status: 200, headers: { "Content-Type": info.mime } });
  const [start, end] = parseRange(req.headers.get("Range"), size);
  if (start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  try {
    const body = info.encrypted ? await decryptRange(info, start, end) : await fetchRange(info, start, end);
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Type": info.mime,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return new Response(String(err), { status: 502 });
  }
}

async function fetchRange(info, a, b) {
  const r = await fetch(info.url, { headers: { ...info.headers, Range: `bytes=${a}-${b}` } });
  if (r.status === 401) {
    streams.delete(info.token);
    throw new Error("登录已过期");
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  // 服务器不支持 Range 时返回整个文件：自己截取
  return r.status === 206 ? buf : buf.subarray(a, b + 1);
}

async function decryptRange(info, a, b) {
  const { chunkSize: C, chunkCount: n, headerLen: H } = info;
  const stride = C + 16;
  const i0 = Math.floor(a / C);
  const i1 = Math.floor(b / C);
  const lastLen = (i) => Math.min(C, info.plainLen - i * C) + 16;
  const from = H + i0 * stride;
  const to = H + i1 * stride + lastLen(i1) - 1;
  const ct = await fetchRange(info, from, to);
  const out = new Uint8Array((i1 - i0) * C + lastLen(i1) - 16);
  const jobs = [];
  for (let i = i0; i <= i1; i++) {
    const off = (i - i0) * stride;
    const part = ct.subarray(off, off + lastLen(i));
    const nonce = new Uint8Array(12);
    nonce.set(u64(i), 4);
    const aad = new Uint8Array(info.headerHash.length + 9);
    aad.set(info.headerHash, 0);
    aad.set(u64(i), info.headerHash.length);
    aad[aad.length - 1] = i === n - 1 ? 1 : 0;
    jobs.push(
      crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, info.dek, part)
        .then((pt) => out.set(new Uint8Array(pt), (i - i0) * C)),
    );
  }
  await Promise.all(jobs);
  const base = i0 * C;
  return out.subarray(a - base, b - base + 1);
}
