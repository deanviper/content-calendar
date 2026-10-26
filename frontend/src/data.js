// Post data for the calendar.
//
// The backend only needs to return an array in this shape:
//   {
//     id: string,
//     platform: "x" | "linkedin",
//     status: "draft" | "suggested" | "scheduled" | "published",
//     scheduledAt: ISO 8601 string with offset, e.g. "2026-10-28T09:00:00+08:00",
//     copy: string,            // line breaks are kept
//     hashtags: string[],      // without the "#"
//     assets: { type: "image" | "video" | "file", url: string, name: string, alt?: string }[]
//   }
//
// With Supabase configured in config.js the posts come from the posts and post_assets tables.
// Without it the calendar renders sample posts placed relative to the current month.

import { configured, db, signedIn } from "./supabase.js";

export const TIME_ZONE = "Asia/Manila";
export const TIME_ZONE_LABEL = "Manila, GMT+8";

// The account each platform preview is drawn as.
export const ACCOUNTS = {
  x: { name: "Silencio", handle: "@silencioNetwork" },
  linkedin: { name: "Silencio", handle: "Company page" },
};

export async function loadPosts() {
  if (!configured) return samplePosts(new Date());
  await signedIn();
  const supabase = await db();
  const { data, error } = await supabase
    .from("posts")
    .select("id, platform, status, scheduled_at, copy, hashtags, post_assets(type, storage_path, url, name, alt, position)")
    .order("scheduled_at");
  if (error) throw error;

  // Assets in the private bucket are shown through signed links that last an hour.
  const paths = data.flatMap((p) => p.post_assets.filter((a) => a.storage_path).map((a) => a.storage_path));
  const signed = new Map();
  if (paths.length) {
    const { data: links, error: e } = await supabase.storage.from("post-assets").createSignedUrls(paths, 3600);
    if (e) throw e;
    for (const l of links) if (l.signedUrl) signed.set(l.path, l.signedUrl);
  }

  return data.map((p) => ({
    id: p.id,
    platform: p.platform,
    status: p.status,
    scheduledAt: p.scheduled_at,
    copy: p.copy,
    hashtags: p.hashtags ?? [],
    assets: p.post_assets
      .sort((a, b) => a.position - b.position)
      .map((a) => ({ type: a.type, url: a.url ?? signed.get(a.storage_path), name: a.name, alt: a.alt ?? "" }))
      .filter((a) => a.url),
  }));
}

const asset = (file, name, alt) => ({ type: "image", url: `assets/${file}`, name, alt });

// [day offset from today, platform, status, "HH:MM" Manila time, copy, hashtags, assets]
const SAMPLE = [
  [-9, "x", "scheduled", "09:00", "Your phone is a noise sensor. 460,000 of them now map sound in 180+ countries.", ["DePIN"], []],
  [-9, "linkedin", "scheduled", "10:30", "Noise is the pollution nobody sees.\n\nCities plan around air quality and traffic, but sound data is patchy and years old. Silencio turns everyday phones into a live noise map, so planners, venues and researchers can see what a street actually sounds like today.", ["UrbanPlanning", "OpenData"], [asset("noise-map.svg", "noise-map.svg", "Dark map with glowing points where noise is highest")]],
  [-6, "x", "scheduled", "18:00", "Measured a quiet café this week? Drop the dB reading below. We're collecting the calmest spots in Manila.", ["Silencio"], []],
  [-3, "linkedin", "scheduled", "08:30", "What does a city sound like, hour by hour?\n\nWe plotted one day of readings from a single neighbourhood. The peak is not rush hour.", ["Acoustics", "SmartCities"], [asset("decibel-bars.svg", "decibel-bars.svg", "Bar chart of noise level per hour across one day")]],
  [-3, "x", "scheduled", "12:00", "The loudest hour in the neighbourhood we measured was 21:00, not 08:00. Thread on why.", [], [asset("decibel-bars.svg", "decibel-bars.svg", "Bar chart of noise level per hour across one day")]],
  [0, "x", "scheduled", "09:00", "Monday check-in: open the app, record 15 seconds of wherever you are, and earn $SLC for it.", ["Silencio", "DePIN"], []],
  [0, "linkedin", "scheduled", "11:00", "Quiet is a public good. Measure it.\n\nThis week we're sharing how hospitality teams use venue noise profiles to pick locations and set expectations for guests.", ["Hospitality", "Data"], [asset("quote-card.svg", "quote-card.svg", "Black card reading: Quiet is a public good. Measure it.")]],
  [0, "x", "suggested", "19:30", "Name the loudest street you walk every day. We'll check the data.", [], []],
  [2, "x", "suggested", "10:00", "Noise exposure above 55 dB at night is linked to poorer sleep and higher stress. How loud is your bedroom? Record it tonight and find out.", ["Health"], []],
  [3, "linkedin", "scheduled", "09:00", "Street-level noise data, without new hardware.\n\nCity teams and research groups: tell us which neighbourhoods you need covered and we'll share what the network already has there.", ["SmartCities"], []],
  [5, "x", "scheduled", "17:00", "Weekend challenge: record the quietest place you can find. Top 10 quietest readings get a shout-out on Monday.", ["Silencio"], [asset("noise-map.svg", "noise-map.svg", "Dark map with glowing points where noise is highest")]],
  [8, "linkedin", "suggested", "10:00", "Three things we learned from a million noise readings:\n\n1. Weekends are louder than weekdays in most cities.\n2. Parks are not as quiet as people think.\n3. Night noise varies more than day noise.", ["Research", "OpenData"], []],
  [8, "x", "suggested", "13:00", "A million noise readings later, the surprise: parks are not as quiet as people think. Our full breakdown goes live this week, so tell us which city you want covered next and we'll add it to the report before it ships.", [], []],
  [12, "x", "scheduled", "09:00", "New in the app: venue noise profiles. Check how loud a restaurant gets before you book.", ["ProductUpdate"], [asset("quote-card.svg", "quote-card.svg", "Black card reading: Quiet is a public good. Measure it.")]],
  [12, "linkedin", "scheduled", "09:30", "Venue noise profiles are live.\n\nFor venue owners: see how your space compares to the street and to similar venues nearby, and share a verified quiet score with guests.", ["Hospitality", "ProductUpdate"], [asset("quote-card.svg", "quote-card.svg", "Black card reading: Quiet is a public good. Measure it.")]],
  [16, "x", "draft", "18:00", "What should we measure next: classrooms, hospitals or offices?", [], []],
  [19, "linkedin", "draft", "08:00", "Month in review: new countries, new sensors, and what the data says about city nights.", ["Update"], []],
  [22, "x", "scheduled", "12:00", "Community call this Thursday. Bring questions about rewards, the app and the roadmap.", ["Silencio"], []],
];

function samplePosts(now) {
  const today = manilaDate(now);
  return SAMPLE.map(([offset, platform, status, time, copy, hashtags, assets], i) => {
    const d = new Date(Date.UTC(today.y, today.m, today.d + offset));
    const date = d.toISOString().slice(0, 10);
    return {
      id: `sample-${i + 1}`,
      platform,
      // Sample posts in the past have gone out; a real backend reports this itself.
      status: offset < 0 && status === "scheduled" ? "published" : status,
      scheduledAt: `${date}T${time}:00+08:00`,
      copy,
      hashtags,
      assets,
    };
  });
}

// The calendar's notion of "today" is Manila's date, whatever the viewer's clock says.
export function manilaDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get("year"), m: get("month") - 1, d: get("day") };
}
