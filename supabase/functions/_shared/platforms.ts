// Platform clients for the stats collector. Each returns plain rows shaped for our tables, so the
// collector only deals with one format. Parsing is split from fetching so it can be tested offline.

export type Platform = "x" | "linkedin";

export interface PostMetrics {
  externalId: string;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  quotes: number | null;
  bookmarks: number | null;
  clicks: number | null;
  raw: unknown;
}

export interface FoundPost {
  externalId: string;
  url: string;
  copy: string;
  publishedAt: string;
  metrics: PostMetrics | null;
}

export class RateLimited extends Error {}

type Fetch = typeof fetch;

async function getJson(fetchFn: Fetch, url: string, headers: Record<string, string>) {
  const res = await fetchFn(url, { headers });
  if (res.status === 429) throw new RateLimited(`${new URL(url).host} rate limit reached`);
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).pathname}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// X API v2. Needs a bearer token; impression_count is part of public_metrics.

export const X_API = "https://api.x.com/2";

export function parseXMetrics(tweet: any): PostMetrics {
  const m = tweet.public_metrics ?? {};
  return {
    externalId: String(tweet.id),
    impressions: m.impression_count ?? null,
    likes: m.like_count ?? null,
    reposts: m.retweet_count ?? null,
    replies: m.reply_count ?? null,
    quotes: m.quote_count ?? null,
    bookmarks: m.bookmark_count ?? null,
    clicks: null,
    raw: m,
  };
}

export function xClient(token: string, fetchFn: Fetch = fetch) {
  const headers = { Authorization: `Bearer ${token}` };

  return {
    async userId(username: string): Promise<string> {
      const body = await getJson(fetchFn, `${X_API}/users/by/username/${encodeURIComponent(username)}`, headers);
      return body.data.id;
    },

    async followers(userId: string): Promise<{ followers: number; raw: unknown }> {
      const body = await getJson(fetchFn, `${X_API}/users/${userId}?user.fields=public_metrics`, headers);
      return { followers: body.data.public_metrics.followers_count, raw: body.data.public_metrics };
    },

    async metrics(ids: string[]): Promise<PostMetrics[]> {
      const pages = await Promise.all(chunks(ids, 100).map((batch) =>
        getJson(fetchFn, `${X_API}/tweets?ids=${batch.join(",")}&tweet.fields=public_metrics`, headers)));
      return pages.flatMap((p) => (p.data ?? []).map(parseXMetrics));
    },

    // Original posts only (no replies or reposts). X returns at most the latest 3,200.
    async timeline(userId: string, since?: string): Promise<FoundPost[]> {
      const found: FoundPost[] = [];
      let next: string | undefined;
      do {
        const params = new URLSearchParams({
          max_results: "100",
          exclude: "replies,retweets",
          "tweet.fields": "public_metrics,created_at",
        });
        if (since) params.set("start_time", since);
        if (next) params.set("pagination_token", next);
        const body = await getJson(fetchFn, `${X_API}/users/${userId}/tweets?${params}`, headers);
        for (const t of body.data ?? []) {
          found.push({
            externalId: String(t.id),
            url: `https://x.com/i/status/${t.id}`,
            copy: t.text ?? "",
            publishedAt: t.created_at,
            metrics: parseXMetrics(t),
          });
        }
        next = body.meta?.next_token;
      } while (next);
      return found;
    },
  };
}

// X without an API key, through FxTwitter's public API (the service behind fxtwitter.com embeds). Same public
// numbers as X's own (views, likes, reposts, replies, quotes, bookmarks), no clicks. Unofficial: it can rate
// limit or change shape, so the bearer-token client above stays the first choice when a token is set.

export const FX_API = "https://api.fxtwitter.com";
const FX_HEADERS = { "User-Agent": "silencio-content-calendar/1.0" };

export function parseFxMetrics(t: any): PostMetrics {
  return {
    externalId: String(t.id),
    impressions: t.views ?? null,
    likes: t.likes ?? null,
    reposts: t.retweets ?? t.reposts ?? null,
    replies: t.replies ?? null,
    quotes: t.quotes ?? null,
    bookmarks: t.bookmarks ?? null,
    clicks: null,
    raw: { views: t.views, likes: t.likes, retweets: t.retweets ?? t.reposts, replies: t.replies, quotes: t.quotes, bookmarks: t.bookmarks },
  };
}

