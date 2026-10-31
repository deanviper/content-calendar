// The post composer: write or edit a post with its live preview beside it. Only shown to the editor;
// the database refuses writes from anyone else whatever the page shows.

import { savePost, deletePost, VIEWER_TIME_ZONE, zoneLabel, zonedToISO } from "./data.js";
import { configured, signInWithGoogle } from "./supabase.js";
import { driveAccess, driveProblem, DriveAccessError } from "./drive.js";

// A post being written when the editor has to sign in again for Drive is kept here across the
// trip to Google and reopened when they come back. Picked files can't be kept, only their text.
const DRAFT_KEY = "composerDraft";

export function takeStashedDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const PLATFORM_LIMITS = { x: 280, linkedin: 3000 };

// Dates and times are written in the editor's own time zone and saved as the moment they stand for.
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: VIEWER_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: VIEWER_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function segmented(label, options, value) {
  const group = el("div", "segmented");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  for (const [v, text] of options) {
    const b = el("button", null, text);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.value = v;
    b.setAttribute("aria-checked", String(v === value));
    group.append(b);
  }
  group.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    for (const x of group.children) x.setAttribute("aria-checked", String(x === b));
    group.dispatchEvent(new Event("change", { bubbles: true }));
  });
  group.value = () => group.querySelector('[aria-checked="true"]').dataset.value;
  return group;
}

// Controls made of several buttons get a div, not a label: a label would forward clicks to its first button.
function field(labelText, control, hint, tag = "label") {
  const wrap = el(tag, "cf");
  wrap.append(el("span", "cf-label", labelText), control);
  if (hint) wrap.append(hint);
  return wrap;
}

const kind = (f) => (f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : "file");

function parseTags(text) {
  return [...new Set(text.split(/[\s,]+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean))];
}

