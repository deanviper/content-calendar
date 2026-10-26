// Post data for the calendar.
//
// The backend only needs to return an array in this shape:
//   {
//     id: string,
//     platform: "x" | "linkedin",
//     status: "scheduled" | "suggested",
//     scheduledAt: ISO 8601 string with offset, e.g. "2026-10-28T09:00:00+08:00",
//     copy: string,            // line breaks are kept
//     hashtags: string[],      // without the "#"
//     assets: { type: "image" | "video" | "file", url: string, name: string, alt?: string }[]
//   }
//
// Set API_URL to the endpoint once it exists. Until then the calendar renders SAMPLE_POSTS,
// which are placed relative to the current month so the screen never looks stale.

export const API_URL = null;

export const TIME_ZONE = "Asia/Manila";

export async function loadPosts() {
  if (API_URL) {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error(`Posts request failed: ${res.status}`);
    return res.json();
  }
  return samplePosts(new Date());
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
  [16, "x", "suggested", "18:00", "What should we measure next: classrooms, hospitals or offices?", [], []],
  [19, "linkedin", "suggested", "08:00", "Month in review: new countries, new sensors, and what the data says about city nights.", ["Update"], []],
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
      status,
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
