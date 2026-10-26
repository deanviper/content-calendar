// Stats collector. Every run first looks for new posts on X and LinkedIn: a post that matches a
// calendar draft marks that draft as posted, anything else is added as a posted post. Then it stores
// a new snapshot for each posted post and the follower count of each account, so numbers build up
// over time and the first snapshot of a post is its baseline.
//
//   POST /functions/v1/collect-stats                   look back DISCOVER_DAYS for new posts, then
//                                                      snapshot posts published in the last LOOKBACK_DAYS
//   POST /functions/v1/collect-stats?mode=backfill     look for posts since a date instead
//        &since=2026-01-01                             (optional) how far back the backfill reaches
//
// Callers send either the header  x-collector-secret: <COLLECTOR_SECRET>  (the daily schedule) or a
// signed-in editor's session (the Resync button on the stats page).
//
// Secrets (supabase secrets set …):
//   COLLECTOR_SECRET                         required
//   X_BEARER_TOKEN, X_USERNAME               for X (X_USER_ID skips the username lookup)
//   LINKEDIN_ACCESS_TOKEN, LINKEDIN_ORG_ID   for LinkedIn (needs the r_organization_social scope)
//   LINKEDIN_VERSION                         optional, e.g. 202608
//   LOOKBACK_DAYS                            optional, default 90
//   DISCOVER_DAYS                            optional, default 7
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  type FoundPost,
  linkedInClient,
  linkedInVersion,
  type Platform,
  type PostMetrics,
  RateLimited,
  xClient,
} from "../_shared/platforms.ts";
import { type Draft, matchDraft } from "../_shared/match.ts";

interface PlatformResult {
  platform: Platform;
  skipped?: string;
  posted?: number;
  imported?: number;
  snapshots?: number;
  followers?: number;
  error?: string;
}

interface Source {
  platform: Platform;
  followers(): Promise<{ followers: number; raw: unknown }>;
  metrics(ids: string[]): Promise<PostMetrics[]>;
  discover(since?: string): Promise<FoundPost[]>;
}

const env = (name: string) => Deno.env.get(name) || undefined;

function sources(): { ready: Source[]; skipped: PlatformResult[] } {
  const ready: Source[] = [];
  const skipped: PlatformResult[] = [];

  const xToken = env("X_BEARER_TOKEN");
  const xUser = env("X_USER_ID");
  const xName = env("X_USERNAME");
  if (xToken && (xUser || xName)) {
    const x = xClient(xToken);
    let id: Promise<string> | undefined;
    const userId = () => (id ??= xUser ? Promise.resolve(xUser) : x.userId(xName!));
    ready.push({
      platform: "x",
      followers: async () => x.followers(await userId()),
      metrics: (ids) => x.metrics(ids),
      discover: async (since) => x.timeline(await userId(), since),
    });
  } else {
    skipped.push({ platform: "x", skipped: "X_BEARER_TOKEN and X_USERNAME are not set" });
  }

  const liToken = env("LINKEDIN_ACCESS_TOKEN");
  const liOrg = env("LINKEDIN_ORG_ID");
  if (liToken && liOrg) {
    const li = linkedInClient(liToken, liOrg, linkedInVersion(new Date(), env("LINKEDIN_VERSION")));
    ready.push({
      platform: "linkedin",
      followers: () => li.followers(),
      metrics: (ids) => li.metrics(ids),
      discover: (since) => li.posts(since),
    });
  } else {
    skipped.push({ platform: "linkedin", skipped: "LINKEDIN_ACCESS_TOKEN and LINKEDIN_ORG_ID are not set" });
  }

  return { ready, skipped };
}

