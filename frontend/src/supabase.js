import { SUPABASE_URL, SUPABASE_ANON_KEY, EDITOR_EMAIL } from "./config.js";
import { DRIVE_SCOPE, rememberDriveToken, forgetDriveToken } from "./drive.js";

export const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let client;

export async function db() {
  if (!configured) throw new Error("Supabase is not configured");
  if (!client) {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm");
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    // Google's token arrives only with the sign-in itself; Supabase drops it when the session
    // refreshes, so it is kept for the Drive uploads here.
    client.auth.onAuthStateChange((event, session) => {
      if (session?.provider_token) rememberDriveToken(session.provider_token);
      if (event === "SIGNED_OUT") forgetDriveToken();
    });
  }
  return client;
}

// Editing: only someone signed in with Google whose email is in public.editors. The page asks the
// database rather than trusting the email it sees, so the same rule guards the UI and the data.

export async function signInWithGoogle() {
  const supabase = await db();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: location.href,
      // Lets the calendar put photos and videos in the editor's Drive (see drive.js).
      scopes: DRIVE_SCOPE,
      // Pre-selects the editor account in Google's picker; it does not grant anything by itself.
      queryParams: { login_hint: EDITOR_EMAIL, prompt: "select_account", include_granted_scopes: "true" },
    },
  });
  if (error) throw error;
}

export async function signOut() {
  const supabase = await db();
  await supabase.auth.signOut();
}

// Returns { email } for a signed-in editor, { email, editor: false } for anyone else signed in,
// or null when nobody is. Sample mode has no accounts, so everyone is an editor there.
export async function currentUser() {
  if (!configured) return { email: "sample mode", editor: true };
  const supabase = await db();
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) return null;
  const { data: editor, error } = await supabase.rpc("is_editor");
  return { email: session.user.email, editor: !error && editor === true };
}

export async function onAuthChange(fn) {
  if (!configured) return;
  const supabase = await db();
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT") fn();
  });
}

// Resolves once an editor is signed in. Until then the page shows the Google sign-in screen.
// The stats page uses this; the calendar is open to anyone and offers sign-in only for editing.
export async function signedIn() {
  const user = await currentUser();
  if (user?.editor) return user;
  return new Promise(() => signInScreen(user));
}

function signInScreen(user) {
  const wrap = document.createElement("div");
  wrap.className = "signin";
  const card = document.createElement("div");
  card.className = "signin-card";
  const logo = document.createElement("img");
  logo.src = new URL("../assets/logo.svg", import.meta.url);
  logo.alt = "silencio";
  logo.height = 22;
  const title = document.createElement("h1");
  title.textContent = "Stats";
  const text = document.createElement("p");
  text.textContent = user
    ? `${user.email} can't see stats. Sign in with ${EDITOR_EMAIL}.`
    : "Sign in with your Silencio Google account.";
  const btn = document.createElement("button");
  btn.className = "pill primary";
  btn.type = "button";
  btn.textContent = "Continue with Google";
  btn.addEventListener("click", async () => {
    if (user) await signOut();
    await signInWithGoogle();
  });
  card.append(logo, title, text, btn);
  wrap.append(card);
  document.body.append(wrap);
  return wrap;
}