export function fxClient(username: string, fetchFn: Fetch = fetch) {
  const user = encodeURIComponent(username);

  return {
    async followers(): Promise<{ followers: number; raw: unknown }> {
      const body = await getJson(fetchFn, `${FX_API}/${user}`, FX_HEADERS);
      return { followers: body.user.followers, raw: { followers: body.user.followers, following: body.user.following } };
    },

    // One request per post, five at a time; a post that is gone is skipped instead of failing the run.
    async metrics(ids: string[]): Promise<PostMetrics[]> {
      const out: PostMetrics[] = [];
      for (const batch of chunks(ids, 5)) {
        const got = await Promise.all(batch.map(async (id) => {
          try {
            const body = await getJson(fetchFn, `${FX_API}/${user}/status/${id}`, FX_HEADERS);
            return body.tweet ? parseFxMetrics(body.tweet) : null;
          } catch (e) {
            if (e instanceof RateLimited) throw e;
            return null;
          }
        }));
        out.push(...got.filter((m): m is PostMetrics => m !== null));
      }
      return out;
    },

    // Original posts only (no replies or reposts), newest first, paged back to `since`.
    async timeline(since?: string): Promise<FoundPost[]> {
      const stop = since ? Date.parse(since) / 1000 : 0;
      const found: FoundPost[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const body = await getJson(fetchFn, `${FX_API}/2/profile/${user}/statuses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, FX_HEADERS);
        const results: any[] = body.results ?? [];
        for (const t of results) {
          if (t.replying_to || t.reposted_by || t.created_timestamp < stop) continue;
          found.push({
            externalId: String(t.id),
            url: `https://x.com/${username}/status/${t.id}`,
            copy: t.text ?? "",
            publishedAt: new Date(t.created_timestamp * 1000).toISOString(),
            metrics: parseFxMetrics(t),
          });
        }
        cursor = body.cursor?.bottom;
        if (!results.length || !cursor || Math.min(...results.map((t) => t.created_timestamp)) < stop) break;
      }
      return found;
    },
  };
}

// X without a key, with backups. Per post: FxTwitter (every public number), then vxTwitter (likes, reposts,
// replies), then X's own embed CDN (likes, replies). Whatever a backup cannot see stays null, and the
// collector carries the last known value forward. raw.source records which one answered.

const VX_API = "https://api.vxtwitter.com";
const SYNDICATION = "https://cdn.syndication.twimg.com/tweet-result";

