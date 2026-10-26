import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toRecords } from "./import-stats.mjs";

test("parses quoted copy with commas, quotes and line breaks", () => {
  const rows = parseCsv('platform,external_id,published_at,copy,impressions\r\nx,1,2026-03-04,"Hello, ""world""\nline two","1,200"\n');
  assert.deepEqual(rows, [{ platform: "x", external_id: "1", published_at: "2026-03-04", copy: 'Hello, "world"\nline two', impressions: "1,200" }]);
});

test("turns rows into a post and a snapshot", () => {
  const now = new Date("2026-10-26T00:00:00Z");
  const [r] = toRecords([{ platform: "linkedin", external_id: "urn:li:share:9", published_at: "2026-03-04 09:00+08:00", impressions: "1,200", likes: "" }], now);
  assert.equal(r.post.published_at, "2026-03-04T01:00:00.000Z");
  assert.equal(r.post.status, "published");
  assert.equal(r.snapshot.captured_at, now.toISOString());
  assert.equal(r.snapshot.impressions, 1200);
  assert.equal(r.snapshot.likes, null);
  assert.equal(r.snapshot.source, "import");
});

test("names the line of a bad row", () => {
  assert.throws(() => toRecords([{ platform: "x", external_id: "1", published_at: "2026-01-01", likes: "-3" }]), /line 2: likes/);
  assert.throws(() => toRecords([{ platform: "fb", external_id: "1", published_at: "2026-01-01" }]), /line 2: platform/);
});
