#!/usr/bin/env node
// Imports past post stats from a CSV, for numbers the APIs no longer return (older than X's 3,200
// post window, or exported from X or LinkedIn analytics). Each row becomes a snapshot with
// source "import"; posts are created if they are not in the table yet.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/import-stats.mjs stats.csv
//   node scripts/import-stats.mjs stats.csv --dry-run      parse and print, write nothing
//
// Columns (header row required, order free, blank cells allowed):
//   platform      x | linkedin                                   required
//   external_id   tweet id, or LinkedIn urn:li:share:… / urn:li:ugcPost:…   required
//   published_at  when the post went out, e.g. 2026-03-04 09:00+08:00   required
//   captured_at   when these numbers were true; defaults to now
//   copy, url, impressions, likes, reposts, replies, quotes, bookmarks, clicks

import { readFile } from "node:fs/promises";

const METRICS = ["impressions", "likes", "reposts", "replies", "quotes", "bookmarks", "clicks"];

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim()));
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export function toRecords(rows, now = new Date()) {
  return rows.map((r, i) => {
    const line = i + 2;
    if (!["x", "linkedin"].includes(r.platform)) throw new Error(`line ${line}: platform must be x or linkedin`);
    if (!r.external_id) throw new Error(`line ${line}: external_id is empty`);
    const published = new Date(r.published_at);
    if (Number.isNaN(published.getTime())) throw new Error(`line ${line}: published_at is not a date`);
    const captured = r.captured_at ? new Date(r.captured_at) : now;
    if (Number.isNaN(captured.getTime())) throw new Error(`line ${line}: captured_at is not a date`);
    const metrics = {};
    for (const m of METRICS) {
      if (!r[m]) { metrics[m] = null; continue; }
      const n = Number(r[m].replace(/[,\s]/g, ""));
      if (!Number.isInteger(n) || n < 0) throw new Error(`line ${line}: ${m} must be a whole number`);
      metrics[m] = n;
    }
    return {
      post: {
        platform: r.platform,
        status: "published",
        scheduled_at: published.toISOString(),
        published_at: published.toISOString(),
        copy: r.copy ?? "",
        external_id: r.external_id,
        external_url: r.url || null,
      },
      snapshot: { captured_at: captured.toISOString(), source: "import", ...metrics },
    };
  });
}

async function rest(path, init) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  const [file, flag] = process.argv.slice(2);
  if (!file) {
    console.error("usage: node scripts/import-stats.mjs <file.csv> [--dry-run]");
    process.exit(1);
  }
  const records = toRecords(parseCsv(await readFile(file, "utf8")));
  if (flag === "--dry-run") {
    console.table(records.map((r) => ({ platform: r.post.platform, id: r.post.external_id, captured: r.snapshot.captured_at, impressions: r.snapshot.impressions, likes: r.snapshot.likes })));
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }

  const unique = [...new Map(records.map((r) => [`${r.post.platform}:${r.post.external_id}`, r.post])).values()];
  await rest("posts?on_conflict=platform,external_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(unique),
  });

  const ids = new Map();
  for (const platform of ["x", "linkedin"]) {
    const ext = unique.filter((p) => p.platform === platform).map((p) => p.external_id);
    for (let i = 0; i < ext.length; i += 100) {
      const list = ext.slice(i, i + 100).map((e) => `"${e.replaceAll('"', '\\"')}"`).join(",");
      const found = await rest(`posts?select=id,external_id&platform=eq.${platform}&external_id=in.(${encodeURIComponent(list)})`);
      for (const p of found) ids.set(`${platform}:${p.external_id}`, p.id);
    }
  }

  const snapshots = records.map((r) => ({ post_id: ids.get(`${r.post.platform}:${r.post.external_id}`), ...r.snapshot }));
  await rest("post_metric_snapshots?on_conflict=post_id,captured_at", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(snapshots),
  });
  console.log(`Imported ${snapshots.length} snapshots for ${unique.length} posts.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