export function syndicationToken(id: string): string {     // the token X's embed script sends with each id
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

export function parseVxMetrics(t: any): PostMetrics {
  return {
    externalId: String(t.tweetID), impressions: null, likes: t.likes ?? null, reposts: t.retweets ?? null,
    replies: t.replies ?? null, quotes: null, bookmarks: null, clicks: null,
    raw: { source: "vxtwitter", likes: t.likes, retweets: t.retweets, replies: t.replies },
  };
}

export function parseSyndicationMetrics(t: any): PostMetrics {
  return {
    externalId: String(t.id_str), impressions: null, likes: t.favorite_count ?? null, reposts: null,
    replies: t.conversation_count ?? null, quotes: null, bookmarks: null, clicks: null,
    raw: { source: "syndication", favorite_count: t.favorite_count, conversation_count: t.conversation_count },
  };
}

export function xPublicClient(username: string, fetchFn: Fetch = fetch) {
  const fx = fxClient(username, fetchFn);
  const user = encodeURIComponent(username);
  const attempts: ((id: string) => Promise<PostMetrics | null>)[] = [
    async (id) => {
      const body = await getJson(fetchFn, `${FX_API}/${user}/status/${id}`, FX_HEADERS);
      if (!body.tweet) return null;
      const m = parseFxMetrics(body.tweet);
      return { ...m, raw: { source: "fxtwitter", ...(m.raw as object) } };
    },
    // vxTwitter sits behind Cloudflare, which lets plain HTTP clients through but challenges browser agents.
    async (id) => parseVxMetrics(await getJson(fetchFn, `${VX_API}/${user}/status/${id}`, { "User-Agent": "curl/8.5.0" })),
    async (id) => parseSyndicationMetrics(await getJson(fetchFn, `${SYNDICATION}?id=${id}&token=${syndicationToken(id)}`, FX_HEADERS)),
  ];

  async function one(id: string): Promise<PostMetrics | null> {
    for (const attempt of attempts) {
      try {
        const m = await attempt(id);
        if (m && m.likes !== null) return m;
      } catch { /* next source */ }
    }
    return null;
  }

  return {
    followers: () => fx.followers(),
    timeline: (since?: string) => fx.timeline(since),
    async metrics(ids: string[]): Promise<PostMetrics[]> {
      const out: PostMetrics[] = [];
      for (const batch of chunks(ids, 5)) out.push(...(await Promise.all(batch.map(one))).filter((m): m is PostMetrics => m !== null));
      return out;
    },
  };
}

// LinkedIn without the API: the company page as a logged-out visitor sees it. It lists the latest ~10
// posts with reactions and comments; older posts are read from their own public page. Impressions are
// only shown to page admins, so they stay null. A post's time is encoded in its activity id.

const LI_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

export function activityTime(urn: string): string {
  return new Date(Number(BigInt(urn.replace(/\D/g, "")) >> 22n)).toISOString();
}

const unescapeHtml = (s: string) => s.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").trim();

export function parseLinkedInPage(html: string): { posts: FoundPost[]; followers: number | null } {
  const posts: FoundPost[] = [];
  for (const card of html.split("<article ").slice(1)) {
    const id = card.match(/data-activity-urn="(urn:li:activity:\d+)"/)?.[1];
    if (!id || posts.some((p) => p.externalId === id)) continue;
    const num = (attr: string) => { const v = card.match(new RegExp(`data-num-${attr}="(\\d+)"`))?.[1]; return v ? Number(v) : 0; };
    const text = card.match(/<p[^>]*attributed-text-segment-list__content[^>]*>([\s\S]*?)<\/p>/)?.[1];
    posts.push({
      externalId: id,
      url: `https://www.linkedin.com/feed/update/${id}/`,
      copy: text ? unescapeHtml(text) : "",
      publishedAt: activityTime(id),
      metrics: {
        externalId: id, impressions: null, likes: num("reactions"), reposts: null, replies: num("comments"),
        quotes: null, bookmarks: null, clicks: null, raw: { source: "linkedin-page", reactions: num("reactions"), comments: num("comments") },
      },
    });
  }
  const f = html.match(/([\d,]+)\s+followers/)?.[1];
  return { posts, followers: f ? Number(f.replace(/,/g, "")) : null };
}

export function parseLinkedInPost(id: string, html: string): PostMetrics | null {
  const card = html.split("<article ").find((c) => c.includes(id)) ?? html;
  const r = card.match(/data-num-reactions="(\d+)"/)?.[1];
  if (r === undefined) return null;
  const c = card.match(/data-num-comments="(\d+)"/)?.[1] ?? "0";
  return {
    externalId: id, impressions: null, likes: Number(r), reposts: null, replies: Number(c), quotes: null,
    bookmarks: null, clicks: null, raw: { source: "linkedin-post", reactions: Number(r), comments: Number(c) },
  };
}

export function linkedInPublicClient(page: string, fetchFn: Fetch = fetch) {
  let cached: Promise<ReturnType<typeof parseLinkedInPage>> | undefined;
  const companyPage = () => (cached ??= (async () => {
    const res = await fetchFn(`https://www.linkedin.com/company/${encodeURIComponent(page)}/`, { headers: LI_HEADERS });
    if (!res.ok) throw new Error(`${res.status} from the LinkedIn company page`);
    return parseLinkedInPage(await res.text());
  })());

  return {
    async followers(): Promise<{ followers: number; raw: unknown }> {
      const { followers } = await companyPage();
      if (followers === null) throw new Error("LinkedIn page showed no follower count");
      return { followers, raw: { source: "linkedin-page", followers } };
    },
    async posts(since?: string): Promise<FoundPost[]> {
      const { posts } = await companyPage();
      return since ? posts.filter((p) => p.publishedAt >= since) : posts;
    },
    async metrics(ids: string[]): Promise<PostMetrics[]> {
      const onPage = new Map<string, PostMetrics>();
      try { for (const p of (await companyPage()).posts) onPage.set(p.externalId, p.metrics!); } catch { /* fall back to post pages */ }
      const out: PostMetrics[] = [];
      for (const batch of chunks(ids.filter((id) => id.startsWith("urn:li:activity:")), 3)) {
        out.push(...(await Promise.all(batch.map(async (id) => {
          if (onPage.has(id)) return onPage.get(id)!;
          try {
            const res = await fetchFn(`https://www.linkedin.com/feed/update/${id}/`, { headers: LI_HEADERS });
            return res.ok ? parseLinkedInPost(id, await res.text()) : null;
          } catch { return null; }
        }))).filter((m): m is PostMetrics => m !== null));
      }
      return out;
    },
  };
}

// LinkedIn Community Management API, for an organization page the token can administer.

export const LINKEDIN_API = "https://api.linkedin.com/rest";

// LinkedIn wants a dated version header and retires versions after about a year;
// default to the month two months back unless one is configured.
export function linkedInVersion(now = new Date(), configured?: string): string {
  if (configured) return configured;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function parseLinkedInStats(element: any): PostMetrics {
  const s = element.totalShareStatistics ?? {};
  return {
    externalId: element.share ?? element.ugcPost,
    impressions: s.impressionCount ?? null,
    likes: s.likeCount ?? null,
    reposts: s.shareCount ?? null,
    replies: s.commentCount ?? null,
    quotes: null,
    bookmarks: null,
    clicks: s.clickCount ?? null,
    raw: s,
  };
}

export function linkedInClient(token: string, orgId: string, version: string, fetchFn: Fetch = fetch) {
  const org = `urn:li:organization:${orgId}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": version,
    "X-Restli-Protocol-Version": "2.0.0",
  };

  return {
    async followers(): Promise<{ followers: number; raw: unknown }> {
      const body = await getJson(fetchFn,
        `${LINKEDIN_API}/networkSizes/${encodeURIComponent(org)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, headers);
      return { followers: body.firstDegreeSize, raw: body };
    },

    // Post URNs are either urn:li:share:… or urn:li:ugcPost:…; the API takes them in separate lists.
    async metrics(urns: string[]): Promise<PostMetrics[]> {
      const pages = await Promise.all(chunks(urns, 20).map((batch) => {
        const shares = batch.filter((u) => u.startsWith("urn:li:share:"));
        const ugc = batch.filter((u) => u.startsWith("urn:li:ugcPost:"));
        const list = (items: string[]) => `List(${items.map(encodeURIComponent).join(",")})`;
        let url = `${LINKEDIN_API}/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(org)}`;
        if (shares.length) url += `&shares=${list(shares)}`;
        if (ugc.length) url += `&ugcPosts=${list(ugc)}`;
        return getJson(fetchFn, url, headers);
      }));
      return pages.flatMap((p) => (p.elements ?? []).map(parseLinkedInStats));
    },

    async posts(since?: string): Promise<FoundPost[]> {
      const found: FoundPost[] = [];
      const sinceMs = since ? Date.parse(since) : 0;
      for (let start = 0; ; start += 50) {
        const body = await getJson(fetchFn,
          `${LINKEDIN_API}/posts?q=author&author=${encodeURIComponent(org)}&count=50&start=${start}`,
          { ...headers, "X-RestLi-Method": "FINDER" });
        const elements = body.elements ?? [];
        for (const p of elements) {
          if (p.lifecycleState && p.lifecycleState !== "PUBLISHED") continue;
          const publishedMs = p.publishedAt ?? p.createdAt;
          if (publishedMs < sinceMs) return found;
          found.push({
            externalId: p.id,
            url: `https://www.linkedin.com/feed/update/${p.id}`,
            copy: p.commentary ?? "",
            publishedAt: new Date(publishedMs).toISOString(),
            metrics: null,
          });
        }
        if (elements.length < 50) return found;
      }
    },
  };
}
