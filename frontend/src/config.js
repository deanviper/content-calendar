// Supabase project settings. Leave the URL empty to run on sample data.
// The publishable key is safe to ship in the page: row level security lets it read the calendar
// and add comments, and nothing else. Writing posts and reading stats need the editor's sign-in.
export const SUPABASE_URL = "https://bgqqnykoeegqclxelvmf.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_m-WlGWOvKs42liOCiM782Q_Nv_gY8kQ";

// Shown as the suggested account on Google's sign-in screen. Who can edit is decided by the
// public.editors table, not by this value.
export const EDITOR_EMAIL = "joaquin@silencio.network";

// The Google OAuth client the calendar uses for Drive uploads (the same one Supabase signs in with).
export const GOOGLE_CLIENT_ID = "483579615338-h1pkoge220mclr3v01p3kbf6d7femrta.apps.googleusercontent.com";
