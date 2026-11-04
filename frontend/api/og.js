// Link preview data for the calendar's Discord preview: reads a page's Open Graph tags the way
// Discord's crawler does and returns { site, title, description, image, color, large }.
// Sits behind the same team password as the rest of the site (middleware.js).

const PRIVATE = /^(localhost|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[|::1$)/i;

function decode(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

module.exports = async (req, res) => {
  let url;
  try {
    url = new URL(String(req.query.url ?? ""));
  } catch {
    return res.status(400).json({ error: "send ?url=https://…" });
  }
  if (!/^https?:$/.test(url.protocol) || PRIVATE.test(url.hostname)) {
    return res.status(400).json({ error: "only public http(s) links" });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)", Accept: "text/html" },
    });
    const html = (await r.text()).slice(0, 600_000);
    const meta = (key) => {
      const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i"));
      const content = tag?.[0].match(/content=["']([^"']*)["']/i);
      return content ? decode(content[1]).trim() : null;
    };
    const abs = (u) => { try { return u ? new URL(u, r.url).href : null; } catch { return null; } };
    const title = meta("og:title") ?? meta("twitter:title") ?? decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim();
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json({
      url: r.url,
      site: meta("og:site_name") ?? new URL(r.url).hostname.replace(/^www\./, ""),
      title: title || null,
      description: meta("og:description") ?? meta("twitter:description") ?? meta("description"),
      image: abs(meta("og:image") ?? meta("twitter:image")),
      color: meta("theme-color"),
      large: /large/i.test(meta("twitter:card") ?? "") || !!meta("og:image"),
    });
  } catch {
    return res.status(502).json({ error: "couldn't read that page" });
  } finally {
    clearTimeout(timer);
  }
};
