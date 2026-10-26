// Supabase project settings. Leave the URL empty to run on sample data.
// The publishable key is safe to ship in the page: row level security lets it read the calendar
// and add comments, and nothing else. Writing posts and reading stats need the editor's sign-in.
export const SUPABASE_URL = "https://bgqqnykoeegqclxelvmf.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_m-WlGWOvKs42liOCiM782Q_Nv_gY8kQ";

// Google's sign-in offers only accounts on this domain. Who can edit is decided by the
// public.editors table, not by this value.
export const EDITOR_DOMAIN = "silencio.network";