// New live posts: each one that matches a draft marks that draft as posted, at the time it went
// out; the rest are added as posted posts. Posts already linked to a row are skipped.
async function syncPosts(db: SupabaseClient, platform: Platform, found: FoundPost[]): Promise<{ posted: number; imported: number }> {
  if (!found.length) return { posted: 0, imported: 0 };
  const { data: known, error } = await db.from("posts").select("external_id")
    .eq("platform", platform).in("external_id", found.map((p) => p.externalId));
  if (error) throw new Error(`reading posts: ${error.message}`);
  const seen = new Set(known.map((p) => p.external_id));
  const fresh = found.filter((p) => !seen.has(p.externalId));
  if (!fresh.length) return { posted: 0, imported: 0 };

  const { data: rows, error: de } = await db.from("posts").select("id, copy, hashtags, scheduled_at")
    .eq("platform", platform).neq("status", "published").is("external_id", null);
  if (de) throw new Error(`reading drafts: ${de.message}`);
  const drafts: Draft[] = rows.map((r) => ({ id: r.id, copy: r.copy, hashtags: r.hashtags, scheduledAt: r.scheduled_at }));

  let posted = 0;
  const unmatched: FoundPost[] = [];
  // Oldest first, so a draft goes to the first post that went out for it.
  for (const p of [...fresh].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))) {
    const draft = matchDraft({ copy: p.copy, publishedAt: p.publishedAt }, drafts);
    if (!draft) {
      unmatched.push(p);
      continue;
    }
    drafts.splice(drafts.indexOf(draft), 1);
    const { error: ue } = await db.from("posts").update({
      status: "published",
      scheduled_at: p.publishedAt,
      published_at: p.publishedAt,
      external_id: p.externalId,
      external_url: p.url,
    }).eq("id", draft.id);
    if (ue) throw new Error(`marking a draft posted: ${ue.message}`);
    posted++;
  }

  if (unmatched.length) {
    const { error: ie } = await db.from("posts").upsert(unmatched.map((p) => ({
      platform,
      status: "published",
      scheduled_at: p.publishedAt,
      published_at: p.publishedAt,
      copy: p.copy,
      external_id: p.externalId,
      external_url: p.url,
    })), { onConflict: "platform,external_id", ignoreDuplicates: true });
    if (ie) throw new Error(`saving new posts: ${ie.message}`);
  }
  return { posted, imported: unmatched.length };
}
async function collect(db: SupabaseClient, source: Source, capturedAt: string, opts: { backfill: boolean; since?: string; lookbackDays: number; discoverDays: number }): Promise<PlatformResult> {
  const result: PlatformResult = { platform: source.platform };

  const discoverFrom = opts.backfill ? opts.since : new Date(Date.now() - opts.discoverDays * 86_400_000).toISOString();
  Object.assign(result, await syncPosts(db, source.platform, await source.discover(discoverFrom)));

  const from = opts.backfill && opts.since
    ? opts.since
    : new Date(Date.now() - opts.lookbackDays * 86_400_000).toISOString();
  const { data: posts, error } = await db
    .from("posts")
    .select("id, external_id")
    .eq("platform", source.platform)
    .eq("status", "published")
    .not("external_id", "is", null)
    .gte("published_at", from);
  if (error) throw new Error(`reading posts: ${error.message}`);

  const byExternal = new Map(posts.map((p) => [p.external_id as string, p.id as string]));
  const metrics = byExternal.size ? await source.metrics([...byExternal.keys()]) : [];
  const snapshots = metrics
    .filter((m) => byExternal.has(m.externalId))
    .map((m) => ({
      post_id: byExternal.get(m.externalId),
      captured_at: capturedAt,
      source: "api",
      impressions: m.impressions,
      likes: m.likes,
      reposts: m.reposts,
      replies: m.replies,
      quotes: m.quotes,
      bookmarks: m.bookmarks,
      clicks: m.clicks,
      raw: m.raw,
    }));
  if (snapshots.length) {
    const { error: e } = await db.from("post_metric_snapshots")
      .upsert(snapshots, { onConflict: "post_id,captured_at", ignoreDuplicates: true });
    if (e) throw new Error(`saving post stats: ${e.message}`);
  }
  result.snapshots = snapshots.length;

  const f = await source.followers();
  const { error: fe } = await db.from("account_metric_snapshots").upsert(
    { platform: source.platform, captured_at: capturedAt, source: "api", followers: f.followers, raw: f.raw },
    { onConflict: "platform,captured_at", ignoreDuplicates: true },
  );
  if (fe) throw new Error(`saving followers: ${fe.message}`);
  result.followers = f.followers;

  return result;
}

// The stats page calls this from the browser.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-collector-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// The schedule sends the secret; the stats page sends the editor's session, checked against the
// editors table with the caller's own rights.
async function allowed(req: Request): Promise<boolean> {
  const secret = env("COLLECTOR_SECRET");
  if (secret && req.headers.get("x-collector-secret") === secret) return true;
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const asCaller = createClient(env("SUPABASE_URL")!, env("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  });
  const { data, error } = await asCaller.rpc("is_editor");
  return !error && data === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!(await allowed(req))) {
    return Response.json({ error: "send x-collector-secret or sign in as an editor" }, { status: 401, headers: CORS });
  }

  const url = new URL(req.url);
  const backfill = url.searchParams.get("mode") === "backfill";
  const since = url.searchParams.get("since") ?? undefined;
  if (since && Number.isNaN(Date.parse(since))) {
    return Response.json({ error: "since must be a date, e.g. 2026-01-01" }, { status: 400, headers: CORS });
  }
  const lookbackDays = Number(env("LOOKBACK_DAYS") ?? 90);
  const discoverDays = Number(env("DISCOVER_DAYS") ?? 7);

  const db = createClient(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // One timestamp per run, to the minute, so a retried run cannot double-count.
  const now = new Date();
  now.setUTCSeconds(0, 0);
  const capturedAt = now.toISOString();

  const { ready, skipped } = sources();
  // Platforms run side by side; one failing or hitting its rate limit does not stop the other.
  const results = await Promise.all(ready.map((s) =>
    collect(db, s, capturedAt, { backfill, since, lookbackDays, discoverDays }).catch((err): PlatformResult => ({
      platform: s.platform,
      error: err instanceof RateLimited ? `${err.message}; try again later` : String(err.message ?? err),
    }))
  ));

  const all = [...results, ...skipped];
  const failed = all.some((r) => r.error);
  return Response.json({ capturedAt, mode: backfill ? "backfill" : "collect", results: all }, { status: failed ? 207 : 200, headers: CORS });
});
