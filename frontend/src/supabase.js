import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let client;

export async function db() {
  if (!configured) throw new Error("Supabase is not configured");
  if (!client) {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return client;
}

// Resolves once someone is signed in. Until then the page shows an email sign-in link form.
// Only the stats page asks for this; the calendar is open to anyone with the link.
export async function signedIn() {
  const supabase = await db();
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  return new Promise((resolve) => {
    const screen = signInScreen(supabase);
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) return;
      sub.subscription.unsubscribe();
      screen.remove();
      resolve(session);
    });
  });
}

function signInScreen(supabase) {
  const wrap = document.createElement("div");
  wrap.className = "signin";
  wrap.innerHTML = `
    <form class="signin-card">
      <img src="${new URL("../assets/logo.svg", import.meta.url)}" alt="silencio" height="24">
      <h1>Sign in</h1>
      <p>We'll email you a link. Stats are for Silencio editors only.</p>
      <label for="signin-email">Work email</label>
      <input id="signin-email" type="email" autocomplete="email" required>
      <button class="pill-btn primary" type="submit">Email me a sign-in link</button>
      <p class="signin-msg" role="status"></p>
    </form>`;
  const form = wrap.querySelector("form");
  const msg = wrap.querySelector(".signin-msg");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.querySelector("input").value.trim();
    msg.textContent = "Sending…";
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.href, shouldCreateUser: true },
    });
    msg.textContent = error ? `Couldn't send the link: ${error.message}` : `Check ${email} for the sign-in link.`;
  });
  document.body.append(wrap);
  return wrap;
}
