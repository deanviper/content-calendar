// Stats collector. Every run stores a new snapshot for each published post and the follower count of
// each account, so numbers build up over time and the first snapshot of a post is its baseline.
//
//   POST /functions/v1/collect-stats                   snapshot posts published in the last LOOKBACK_DAYS
//   POST /functions/v1/collect-stats?mode=backfill     also pull past posts from X and LinkedIn first
//        &since=2026-01-01                             (optional) how far back the backfill reaches
//
// Callers must send the header  x-collector-secret: <COLLECTOR_SECRET>.
//
// Secrets (supabase secrets set …):
//   COLLECTOR_SECRET                         required
//   X_BEARER_TOKEN, X_USERNAME               for X (X_USER_ID skips the username lookup)
//   LINKEDIN_ACCESS_TOKEN, LINKEDIN_ORG_ID   for LinkedIn (needs the r_organization_social scope)
//   LINKEDIN_VERSION                         optional, e.g. 202608
//   LOOKBACK_DAYS                            optional, default 90
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

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

interface PlatformResult {
  platform: Platform;
  skipped?: string;
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

async function importPosts(db: SupabaseClient, platform: Platform, found: FoundPost[]): Promise<number> {
  if (!found.length) return 0;
  const rows = found.map((p) => ({
    platform,
    status: "published",
    scheduled_at: p.publishedAt,
    published_at: p.publishedAt,
    copy: p.copy,
    external_id: p.externalId,
    external_url: p.url,
  }));
  // Posts already in the table, planned here or imported before, are left as they are.
  const { error } = await db.from("posts").upsert(rows, { onConflict: "platform,external_id", ignoreDuplicates: true });
  if (error) throw new Error(`saving imported posts: ${error.message}`);
  return rows.length;
}

async function collect(db: SupabaseClient, source: Source, capturedAt: string, opts: { backfill: boolean; since?: string; lookbackDays: number }): Promise<PlatformResult> {
  const result: PlatformResult = { platform: source.platform };

  if (opts.backfill) result.imported = await importPosts(db, source.platform, await source.discover(opts.since));

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

Deno.serve(async (req) => {
  const secret = env("COLLECTOR_SECRET");
  if (!secret || req.headers.get("x-collector-secret") !== secret) {
    return Response.json({ error: "missing or wrong x-collector-secret" }, { status: 401 });
  }

  const url = new URL(req.url);
  const backfill = url.searchParams.get("mode") === "backfill";
  const since = url.searchParams.get("since") ?? undefined;
  if (since && Number.isNaN(Date.parse(since))) {
    return Response.json({ error: "since must be a date, e.g. 2026-01-01" }, { status: 400 });
  }
  const lookbackDays = Number(env("LOOKBACK_DAYS") ?? 90);

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
    collect(db, s, capturedAt, { backfill, since, lookbackDays }).catch((err): PlatformResult => ({
      platform: s.platform,
      error: err instanceof RateLimited ? `${err.message}; try again later` : String(err.message ?? err),
    }))
  ));

  const all = [...results, ...skipped];
  const failed = all.some((r) => r.error);
  return Response.json({ capturedAt, mode: backfill ? "backfill" : "collect", results: all }, { status: failed ? 207 : 200 });
});
