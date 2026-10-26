// The post composer: write or edit a post with its live preview beside it. Only shown to the editor;
// the database refuses writes from anyone else whatever the page shows.

import { savePost, deletePost, TIME_ZONE } from "./data.js";
import { configured } from "./supabase.js";
import { prepareDrive, connectDrive, driveReady } from "./drive.js";

const PLATFORM_LIMITS = { x: 280, linkedin: 3000 };
const STATUS_OPTIONS = [
  ["draft", "Draft"],
  ["suggested", "Suggested"],
  ["scheduled", "Scheduled"],
  ["published", "Published"],
];

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

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
// preview(post) draws the platform preview; onSaved(post) and onDeleted(post) update the calendar.
export function openComposer({ existing = null, day, preview, onSaved, onDeleted }) {
  const dialog = el("dialog", "composer");
  dialog.setAttribute("aria-labelledby", "composer-title");

  const start = existing
    ? { date: dayFmt.format(new Date(existing.scheduledAt)), time: timeFmt.format(new Date(existing.scheduledAt)) }
    : { date: day, time: "09:00" };
  const removed = new Set();
  let files = [];

  const head = el("header", "composer-head");
  const title = el("h2", null, existing ? "Edit post" : "New post");
  title.id = "composer-title";
  const close = el("button", "icon-btn", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close without saving");
  head.append(title, close);

  const form = el("form", "composer-form");
  const platform = segmented("Platform", [["x", "X"], ["linkedin", "LinkedIn"]], existing?.platform ?? "x");
  const status = segmented("Status", STATUS_OPTIONS, existing?.status ?? "draft");

  const date = el("input", "field");
  date.type = "date";
  date.required = true;
  date.value = start.date;
  const time = el("input", "field");
  time.type = "time";
  time.required = true;
  time.value = start.time;
  const when = el("div", "cf-row");
  when.append(field("Date", date), field("Time, Manila", time));

  const copy = el("textarea", "field");
  copy.rows = 7;
  copy.required = true;
  copy.placeholder = "Write the post";
  copy.value = existing?.copy ?? "";
  const count = el("span", "cf-hint");

  const tags = el("input", "field");
  tags.placeholder = "VoiceAI, Datasets";
  tags.value = (existing?.hashtags ?? []).join(", ");

  const liveUrl = el("input", "field");
  liveUrl.type = "url";
  liveUrl.placeholder = "https://x.com/SilencioNetwork/status/…";
  liveUrl.value = existing?.externalUrl ?? "";
  const liveField = field("Live post link", liveUrl, el("span", "cf-hint", "Lets the stats link to it. Optional."));

  const assets = el("div", "cf-assets");
  const upload = el("input");
  upload.type = "file";
  upload.accept = "image/*,video/*";
  upload.multiple = true;
  upload.className = "visually-hidden";
  upload.id = `upload-${Date.now()}`;
  const pick = el("label", "pill", "Add photos or videos");
  pick.htmlFor = upload.id;
  pick.tabIndex = 0;
  pick.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); upload.click(); } });

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
    field("Status", status, null, "div"),
    when,
    field("Copy", copy, count),
    field("Hashtags", tags),
    liveField,
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
    const keep = (existing?.assets ?? []).filter((a) => !removed.has(a.id));
    const fresh = files.map((f) => ({ type: kind(f), url: f.preview, name: f.name, alt: "" }));
    return {
      id: existing?.id,
      platform: platform.value(),
      status: status.value(),
      scheduledAt: `${date.value}T${time.value || "09:00"}:00+08:00`,
      copy: copy.value.trim(),
      hashtags: parseTags(tags.value),
      externalUrl: liveUrl.value.trim(),
      assets: [...keep, ...fresh],
    };
  }

  function refresh() {
    const d = draft();
    const limit = PLATFORM_LIMITS[d.platform];
    const length = (d.hashtags.length ? `${d.copy}\n\n${d.hashtags.map((t) => `#${t}`).join(" ")}` : d.copy).length;
    count.textContent = length > limit ? `${length - limit} over the ${limit} limit` : `${length} / ${limit}`;
    count.classList.toggle("over", length > limit);
    liveField.hidden = d.status !== "published";

    assets.replaceChildren();
    for (const a of existing?.assets ?? []) {
      if (removed.has(a.id)) continue;
      assets.append(thumb(a.url, a.name, a.type, () => { removed.add(a.id); refresh(); }));
    }
    files.forEach((f, i) => assets.append(thumb(f.preview, f.name, kind(f), () => { files.splice(i, 1); refresh(); })));
    assets.append(pick, upload);

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
  upload.addEventListener("change", () => {
    for (const f of upload.files) {
      f.preview = URL.createObjectURL(f);
      files.push(f);
    }
    upload.value = "";
    refresh();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = draft();
    if (!d.copy) {
      msg.textContent = "Write the post first.";
      copy.focus();
      return;
    }
    // Drive access is asked for first, in the click itself, so the browser lets its popup open.
    const access = files.length && configured && !driveReady() ? connectDrive() : null;
    save.disabled = true;
    try {
      if (access) {
        msg.textContent = "Connecting Google Drive…";
        await access;
      }
      msg.textContent = files.length ? "Uploading to Drive and saving…" : "Saving…";
      const saved = await savePost(d, { files, removed: [...removed], existing });
      onSaved(saved);
      dialog.close();
    } catch (err) {
      msg.textContent = `Couldn't save: ${err.message}`;
      save.disabled = false;
    }
  });

  const dismiss = () => dialog.close();
  close.addEventListener("click", dismiss);
  cancel.addEventListener("click", dismiss);
  dialog.addEventListener("close", () => {
    for (const f of files) URL.revokeObjectURL(f.preview);
    dialog.remove();
  });

  prepareDrive();
  document.body.append(dialog);
  refresh();
  dialog.showModal();
  copy.focus();
}
