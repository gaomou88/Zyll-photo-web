import { GOOGLE_CLIENT_ID, GOOGLE_SCOPES, ONEDRIVE_CLIENT_ID, ONEDRIVE_SCOPES, redirectUri } from "./config";

/**
 * 纯前端登录（没有自建服务器）。
 * - Google：网页应用只能拿到 1 小时左右的访问令牌（拿不到刷新令牌），过期后点一下“续期”，弹窗会自动关掉。
 * - OneDrive：授权码 + PKCE（单页应用平台），刷新令牌 24 小时内有效，期间自动续期。
 * 登录都在弹窗里完成，主页面不跳走，解锁后的密钥留在内存里不受影响。
 * 令牌存在 localStorage（只能访问 Zyll 自己的文件夹）；主密钥从不落盘。
 */

export type DriveKind = "google" | "onedrive";

export interface StoredAccount {
  /** 本机里的唯一标识：kind + 账号 id。 */
  key: string;
  kind: DriveKind;
  accountId: string;
  email: string;
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

const STORE = "zyll-accounts";

export class NeedsSignIn extends Error {
  constructor(readonly account: StoredAccount, message = "登录已过期，请重新连接") {
    super(message);
  }
}

export class AuthCancelled extends Error {
  constructor() {
    super("登录已取消");
  }
}

export function loadAccounts(): StoredAccount[] {
  try {
    const raw = localStorage.getItem(STORE);
    const list = raw ? (JSON.parse(raw) as StoredAccount[]) : [];
    return Array.isArray(list) ? list.filter((a) => a && typeof a.key === "string") : [];
  } catch {
    return [];
  }
}

export function saveAccount(a: StoredAccount) {
  const list = loadAccounts().filter((x) => x.key !== a.key);
  list.push(a);
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    // 隐私模式等存不了：这次会话照样能用
  }
}

export function removeAccount(key: string) {
  try {
    localStorage.setItem(STORE, JSON.stringify(loadAccounts().filter((x) => x.key !== key)));
  } catch {
    /* ignore */
  }
}

export const configured = (kind: DriveKind) => (kind === "google" ? GOOGLE_CLIENT_ID : ONEDRIVE_CLIENT_ID).length > 0;

