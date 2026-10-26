// Data for the stats page.
//
// loadStats() returns
//   posts:     [{ id, platform, copy, url, publishedAt, impressions, engagements, rate,
//                 baselineImpressions, baselineAt, snapshots }]         one row per published post
//   daily:     [{ day: "YYYY-MM-DD", platform, impressions, engagements }]  running totals at day end
//   followers: [{ day, platform, followers }]
//   markers:   [{ id, label, markedAt, platform, note }]
//   lastSync:  ISO time of the collector's last run, or null
//   live:      true when the data came from Supabase
//
// With Supabase configured these come from the post_performance, daily_post_metrics and
// daily_followers views and the stat_markers table. Otherwise a sample history is generated.

import { configured, db, signedIn } from "./supabase.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export async function loadStats() {
  if (!configured) return sampleStats(new Date());
  await signedIn();
  const supabase = await db();
  const [posts, daily, followers, markers, sync] = await Promise.all([
    supabase.from("post_performance").select("*").order("published_at", { ascending: false }),
    supabase.from("daily_post_metrics").select("*").order("day"),
    supabase.from("daily_followers").select("*").order("day"),
    supabase.from("stat_markers").select("*").order("marked_at"),
    // Every run records follower counts, so the newest one is when stats were last pulled.
    supabase.from("account_metric_snapshots").select("captured_at").order("captured_at", { ascending: false }).limit(1),
  ]);
  for (const r of [posts, daily, followers, markers, sync]) if (r.error) throw r.error;
  return {
    live: true,
    lastSync: sync.data[0]?.captured_at ?? null,
    posts: posts.data.map((p) => ({
      id: p.id,
      platform: p.platform,
      copy: p.copy,
      url: p.external_url,
      publishedAt: p.published_at,
      impressions: p.impressions ?? 0,
      engagements: p.engagements ?? 0,
      rate: p.engagement_rate == null ? null : Number(p.engagement_rate),
      baselineImpressions: p.baseline_impressions,
      baselineAt: p.baseline_at,
      snapshots: p.snapshot_count,
    })),
    daily: daily.data.map((d) => ({ day: d.day, platform: d.platform, impressions: Number(d.impressions), engagements: Number(d.engagements) })),
    followers: followers.data.map((f) => ({ day: f.day, platform: f.platform, followers: Number(f.followers) })),
    markers: markers.data.map(markerRow),
  };
}

