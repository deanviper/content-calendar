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
  const [posts, daily, followers, markers, sync, account] = await Promise.all([
    supabase.from("post_performance").select("*").order("published_at", { ascending: false }),
    supabase.from("daily_post_metrics").select("*").order("day"),
    supabase.from("daily_followers").select("*").order("day"),
    supabase.from("stat_markers").select("*").order("marked_at"),
    // Every run records follower counts, so the newest one is when stats were last pulled.
    supabase.from("account_metric_snapshots").select("captured_at").eq("source", "api").order("captured_at", { ascending: false }).limit(1),
    // Daily account totals imported from the platform's own analytics export.
    supabase.from("account_metric_snapshots").select("platform, captured_at, raw").eq("source", "import").order("captured_at"),
  ]);
  for (const r of [posts, daily, followers, markers, sync, account]) if (r.error) throw r.error;
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
      likes: p.likes ?? 0,
      rate: p.engagement_rate == null ? null : Number(p.engagement_rate),
      baselineImpressions: p.baseline_impressions,
      baselineAt: p.baseline_at,
      snapshots: p.snapshot_count,
    })),
    daily: daily.data.map((d) => ({ day: d.day, platform: d.platform, impressions: Number(d.impressions), engagements: Number(d.engagements) })),
    followers: followers.data.map((f) => ({ day: f.day, platform: f.platform, followers: Number(f.followers) })),
    markers: markers.data.map(markerRow),
    account: account.data.filter((a) => a.raw?.day).map((a) => ({ platform: a.platform, ...a.raw })),
  };
}

// X's account overview export: one row per day with that day's account totals and follows.
// The follower count isn't in it, so it's rebuilt backwards from real captures: the day before
// a known count had that count minus the day's new follows plus its unfollows. X's follow and
// unfollow counts don't track suspended or deleted accounts, so the history is a close estimate.
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function csvRows(text) {
  const rows = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    for (const m of line.matchAll(/("([^"]|"")*"|[^,]*)(,|$)/g)) {
      if (m.index === line.length && m[0] === "") break;
      cells.push(m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1]);
    }
    rows.push(cells);
  }
  return rows;
}

export function parseXOverview(text) {
  const [head, ...body] = csvRows(text);
  const key = (h) => h.trim().toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
  const keys = head.map(key);
  if (!keys.includes("date") || !keys.includes("impressions") || !keys.includes("new_follows")) {
    throw new Error("this isn't X's account overview export (needs Date, Impressions and New follows columns)");
  }
  return body.map((cells) => {
    const row = {};
    keys.forEach((k, i) => { row[k] = k === "date" ? cells[i] : Number(cells[i] ?? 0) || 0; });
    const m = /(\w{3}) (\d{1,2}), (\d{4})/.exec(row.date ?? "");
    if (!m) throw new Error(`can't read the date "${row.date}"`);
    row.day = `${m[3]}-${String(MONTHS[m[1]]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    delete row.date;
    return row;
  }).sort((a, b) => b.day.localeCompare(a.day));
}

const manilaDayOf = (iso) => new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 10);

export async function importXOverview(text) {
  const days = parseXOverview(text);
  const supabase = await db();
  const { data: real, error } = await supabase.from("account_metric_snapshots").select("captured_at, followers")
    .eq("platform", "x").eq("source", "api").order("captured_at", { ascending: false });
  if (error) throw error;
  if (!real.length) throw new Error("no follower count captured yet to rebuild from; resync first");
  const realByDay = new Map();
  for (const r of real) if (!realByDay.has(manilaDayOf(r.captured_at))) realByDay.set(manilaDayOf(r.captured_at), Number(r.followers));
  const anchorDay = manilaDayOf(real[0].captured_at);

  // Days on or after the newest capture are still in progress, so they are left out.
  const rows = [];
  let running = null;
  for (const d of days) {
    if (d.day > anchorDay) continue;
    if (d.day === anchorDay) { running = realByDay.get(d.day) - d.new_follows + d.unfollows; continue; }
    if (running == null) running = Number(real[0].followers);
    const followers = realByDay.get(d.day) ?? running;
    rows.push({ captured_at: `${d.day}T15:59:00Z`, followers, raw: { source: "x_account_overview", ...d } });
    running = followers - d.new_follows + d.unfollows;
  }
  const res = await callCollector("?mode=import", { platform: "x", rows });
  return { ...res, from: rows.at(-1)?.captured_at.slice(0, 10), to: rows[0]?.captured_at.slice(0, 10) };
}

async function callCollector(query, payload) {
  const supabase = await db();
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/collect-stats${query}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${data.session?.access_token}`, apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `the collector answered ${res.status}`);
  return body;
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

// The daily pull, without a scheduler secret: when an editor opens the calendar or the stats page and
// the newest capture is older than `hours`, run the collector once with their session. Returns the
// collector's answer, or null when nothing was due.
export async function syncIfStale(hours = 20) {
  if (!configured) return null;
  const supabase = await db();
  const { data, error } = await supabase.from("account_metric_snapshots").select("captured_at")
    .eq("source", "api").order("captured_at", { ascending: false }).limit(1);
  if (error) return null;                               // not an editor: stats are not readable
  const last = data[0] ? Date.parse(data[0].captured_at) : 0;
  if (Date.now() - last < hours * 3_600_000) return null;
  return resync();
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
    account: [],
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