function randomString(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let cancelPending: (() => void) | null = null;

/** 取消正在等待的登录弹窗。 */
export function cancelSignIn() {
  cancelPending?.();
}

/** 打开登录弹窗，等回调页把结果（查询串 + 片段）广播回来。 */
function popup(url: string, state: string): Promise<URLSearchParams> {
  const w = window.open(url, "zyll-auth", "popup,width=520,height=680");
  if (!w) return Promise.reject(new Error("浏览器拦截了登录窗口，请允许本网站弹出窗口后再试"));
  return new Promise((resolve, reject) => {
    const ch = new BroadcastChannel("zyll-auth");
    // 不轮询 w.closed：Google / 微软的登录页带 COOP，跨源后 closed 会误报
    const timer = setTimeout(() => done(new Error("登录超时，请重试")), 10 * 60_000);
    const done = (err: Error | null, p?: URLSearchParams) => {
      clearTimeout(timer);
      ch.close();
      cancelPending = null;
      try {
        w.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(p!);
    };
    cancelPending = () => done(new AuthCancelled());
    ch.onmessage = (e: MessageEvent<{ search: string; hash: string }>) => {
      const p = new URLSearchParams(e.data.search);
      new URLSearchParams(e.data.hash.replace(/^#/, "")).forEach((v, k) => p.set(k, v));
      if (p.get("state") !== state) return;
      done(null, p);
    };
  });
}

// ---------------- Google ----------------

async function googleToken(loginHint?: string, silent = false): Promise<{ token: string; expiresAt: number }> {
  const state = randomString(16);
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "token");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  // 续期：不带 prompt，已经同意过、只登录了这一个账号时会直接返回；需要时 Google 自己会让用户选账号
  if (!silent) u.searchParams.set("prompt", "select_account");
  const p = await popup(u.toString(), state);
  const err = p.get("error");
  if (err) throw new Error(err === "access_denied" ? "没有授权，已取消" : `Google 登录失败：${err}`);
  const token = p.get("access_token");
  if (!token) throw new Error("Google 没有返回访问令牌");
  const granted = (p.get("scope") ?? "").split(" ");
  if (!granted.includes(GOOGLE_SCOPES[0]!)) {
    throw new Error("需要勾选“查看和管理 Zyll 在 Google 云端硬盘中的应用数据”才能读取手机的备份，请重新连接并勾选");
  }
  return { token, expiresAt: Date.now() + (Number(p.get("expires_in") ?? 3600) - 120) * 1000 };
}

async function googleProfile(token: string): Promise<{ id: string; email: string }> {
  const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,permissionId)", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`读取 Google 账号失败（HTTP ${r.status}）`);
  const o = await r.json();
  return { id: o.user?.permissionId ?? "", email: o.user?.emailAddress ?? "" };
}

// ---------------- OneDrive ----------------

const MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0";

async function msTokenRequest(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const r = await fetch(`${MS_AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: ONEDRIVE_CLIENT_ID, scope: ONEDRIVE_SCOPES.join(" "), ...body }),
  });
  const o = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(o.error_description?.split("\r\n")[0] ?? `微软登录失败（HTTP ${r.status}）`) as Error & { code?: string };
    e.code = o.error;
    throw e;
  }
  return o;
}

async function oneDriveSignIn(loginHint?: string) {
  const state = randomString(16);
  const verifier = randomString(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const u = new URL(`${MS_AUTH}/authorize`);
  u.searchParams.set("client_id", ONEDRIVE_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", ONEDRIVE_SCOPES.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  const p = await popup(u.toString(), state);
  const err = p.get("error");
  if (err) throw new Error(err === "access_denied" ? "没有授权，已取消" : `微软登录失败：${p.get("error_description") ?? err}`);
  const code = p.get("code");
  if (!code) throw new Error("微软没有返回授权码");
  return msTokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: verifier });
}

async function oneDriveProfile(token: string): Promise<{ id: string; email: string }> {
  const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`读取微软账号失败（HTTP ${r.status}）`);
  const o = await r.json();
  return { id: o.id ?? "", email: o.mail || o.userPrincipalName || o.displayName || "" };
}

// ---------------- 公共 ----------------

/** 连接一个新账号（或重新连接已有账号），返回保存好的账号。 */
export async function signIn(kind: DriveKind, existing?: StoredAccount): Promise<StoredAccount> {
  if (!configured(kind)) throw new Error("这个网页版没有配置该网盘的客户端 ID");
  let acc: StoredAccount;
  if (kind === "google") {
    const t = await googleToken(existing?.email, !!existing);
    const me = await googleProfile(t.token);
    acc = { key: `google:${me.id}`, kind, accountId: me.id, email: me.email, accessToken: t.token, expiresAt: t.expiresAt };
  } else {
    const t = await oneDriveSignIn(existing?.email);
    const me = await oneDriveProfile(t.access_token);
    acc = {
      key: `onedrive:${me.id}`, kind, accountId: me.id, email: me.email,
      accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (t.expires_in - 120) * 1000,
    };
  }
  if (existing && existing.key !== acc.key) throw new Error(`登录的是另一个账号（${acc.email}），请用 ${existing.email} 登录`);
  saveAccount(acc);
  return acc;
}

const refreshing = new Map<string, Promise<StoredAccount>>();

/** 拿一个有效的访问令牌；Google 过期或 OneDrive 刷新令牌失效时抛 [NeedsSignIn]，界面据此提示“续期”。 */
export async function accessToken(acc: StoredAccount): Promise<string> {
  if (Date.now() < acc.expiresAt) return acc.accessToken;
  if (acc.kind === "google" || !acc.refreshToken) throw new NeedsSignIn(acc);
  let job = refreshing.get(acc.key);
  if (!job) {
    job = (async () => {
      try {
        const t = await msTokenRequest({ grant_type: "refresh_token", refresh_token: acc.refreshToken! });
        acc.accessToken = t.access_token;
        acc.refreshToken = t.refresh_token ?? acc.refreshToken;
        acc.expiresAt = Date.now() + (t.expires_in - 120) * 1000;
        saveAccount(acc);
        return acc;
      } catch (e) {
        if ((e as { code?: string }).code === "invalid_grant") throw new NeedsSignIn(acc);
        throw e;
      } finally {
        refreshing.delete(acc.key);
      }
    })();
    refreshing.set(acc.key, job);
  }
  return (await job).accessToken;
}

/** 令牌被服务器拒绝（401）：标记过期，下次走续期。 */
export function invalidate(acc: StoredAccount) {
  acc.expiresAt = 0;
  saveAccount(acc);
}