// existing: a post to edit, or null for a new one. day: "YYYY-MM-DD" for a new post.
// restore: a stashed draft ({ draft, removed }) to carry on with after signing in again.
// preview(post) draws the platform preview; onSaved(post) and onDeleted(post) update the calendar.
export function openComposer({ existing = null, day, restore = null, preview, onSaved, onDeleted }) {
  const dialog = el("dialog", "composer");
  dialog.setAttribute("aria-labelledby", "composer-title");

  const base = restore?.draft ?? existing;
  const start = base
    ? { date: dayFmt.format(new Date(base.scheduledAt)), time: timeFmt.format(new Date(base.scheduledAt)) }
    : { date: day, time: "09:00" };
  const removed = new Set(restore?.removed ?? []);
  // Each new file and each existing asset belongs to a tweet: null is the first, otherwise a reply row.
  let files = [];
  const assetRow = new Map();

  const head = el("header", "composer-head");
  const title = el("h2", null, existing ? "Edit post" : "New post");
  title.id = "composer-title";
  const close = el("button", "icon-btn", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close without saving");
  head.append(title, close);

  const form = el("form", "composer-form");
  const platform = segmented("Platform", [["x", "X"], ["linkedin", "LinkedIn"]], base?.platform ?? "x");

  const date = el("input", "field");
  date.type = "date";
  date.required = true;
  date.value = start.date;
  const time = el("input", "field");
  time.type = "time";
  time.required = true;
  time.value = start.time;
  const when = el("div", "cf-row");
  when.append(field("Date", date), field(`Your time, ${zoneLabel(VIEWER_TIME_ZONE)}`, time));

  const copy = el("textarea", "field");
  copy.rows = 7;
  copy.required = true;
  copy.placeholder = "Write the post";
  copy.value = base?.copy ?? "";
  const count = el("span", "cf-hint");

  // X threads: follow-up tweets that go out as replies to the first one, like X's own "+" button.
  const thread = el("div", "cf-thread");
  const addTweet = el("button", "pill", "Add a tweet to the thread");
  addTweet.type = "button";
  const replies = [];
  const tweetOf = (row) => (row ? replies.indexOf(row) + 1 : 0);
  function addReply(text = "", focus = false) {
    const row = el("div", "cf-reply");
    const area = el("textarea", "field");
    area.rows = 3;
    area.placeholder = "Add another tweet";
    area.value = text;
    area.setAttribute("aria-label", `Tweet ${replies.length + 2} in the thread`);
    const n = el("span", "cf-hint");
    const rm = el("button", "cf-reply-remove", "×");
    rm.type = "button";
    rm.setAttribute("aria-label", "Remove this tweet from the thread");
    const strip = el("div", "cf-assets cf-reply-assets");
    const [pickOne, uploadOne] = picker("Add photos to this tweet");
    const reply = { area, n, strip, pick: pickOne, upload: uploadOne };
    rm.addEventListener("click", () => {
      // The tweet's photos go with it.
      for (const [id, r] of assetRow) if (r === reply) removed.add(id);
      files = files.filter((f) => f.row !== reply);
      replies.splice(replies.indexOf(reply), 1);
      row.remove();
      refresh();
    });
    uploadOne.addEventListener("change", () => addFiles(uploadOne, reply));
    row.append(area, rm, n, strip);
    replies.push(reply);
    thread.insertBefore(row, addTweet);
    if (focus) area.focus();
    return reply;
  }
  thread.append(addTweet);
  addTweet.addEventListener("click", () => { addReply("", true); refresh(); });
  const rows = (base?.thread ?? []).map((t) => addReply(t));
  for (const a of existing?.assets ?? []) assetRow.set(a.id, (base?.platform === "x" && rows[(a.reply ?? 0) - 1]) || null);
  const threadField = field("Thread", thread, null, "div");

  const tags = el("input", "field");
  tags.placeholder = "VoiceAI, Datasets";
  tags.value = (base?.hashtags ?? []).join(", ");


  const assets = el("div", "cf-assets");
  const [pick, upload] = picker("Add photos or videos");

  // A file picker shown as a pill; returns [label, input].
  function picker(text) {
    const input = el("input");
    input.type = "file";
    input.accept = "image/*,video/*";
    input.multiple = true;
    input.className = "visually-hidden";
    input.id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const label = el("label", "pill", text);
    label.htmlFor = input.id;
    label.tabIndex = 0;
    label.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    return [label, input];
  }

  const msg = el("p", "cf-msg");
  msg.setAttribute("role", "status");

  const foot = el("footer", "composer-foot");
  const save = el("button", "pill primary", existing ? "Save changes" : "Add to calendar");
  save.type = "submit";
  const cancel = el("button", "pill", "Cancel");
  cancel.type = "button";
  const right = el("div", "composer-actions");
  right.append(cancel, save);
  if (existing && existing.status !== "published") {
    const del = el("button", "pill danger", "Delete");
    del.type = "button";
    del.addEventListener("click", async () => {
      if (!confirm("Delete this post and its images? This can't be undone.")) return;
      try {
        await deletePost(existing);
        onDeleted(existing);
        dialog.close();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
    foot.append(del);
  }
  foot.append(right);

  form.append(
    field("Platform", platform, null, "div"),
    when,
    field("Copy", copy, count),
    threadField,
    field("Hashtags", tags),
    field("Photos and videos", assets, configured ? el("span", "cf-hint", "Saved to the Silencio content calendar folder in your Google Drive, shared by link so everyone can preview them.") : null, "div"),
    msg,
  );

  const side = el("aside", "composer-preview");
  side.setAttribute("aria-label", "Preview");
  const sideLabel = el("p", "cf-label", "Preview");
  const sideBody = el("div");
  side.append(sideLabel, sideBody);

  const body = el("div", "composer-body");
  body.append(form, side);
  dialog.append(head, body, foot);
  // The footer's submit button sits outside the form element so it can span the dialog.
  save.setAttribute("form", (form.id = `composer-${Date.now()}`));

  function draft() {
    const x = platform.value() === "x";
    const keep = (existing?.assets ?? []).filter((a) => !removed.has(a.id)).map((a) => ({ ...a, reply: x ? tweetOf(assetRow.get(a.id)) : 0 }));
    const fresh = files.map((f) => ({ type: kind(f), url: f.preview, name: f.name, alt: "", reply: x ? tweetOf(f.row) : 0 }));
    return {
      id: existing?.id,
      platform: platform.value(),
      // Every post is written as a draft; the stats collector marks it posted once it is live.
      status: existing?.status === "published" ? "published" : "draft",
      scheduledAt: zonedToISO(date.value, time.value || "09:00", VIEWER_TIME_ZONE),
      copy: copy.value.trim(),
      hashtags: parseTags(tags.value),
      thread: platform.value() === "x" ? replies.map((r) => r.area.value.trim()).filter(Boolean) : [],
      externalUrl: existing?.externalUrl ?? "",
      assets: [...keep, ...fresh],
    };
  }

  function refresh() {
    const d = draft();
    const limit = PLATFORM_LIMITS[d.platform];
    const length = (d.hashtags.length ? `${d.copy}\n\n${d.hashtags.map((t) => `#${t}`).join(" ")}` : d.copy).length;
    count.textContent = length > limit ? `${length - limit} over the ${limit} limit` : `${length} / ${limit}`;
    count.classList.toggle("over", length > limit);
    threadField.hidden = d.platform !== "x";
    for (const r of replies) {
      const len = r.area.value.trim().length;
      r.n.textContent = len > limit ? `${len - limit} over the ${limit} limit` : `${len} / ${limit}`;
      r.n.classList.toggle("over", len > limit);
    }
    addTweet.textContent = replies.length ? "Add another tweet" : "Add a tweet to the thread";

    // Photos sit under the tweet they go with; on LinkedIn they all belong to the one post.
    const strips = [assets, ...replies.map((r) => r.strip)];
    const stripOf = (row) => (d.platform === "x" && row ? row.strip : assets);
    for (const st of strips) st.replaceChildren();
    for (const a of existing?.assets ?? []) {
      if (removed.has(a.id)) continue;
      stripOf(assetRow.get(a.id)).append(thumb(a.url, a.name, a.type, () => { removed.add(a.id); refresh(); }));
    }
    for (const f of files) stripOf(f.row).append(thumb(f.preview, f.name, kind(f), () => { files = files.filter((g) => g !== f); refresh(); }));
    assets.append(pick, upload);
    for (const r of replies) r.strip.append(r.pick, r.upload);

    sideBody.replaceChildren(d.copy ? preview(d) : el("p", "cf-hint", "The preview appears as you write."));
  }

  // A Drive video's url is its thumbnail image; a video picked here is shown from the file.
  function thumb(url, name, type, onRemove) {
    const t = el("figure", "cf-thumb");
    const img = el(type === "video" && url.startsWith("blob:") ? "video" : "img");
    img.src = url;
    if (img.tagName === "IMG") img.alt = "";
    else img.muted = true;
    const rm = el("button", "cf-remove", "×");
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove ${name}`);
    rm.addEventListener("click", onRemove);
    t.append(img, rm);
    return t;
  }

  form.addEventListener("input", refresh);
  form.addEventListener("change", refresh);
  function addFiles(input, row) {
    for (const f of input.files) {
      f.preview = URL.createObjectURL(f);
      f.row = row;
      files.push(f);
    }
    input.value = "";
    refresh();
  }
  upload.addEventListener("change", () => addFiles(upload, null));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = draft();
    if (!d.copy) {
      msg.textContent = "Write the post first.";
      copy.focus();
      return;
    }
    save.disabled = true;
    try {
      // Google's Drive access comes with a sign-in and lasts an hour. Without it the editor signs
      // in again and comes back to this post.
      if (files.length && configured && !(await driveAccess())) throw new DriveAccessError();
      msg.textContent = files.length ? "Uploading to Drive and saving…" : "Saving…";
      for (const f of files) f.reply = d.platform === "x" ? tweetOf(f.row) : 0;
      const saved = await savePost(d, { files, removed: [...removed], existing });
      onSaved(saved);
      dialog.close();
    } catch (err) {
      save.disabled = false;
      if (err instanceof DriveAccessError) askForSignIn(d);
      else msg.textContent = `Couldn't save: ${err.message}`;
    }
  });

  function askForSignIn(d) {
    const again = el("button", "link", "Sign in with Google again");
    again.type = "button";
    again.addEventListener("click", async () => {
      try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ draft: d, removed: [...removed] })); } catch { /* the text is lost */ }
      try { await signInWithGoogle(); } catch (err) { msg.textContent = `Sign-in failed: ${err.message}`; }
    });
    const why = restore ? driveProblem() ?? "The sign-in came back without Google's Drive access." : null;
    msg.replaceChildren(why ? `${why} ` : "Uploading needs Google Drive access. ", again,
      " and allow Drive when Google asks (tick its box if it shows one). This post comes back after; add the photos and videos again.");
  }

  const dismiss = () => dialog.close();
  close.addEventListener("click", dismiss);
  cancel.addEventListener("click", dismiss);
  dialog.addEventListener("close", () => {
    for (const f of files) URL.revokeObjectURL(f.preview);
    dialog.remove();
  });

  if (restore) {
    msg.textContent = "Signed in again. Add the photos and videos, then save.";
    driveAccess().then((ok) => { if (!ok) askForSignIn(draft()); });
  }
  document.body.append(dialog);
  refresh();
  dialog.showModal();
  copy.focus();
}
