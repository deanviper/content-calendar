import { assertEquals } from "jsr:@std/assert@1";
import { matchDraft, similarity } from "./match.ts";

const draft = (id: string, copy: string, scheduledAt = "2026-10-28T09:00:00+08:00", hashtags: string[] = []) =>
  ({ id, copy, hashtags, scheduledAt });

Deno.test("an X post with a shortened link and hashtags matches its draft", () => {
  const drafts = [
    draft("a", "Monday drop: new off-the-shelf datasets for Southeast Asian languages, licensed and ready to integrate in days.", undefined, ["VoiceAI", "Datasets"]),
    draft("b", "Which language should voice AI learn next? Reply with the one your grandparents speak."),
  ];
  const live = {
    copy: "Monday drop: new off-the-shelf datasets for Southeast Asian languages, licensed and ready to integrate in days.\n\n#VoiceAI #Datasets https://t.co/abc123",
    publishedAt: "2026-10-28T01:05:00Z",
  };
  assertEquals(matchDraft(live, drafts)?.id, "a");
});

Deno.test("small edits made before posting still match", () => {
  const live = { copy: "Which language should Voice AI learn next? Reply with the one your grandmother speaks!", publishedAt: "2026-10-29T03:00:00Z" };
  assertEquals(matchDraft(live, [draft("b", "Which language should voice AI learn next? Reply with the one your grandparents speak.")])?.id, "b");
});

Deno.test("a different post on the same topic doesn't match", () => {
  const live = { copy: "Voice AI reaches fewer than 3% of the world's languages. Help us change that.", publishedAt: "2026-10-28T01:00:00Z" };
  assertEquals(matchDraft(live, [draft("b", "Which language should voice AI learn next? Reply with the one your grandparents speak.")]), null);
});

Deno.test("a post far from the planned day doesn't match", () => {
  const live = { copy: "Which language should voice AI learn next? Reply with the one your grandparents speak.", publishedAt: "2027-01-15T01:00:00Z" };
  assertEquals(matchDraft(live, [draft("b", "Which language should voice AI learn next? Reply with the one your grandparents speak.")]), null);
});

Deno.test("the closest of two similar drafts wins", () => {
  const drafts = [
    draft("old", "Record 5 minutes in your own language with the Silencio app."),
    draft("new", "Weekend: record 5 minutes in your own language with the Silencio app and get paid for it."),
  ];
  const live = { copy: "Weekend: record 5 minutes in your own language with the Silencio app and get paid for it.", publishedAt: "2026-10-31T09:00:00Z" };
  assertEquals(matchDraft(live, drafts)?.id, "new");
});

Deno.test("similarity ignores case, links and punctuation", () => {
  assertEquals(similarity("Hello, World! https://t.co/x", "hello world"), 1);
});
