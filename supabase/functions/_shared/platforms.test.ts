import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { linkedInClient, linkedInVersion, RateLimited, xClient } from "./platforms.ts";

function fakeFetch(routes: Record<string, unknown>, seen: { url: string; headers: Headers }[] = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: new Headers(init?.headers) });
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return new Response("not found", { status: 404 });
    if (hit[1] === 429) return new Response("slow down", { status: 429 });
    return Response.json(hit[1]);
  }) as typeof fetch;
}

Deno.test("X metrics map public_metrics onto our columns", async () => {
  const x = xClient("t", fakeFetch({
    "https://api.x.com/2/tweets?ids=1,2": {
      data: [
        { id: "1", public_metrics: { impression_count: 900, like_count: 20, retweet_count: 4, reply_count: 3, quote_count: 1, bookmark_count: 2 } },
        { id: "2", public_metrics: { impression_count: 10, like_count: 0, retweet_count: 0, reply_count: 0, quote_count: 0, bookmark_count: 0 } },
      ],
    },
  }));
  const [first] = await x.metrics(["1", "2"]);
  assertEquals(first, {
    externalId: "1", impressions: 900, likes: 20, reposts: 4, replies: 3, quotes: 1, bookmarks: 2, clicks: null,
    raw: { impression_count: 900, like_count: 20, retweet_count: 4, reply_count: 3, quote_count: 1, bookmark_count: 2 },
  });
});

Deno.test("X metrics are requested 100 ids at a time", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const x = xClient("t", fakeFetch({ "https://api.x.com/2/tweets": { data: [] } }, seen));
  await x.metrics(Array.from({ length: 250 }, (_, i) => String(i)));
  assertEquals(seen.length, 3);
  assertEquals(seen[0].headers.get("authorization"), "Bearer t");
});

Deno.test("X timeline follows next_token and keeps the post text", async () => {
  let calls = 0;
  const fetchFn = (async (input: string | URL | Request) => {
    calls++;
    const url = new URL(String(input));
    const page2 = url.searchParams.get("pagination_token") === "p2";
    return Response.json(page2
      ? { data: [{ id: "8", text: "older", created_at: "2026-01-01T00:00:00.000Z", public_metrics: {} }], meta: {} }
      : { data: [{ id: "9", text: "newer", created_at: "2026-02-01T00:00:00.000Z", public_metrics: {} }], meta: { next_token: "p2" } });
  }) as typeof fetch;
  const found = await xClient("t", fetchFn).timeline("42");
  assertEquals(calls, 2);
  assertEquals(found.map((p) => [p.externalId, p.copy, p.url]), [
    ["9", "newer", "https://x.com/i/status/9"],
    ["8", "older", "https://x.com/i/status/8"],
  ]);
});

Deno.test("a 429 surfaces as RateLimited", async () => {
  const x = xClient("t", fakeFetch({ "https://api.x.com/2/users/": 429 }));
  await assertRejects(() => x.followers("42"), RateLimited);
});

Deno.test("LinkedIn stats split shares and ugcPosts and map totals", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const li = linkedInClient("t", "123", "202608", fakeFetch({
    "https://api.linkedin.com/rest/organizationalEntityShareStatistics": {
      elements: [{ share: "urn:li:share:1", totalShareStatistics: { impressionCount: 400, likeCount: 10, shareCount: 2, commentCount: 3, clickCount: 7 } }],
    },
  }, seen));
  const [m] = await li.metrics(["urn:li:share:1", "urn:li:ugcPost:2"]);
  assertEquals([m.externalId, m.impressions, m.likes, m.reposts, m.replies, m.clicks], ["urn:li:share:1", 400, 10, 2, 3, 7]);
  const url = seen[0].url;
  assertEquals(url.includes("shares=List(urn%3Ali%3Ashare%3A1)"), true);
  assertEquals(url.includes("ugcPosts=List(urn%3Ali%3AugcPost%3A2)"), true);
  assertEquals(seen[0].headers.get("linkedin-version"), "202608");
});

Deno.test("LinkedIn posts stop at the since date and skip drafts", async () => {
  const li = linkedInClient("t", "123", "202608", fakeFetch({
    "https://api.linkedin.com/rest/posts": {
      elements: [
        { id: "urn:li:share:3", commentary: "new", publishedAt: Date.parse("2026-03-01"), lifecycleState: "PUBLISHED" },
        { id: "urn:li:share:4", commentary: "draft", createdAt: Date.parse("2026-02-15"), lifecycleState: "DRAFT" },
        { id: "urn:li:share:2", commentary: "old", publishedAt: Date.parse("2025-12-01"), lifecycleState: "PUBLISHED" },
      ],
    },
  }));
  const found = await li.posts("2026-01-01");
  assertEquals(found.map((p) => p.externalId), ["urn:li:share:3"]);
});

Deno.test("LinkedIn version defaults to two months back", () => {
  assertEquals(linkedInVersion(new Date("2026-10-26T00:00:00Z")), "202608");
  assertEquals(linkedInVersion(new Date("2026-01-15T00:00:00Z")), "202511");
  assertEquals(linkedInVersion(new Date(), "202601"), "202601");
});