// Runs the collector now, as the signed-in editor: finds posts that went live, marks their drafts
// as posted, and pulls fresh numbers. Returns the collector's per-platform results.
export async function resync() {
  if (!configured) {
    await new Promise((r) => setTimeout(r, 600));
    return { results: [{ platform: "x", posted: 0, snapshots: 0 }, { platform: "linkedin", posted: 0, snapshots: 0 }] };
  }
  const supabase = await db();
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/collect-stats`, {
    method: "POST",
    headers: { Authorization: `Bearer ${data.session?.access_token}`, apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.status === 404) throw new Error("the stats collector isn't deployed yet");
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 207) throw new Error(body.error ?? `the collector answered ${res.status}`);
  return body;
}

function markerRow(m) {
  return { id: m.id, label: m.label, markedAt: m.marked_at, platform: m.platform, note: m.note };
}

export async function addMarker({ label, markedAt, platform, note }) {
  if (!configured) return { id: `local-${Date.now()}`, label, markedAt, platform, note };
  const supabase = await db();
  const { data, error } = await supabase
    .from("stat_markers")
    .insert({ label, marked_at: markedAt, platform: platform || null, note: note || null })
    .select()
    .single();
  if (error) throw error;
  return markerRow(data);
}

// Sample history: 120 days of posts whose numbers grow for two weeks after publishing,
// captured once a day, the way the collector builds them up.

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const SAMPLE_COPY = {
  x: [
    "Voice AI reaches fewer than 3% of the world's 7,000 languages.",
    "Not scraped. Not synthetic. Real human voice, with consent on-chain.",
    "Code-switching is how most of the world talks. Your ASR should hear it too.",
    "Which language should voice AI learn next?",
    "New off-the-shelf datasets for Southeast Asian languages.",
    "Record 5 minutes in your own language and get paid for it.",
  ],
  linkedin: [
    "AI should understand everyone.",
    "Why do voice agents still fail in Manila, Lagos or Lima?",
    "2.5 million people, paid to be heard.",
    "Procurement-ready voice data, aligned with the EU AI Act.",
  ],
};

function sampleStats(now) {
  const rand = rng(7);
  const dayMs = 86_400_000;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(today.getTime() - 119 * dayMs);
  const dayKey = (d) => d.toISOString().slice(0, 10);
  const launch = new Date(today.getTime() - 24 * dayMs);

  const posts = [];
  for (let i = 0; i < 120; i++) {
    const d = new Date(start.getTime() + i * dayMs);
    const lift = d >= launch ? 1.45 : 1;
    if (rand() < 0.8) posts.push({ platform: "x", day: d, peak: Math.round((600 + rand() * 2400) * lift), rate: 0.012 + rand() * 0.03 });
    if (d.getUTCDay() % 2 === 1 && rand() < 0.75) posts.push({ platform: "linkedin", day: d, peak: Math.round((300 + rand() * 1500) * lift), rate: 0.02 + rand() * 0.04 });
  }

  // Cumulative numbers per post on each day after it went out.
  const at = (p, day) => {
    const t = (day - p.day) / dayMs;
    if (t < 0) return null;
    const impressions = Math.round(p.peak * (1 - Math.exp(-(t + 0.6) / 2.2)));
    return { impressions, engagements: Math.round(impressions * p.rate) };
  };

  const daily = [];
  for (let i = 0; i < 120; i++) {
    const d = new Date(start.getTime() + i * dayMs);
    for (const platform of ["x", "linkedin"]) {
      let impressions = 0;
      let engagements = 0;
      for (const p of posts) {
        if (p.platform !== platform) continue;
        const v = at(p, d);
        if (v) { impressions += v.impressions; engagements += v.engagements; }
      }
      daily.push({ day: dayKey(d), platform, impressions, engagements });
    }
  }

  const followers = [];
  let fx = 18_400;
  let fl = 6_150;
  for (let i = 0; i < 120; i++) {
    const d = new Date(start.getTime() + i * dayMs);
    const lift = d >= launch ? 2.2 : 1;
    fx += Math.round((8 + rand() * 30) * lift - rand() * 6);
    fl += Math.round((3 + rand() * 12) * lift);
    followers.push({ day: dayKey(d), platform: "x", followers: fx }, { day: dayKey(d), platform: "linkedin", followers: fl });
  }

  const counters = { x: 0, linkedin: 0 };
  const rows = posts.map((p, i) => {
    const latest = at(p, today);
    const first = at(p, p.day);
    const copy = SAMPLE_COPY[p.platform][counters[p.platform]++ % SAMPLE_COPY[p.platform].length];
    const published = new Date(p.day.getTime() + (p.platform === "x" ? 1 : 2.5) * 3_600_000);
    return {
      id: `sample-${i}`,
      platform: p.platform,
      copy,
      url: null,
      publishedAt: published.toISOString(),
      impressions: latest.impressions,
      engagements: latest.engagements,
      rate: latest.impressions ? latest.engagements / latest.impressions : null,
      baselineImpressions: first.impressions,
      baselineAt: published.toISOString(),
      snapshots: Math.max(1, Math.round((today - p.day) / dayMs) + 1),
    };
  }).reverse();

  return {
    live: false,
    lastSync: new Date(today.getTime() + 3_600_000).toISOString(),
    posts: rows,
    daily,
    followers,
    markers: [
      { id: "m1", label: "Baseline", markedAt: new Date(start.getTime() + 0.5 * dayMs).toISOString(), platform: null, note: "First day of tracking" },
      { id: "m2", label: "On-demand collection launch", markedAt: launch.toISOString(), platform: null, note: null },
    ],
  };
}
