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
//     assets: { type: "image" | "video" | "file", url: string, name: string, alt?: string }[],
//     comments: { id: string, authorName: string, body: string, createdAt: string }[]
//   }
//
// With Supabase configured in config.js the posts come from the posts, post_assets and
// post_comments tables. Anyone with the link can read them and comment, no sign-in needed.
// Without Supabase the calendar renders sample posts placed relative to the current month.

import { configured, db } from "./supabase.js";

export const TIME_ZONE = "Asia/Manila";
export const TIME_ZONE_LABEL = "Manila, GMT+8";

// The account each platform preview is drawn as.
export const ACCOUNTS = {
  x: { name: "Silencio", handle: "@SilencioNetwork" },
  linkedin: { name: "Silencio AI", handle: "Company page" },
};

export async function loadPosts() {
  if (!configured) return samplePosts(new Date());
  const supabase = await db();
  const { data, error } = await supabase
    .from("posts")
    .select(`id, platform, status, scheduled_at, copy, hashtags,
      post_assets(type, storage_path, url, name, alt, position),
      post_comments(id, author_name, body, created_at)`)
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
    comments: p.post_comments
      .map((c) => ({ id: c.id, authorName: c.author_name, body: c.body, createdAt: c.created_at }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }));
}

export const COMMENT_LIMITS = { name: 60, body: 2000 };

// Saves a comment and returns it. Sample posts keep comments for this visit only.
export async function addComment(postId, authorName, body) {
  const name = authorName.trim();
  const text = body.trim();
  if (!name) throw new Error("Add your name so people know who commented.");
  if (!text) throw new Error("Write a comment first.");
  if (!configured) return { id: `local-${Date.now()}`, authorName: name, body: text, createdAt: new Date().toISOString() };
  const supabase = await db();
  const { data, error } = await supabase.rpc("add_comment", { p_post_id: postId, p_author_name: name, p_body: text });
  if (error) throw new Error(error.message);
  const c = data[0];
  return { id: c.id, authorName: c.author_name, body: c.body, createdAt: c.created_at };
}

const asset = (file, name, alt) => ({ type: "image", url: `assets/${file}`, name, alt });

// [day offset from today, platform, status, "HH:MM" Manila time, copy, hashtags, assets]
const SAMPLE = [
  [-9, "x", "scheduled", "09:00", "Voice AI reaches fewer than 3% of the world's 7,000 languages. The other 3.7 billion people don't exist as training data yet.", ["VoiceAI"], [asset("coverage.svg", "coverage.svg", "100 squares with 3 lit: voice AI reaches fewer than 3% of the world's languages")]],
  [-9, "linkedin", "scheduled", "10:30", "AI should understand everyone.\n\nMost speech models are trained on a handful of languages scraped from the open web. Silencio builds the other side of that: consent-cleared voice data recorded by real people, in their own language and their own environment, across 180+ countries.", ["VoiceAI", "SpeechRecognition"], [asset("voice-wave.svg", "voice-wave.svg", "Waveform beside the line: AI should understand everyone.")]],
  [-6, "x", "scheduled", "18:00", "Not scraped. Not synthetic. Real human voice, with consent captured on-chain.", ["Silencio"], []],
  [-3, "linkedin", "scheduled", "08:30", "Why do voice agents still fail in Manila, Lagos or Lima?\n\nAccents, code-switching and real background noise are missing from public datasets. We collect them on purpose, then transcribe with native speakers.", ["VoiceAgents", "ASR"], []],
  [-3, "x", "scheduled", "12:00", "Code-switching is how most of the world talks. Taglish, Spanglish, Hinglish. Your ASR should hear it too.", [], []],
  [0, "x", "scheduled", "09:00", "Monday drop: new off-the-shelf datasets for Southeast Asian languages, licensed and ready to integrate in days.", ["VoiceAI", "Datasets"], []],
  [0, "linkedin", "scheduled", "11:00", "2.5 million people, paid to be heard.\n\nEvery Silencio dataset starts with a real person on a real device. Consent captured on-chain, anonymous in the dataset, paid in stablecoin. They are the reason voice AI can reach 180 countries.", ["VoiceAI", "Data"], [asset("contributors.svg", "contributors.svg", "2.5M people, paid to be heard. 180+ countries, 1,000+ languages and dialects")]],
  [0, "x", "suggested", "19:30", "Which language should voice AI learn next? Reply with the one your grandparents speak.", [], []],
  [2, "x", "suggested", "10:00", "Training a voice agent? The test isn't the lab. It's a market stall, a moving jeepney, a kitchen with the radio on. Collect for that.", ["VoiceAgents"], []],
  [3, "linkedin", "scheduled", "09:00", "Procurement-ready voice data.\n\nIP-clean provenance from contributor to dataset, aligned with the EU AI Act and GDPR. The data we ship is the data your legal team will sign for.", ["AIGovernance", "Data"], []],
  [5, "x", "scheduled", "17:00", "Weekend: record 5 minutes in your own language with the Silencio app and get paid for it. 1,000+ languages and dialects so far.", ["Silencio"], [asset("voice-wave.svg", "voice-wave.svg", "Waveform beside the line: AI should understand everyone.")]],
  [8, "linkedin", "suggested", "10:00", "Three things we learned collecting voice data in 180+ countries:\n\n1. Accent matters more than language for ASR error rates.\n2. Real environments beat studio audio for agents.\n3. Native-speaker transcription catches what machines miss.", ["SpeechRecognition", "Research"], []],
  [8, "x", "suggested", "13:00", "Machine transcription still fails on the languages that need it most. That's why every Silencio dataset gets native-speaker transcription with multi-stage QA, including code-switching. Tell us which language your model struggles with and we'll show you a sample.", [], []],
  [12, "x", "scheduled", "09:00", "Custom collection: tell us the language, accent, environment and hours you need. The network delivers.", ["VoiceAI"], [asset("coverage.svg", "coverage.svg", "100 squares with 3 lit: voice AI reaches fewer than 3% of the world's languages")]],
  [12, "linkedin", "scheduled", "09:30", "On-demand voice data collection is live for teams building voice agents, speech translation and TTS.\n\nSpecify language, region, speaker mix and acoustic conditions. We source it from 2.5M contributors and deliver in the format your team already uses.", ["VoiceAgents", "TTS"], [asset("coverage.svg", "coverage.svg", "100 squares with 3 lit: voice AI reaches fewer than 3% of the world's languages")]],
  [16, "x", "draft", "18:00", "What should we collect next: Tagalog call-centre audio, Yoruba market speech, or Quechua storytelling?", [], []],
  [19, "linkedin", "draft", "08:00", "Month in review: new languages added, hours delivered, and what frontier labs asked us for.", ["Update"], []],
  [22, "x", "scheduled", "12:00", "Community call this Thursday for contributors: payouts, new recording tasks and the languages we need most.", ["Silencio"], []],
];

const SAMPLE_COMMENTS = {
  6: [{ id: "c1", authorName: "Anton", body: "Strong. Can we add the 1,000+ languages line?", createdAt: "2026-10-25T09:12:00+08:00" }],
  7: [{ id: "c2", authorName: "Mia", body: "Love this one. Maybe pin it?", createdAt: "2026-10-25T14:40:00+08:00" }],
};

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
      comments: SAMPLE_COMMENTS[i] ?? [],
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
