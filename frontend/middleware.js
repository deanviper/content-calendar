// Password gate for the whole site. It runs on Vercel before any file is served (Routing Middleware),
// so nothing reaches the browser until the password is right: not the page, not the scripts, not the
// Supabase key. The password and the signing secret are Vercel environment variables, never in the
// code: CALENDAR_PASSWORD and CALENDAR_SESSION_SECRET. A correct password sets a signed, HttpOnly
// cookie that lasts 48 hours. Changing the password signs everyone out. Without both variables the
// site stays closed.

export const config = { matcher: "/((?!favicon\\.ico$).*)" };

const COOKIE = "cal_session";
const MAX_AGE = 48 * 60 * 60;
const LOGIN = "/__login";
const enc = new TextEncoder();

async function sign(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Compares two equal-length strings in time that doesn't depend on where they differ.
function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The session is "<expiry>.<signature>"; the signature covers the expiry and the current password.
async function session(env, exp) {
  return `${exp}.${await sign(env.secret, `session:${exp}:${env.password}`)}`;
}

async function signedIn(request, env) {
  const raw = (request.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const value = raw.slice(COOKIE.length + 1);
  const exp = Number(value.split(".")[0]);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return same(value, await session(env, exp));
}

// Only same-site paths, so the login can't be used to send someone elsewhere.
function safeNext(next) {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

function page(body, status) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "x-frame-options": "DENY",
    },
  });
}

function loginPage(next, failed) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return page(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Content calendar · Silencio</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a0a; color: #f2f2f2;
         font: 15px/1.5 Geist, system-ui, -apple-system, "Segoe UI", sans-serif; }
  form { display: grid; gap: 12px; width: min(340px, calc(100% - 32px)); padding: 32px; border-radius: 16px; background: #111111; }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
  p { margin: 0; color: #9a9a9a; font-size: 14px; }
  input { padding: 11px 14px; border: 1px solid #2a2a2a; border-radius: 999px; background: #0a0a0a; color: inherit; font: inherit; }
  input:focus { outline: 2px solid #3b82f6; outline-offset: 1px; }
  button { padding: 11px 14px; border: 0; border-radius: 999px; background: #f2f2f2; color: #0a0a0a; font: inherit; font-weight: 600; cursor: pointer; }
  .err { color: #f87171; }
</style></head>
<body><form method="post" action="${LOGIN}">
  <h1>Content calendar</h1>
  <p>Silencio team only. Enter the password to continue.</p>
  ${failed ? '<p class="err" role="alert">That password is not right.</p>' : ""}
  <input type="password" name="password" aria-label="Password" placeholder="Password" autocomplete="current-password" required autofocus>
  <input type="hidden" name="next" value="${esc(next)}">
  <button type="submit">Enter</button>
</form>
<script>document.querySelector('[name=next]').value += location.hash;</script>
</body></html>`, 401);
}

export default async function middleware(request) {
  const env = { password: process.env.CALENDAR_PASSWORD, secret: process.env.CALENDAR_SESSION_SECRET };
  if (!env.password || !env.secret) return page("<!doctype html><title>Closed</title><p>The calendar is closed: its password is not set up.</p>", 503);

  const url = new URL(request.url);
  if (url.pathname === LOGIN && request.method === "POST") {
    const form = await request.formData();
    const given = String(form.get("password") ?? "");
    const next = safeNext(String(form.get("next") ?? "/"));
    // Compare signatures rather than the strings, so the check takes the same time for any guess.
    if (same(await sign(env.secret, `pw:${given}`), await sign(env.secret, `pw:${env.password}`))) {
      const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
      return new Response(null, {
        status: 303,
        headers: {
          location: next,
          "cache-control": "no-store",
          "set-cookie": `${COOKIE}=${await session(env, exp)}; Max-Age=${MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }
    await new Promise((r) => setTimeout(r, 800));   // slows down guessing
    return loginPage(next, true);
  }

  if (await signedIn(request, env)) return new Response(null, { headers: { "x-middleware-next": "1" } });
  return loginPage(url.pathname === LOGIN ? "/" : url.pathname + url.search, false);
}
