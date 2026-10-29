import { loadPosts, addComment, deleteComment, savePost, COMMENT_LIMITS, dateIn, zoneLabel, TIME_ZONE, VIEWER_TIME_ZONE, ACCOUNTS } from "./data.js";
import { currentUser, signInWithGoogle, signOut, onAuthChange } from "./supabase.js";
import { openComposer, takeStashedDraft } from "./composer.js";
import { initThemeToggle } from "./theme.js";

const PLATFORMS = {
  x: { name: "X", limit: 280 },
  linkedin: { name: "LinkedIn", limit: 3000, fold: 210 },
};
// Order is the order of the status filters and of the workflow.
// A post is a draft until the stats collector finds it live on X or LinkedIn, then it is posted.
const STATUSES = {
  draft: "Draft",
  published: "Posted",
};
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_LINES = 3;

const $ = (id) => document.getElementById(id);
const els = {
  title: $("period-title"),
  sub: $("period-sub"),
  statuses: $("statuses"),
  grid: $("grid"),
  weekdays: $("weekdays"),
  weeks: $("weeks"),
  help: $("help"),
  day: $("day"),
  player: $("player"),
  newPost: $("new-post"),
  account: $("account"),
};

// Times show in the viewer's own time zone unless they switch to Manila, where posts are planned.
// Days follow the same zone, so a post sits on the day it goes out for the person reading.
function storedZone() {
  try { return localStorage.getItem("timeZone"); } catch { return null; }
}
let zone = [TIME_ZONE, VIEWER_TIME_ZONE].includes(storedZone()) ? storedZone() : VIEWER_TIME_ZONE;
let today, todayKey, timeFmt, dayKeyFmt, commentTimeFmt;
function setZoneFormats() {
  today = dateIn(new Date(), zone);
  todayKey = key(today.y, today.m, today.d);
  timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit" });
  dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  commentTimeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
setZoneFormats();

function setZone(next) {
  zone = next;
  try { localStorage.setItem("timeZone", next); } catch { /* lasts this visit */ }
  setZoneFormats();
  state.byDay = index(state.posts);
  render();
}

const state = {
  posts: [],
  byDay: new Map(),
  view: "month",
  platform: "all",
  statuses: new Set(Object.keys(STATUSES)),
  selected: parseHash() ?? todayKey,
  // The selected day opens in a pop-up; closing it keeps the selection. A link to a day opens it.
  open: parseHash() !== null,
  focusPost: null,
  // The signed-in editor, if any. Everyone else gets the read-and-comment calendar.
  user: null,
};

const isEditor = () => state.user?.editor === true;

const monthFmt = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const longDayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const shortDayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" });
const rangeFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

// Dates are handled as "YYYY-MM-DD" keys in the chosen time zone.

function key(y, m, d) {
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
}

function fromKey(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(k, n) {
  const d = fromKey(k);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekStart(k) {
  return addDays(k, -((fromKey(k).getUTCDay() + 6) % 7));
}

function parseHash() {
  const h = location.hash.slice(1);
  return /^\d{4}-\d{2}-\d{2}$/.test(h) && !Number.isNaN(fromKey(h).getTime()) ? h : null;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function matchesFilters(post) {
  return (state.platform === "all" || post.platform === state.platform) && state.statuses.has(post.status);
}

function postsOn(k) {
  return (state.byDay.get(k) ?? []).filter(matchesFilters);
}

function fullText(post) {
  const tags = post.hashtags.map((t) => `#${t}`).join(" ");
  return tags ? `${post.copy}\n\n${tags}` : post.copy;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(platform) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "pf");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${platform}`);
  svg.append(use);
  return svg;
}

// A post's status is read from one small mark: filled for what will go out, amber for what waits on
// a decision, an outline for drafts, grey for what has already gone out.
function mark(status) {
  const m = el("span", `mark m-${status}`);
  m.setAttribute("aria-hidden", "true");
  return m;
}

// The period on screen: a month of weeks, or one week.

function periodKeys() {
  let start;
  let days;
  let inPeriod;
  if (state.view === "week") {
    start = weekStart(state.selected);
    days = 7;
    inPeriod = () => true;
  } else {
    const d = fromKey(state.selected);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const first = key(y, m, 1);
    start = weekStart(first);
    const lead = (fromKey(first).getUTCDay() + 6) % 7;
    days = Math.ceil((lead + new Date(Date.UTC(y, m + 1, 0)).getUTCDate()) / 7) * 7;
    inPeriod = (k) => fromKey(k).getUTCMonth() === m;
  }
  return Array.from({ length: days }, (_, i) => addDays(start, i)).map((k) => ({ k, inPeriod: inPeriod(k) }));
}

// Rendering

function render() {
  const keys = periodKeys();
  const inPeriod = keys.filter((d) => d.inPeriod);
  const platformPosts = inPeriod.flatMap(({ k }) =>
    (state.byDay.get(k) ?? []).filter((p) => state.platform === "all" || p.platform === state.platform));
  const shown = platformPosts.filter((p) => state.statuses.has(p.status));

  if (state.view === "week") {
    const first = fromKey(inPeriod[0].k);
    const last = fromKey(inPeriod[6].k);
    els.title.textContent = `${rangeFmt.format(first)} – ${rangeFmt.format(last)}`;
  } else {
    els.title.textContent = monthFmt.format(fromKey(state.selected));
  }

  const per = (pf) => shown.filter((p) => p.platform === pf).length;
  const sub = [shown.length ? plural(shown.length, "post") : `Nothing planned this ${state.view} yet`];
  if (shown.length && state.platform === "all") sub.push(`${per("x")} on X`, `${per("linkedin")} on LinkedIn`);
  sub.push(`times in ${zone === VIEWER_TIME_ZONE && zone !== TIME_ZONE ? `your time, ${zoneLabel(zone)}` : zoneLabel(zone)}`);
  els.sub.textContent = sub.join(" · ");
  if (VIEWER_TIME_ZONE !== TIME_ZONE) {
    const other = zone === TIME_ZONE ? VIEWER_TIME_ZONE : TIME_ZONE;
    const sw = el("button", "link", other === TIME_ZONE ? "Show Manila time" : "Show my time");
    sw.type = "button";
    sw.addEventListener("click", () => setZone(other));
    els.sub.append(" · ", sw);
  }

  renderStatuses(platformPosts);
  renderGrid(keys);
}

function renderStatuses(platformPosts) {
  els.statuses.replaceChildren(...Object.entries(STATUSES).map(([status, label]) => {
    const count = platformPosts.filter((p) => p.status === status).length;
    const btn = el("button", "filter");
    btn.type = "button";
    btn.dataset.status = status;
    btn.setAttribute("aria-pressed", String(state.statuses.has(status)));
    btn.append(mark(status), el("span", null, label), el("span", "n", String(count)));
    return btn;
  }));
}

function renderGrid(keys) {
  els.grid.dataset.view = state.view;
  els.weekdays.replaceChildren(...keys.slice(0, 7).map(({ k }) => {
    const label = state.view === "week" ? shortDayFmt.format(fromKey(k)) : WEEKDAYS[(fromKey(k).getUTCDay() + 6) % 7];
    const head = el("span", k === todayKey && state.view === "week" ? "is-today" : null, label);
    head.setAttribute("role", "columnheader");
    return head;
  }));

  const rows = [];
  for (let w = 0; w < keys.length / 7; w++) {
    const row = el("div", "week");
    row.setAttribute("role", "row");
    row.append(...keys.slice(w * 7, w * 7 + 7).map(({ k, inPeriod }) => renderCell(k, inPeriod)));
    rows.push(row);
  }
  els.weeks.replaceChildren(...rows);
  renderDay();
}

// The open day shows in a pop-up over the calendar. It re-renders with the grid and keeps its
// scroll position, unless the day changed.
function renderDay() {
  if (!state.open) {
    if (els.day.open) els.day.close();
    return;
  }
  const top = els.day.dataset.key === state.selected ? els.day.scrollTop : 0;
  els.day.dataset.key = state.selected;
  els.day.setAttribute("aria-label", longDayFmt.format(fromKey(state.selected)));
  els.day.replaceChildren(renderSheet(state.selected));
  if (!els.day.open) els.day.showModal();
  els.day.scrollTop = top;
  if (state.focusPost) {
    els.day.querySelector(`.post[data-post="${state.focusPost}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    state.focusPost = null;
  }
}

function closeDay() {
  state.open = false;
  history.replaceState(null, "", location.pathname + location.search);
  render();
  els.weeks.querySelector(`.cell[data-key="${state.selected}"]`)?.focus();
}

function renderCell(k, inPeriod) {
  const d = fromKey(k);
  const posts = postsOn(k);
  const cell = el("div", "cell");
  cell.dataset.key = k;
  cell.setAttribute("role", "gridcell");
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) cell.classList.add("weekend");
  if (!inPeriod) cell.classList.add("outside");
  if (k === todayKey) cell.classList.add("today");
  const selected = k === state.selected;
  cell.setAttribute("aria-selected", String(selected));
  cell.setAttribute("aria-haspopup", "dialog");
  cell.tabIndex = selected ? 0 : -1;
  cell.setAttribute("aria-label",
    `${longDayFmt.format(d)}${k === todayKey ? ", today" : ""}, ${posts.length ? plural(posts.length, "post") : "nothing planned"}`);

  const date = el("span", "date", String(d.getUTCDate()));
  date.setAttribute("aria-hidden", "true");
  cell.append(date);

  if (posts.length) {
    const max = state.view === "week" ? Infinity : MAX_LINES;
    const list = el("span", "lines");
    list.setAttribute("aria-hidden", "true");
    for (const post of posts.slice(0, max)) list.append(renderLine(post));
    if (posts.length > max) list.append(el("span", "more", `+${posts.length - max} more`));
    cell.append(list);
  }
  return cell;
}

function renderLine(post) {
  const line = el("span", `line s-${post.status}`);
  line.dataset.post = post.id;
  line.append(mark(post.status), el("span", "line-time", timeFmt.format(new Date(post.scheduledAt))), icon(post.platform));
  if (state.view === "week") {
    line.append(el("span", "line-text", post.copy.split("\n")[0]));
    if (post.status === "draft") line.append(el("span", "line-status", STATUSES.draft));
  } else {
    line.append(el("span", "line-text", post.copy.split("\n")[0]));
  }
  return line;
}

// The day sheet: the selected day's posts, read the way each network will show them.

function renderSheet(k) {
  const posts = postsOn(k);
  const all = state.byDay.get(k) ?? [];
  const sheet = el("section", "sheet");

  const head = el("header", "sheet-head");
  const title = el("div");
  title.append(el("h2", null, longDayFmt.format(fromKey(k))));
  const sub = [];
  if (k === todayKey) sub.push("Today");
  sub.push(posts.length ? plural(posts.length, "post") : "Nothing planned");
  title.append(el("p", "sub", sub.join(" · ")));
  const tools = el("div", "nav");
  const prev = el("button", "icon-btn");
  prev.type = "button";
  prev.dataset.step = "-1";
  prev.setAttribute("aria-label", "Previous day");
  prev.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  const next = prev.cloneNode(true);
  next.dataset.step = "1";
  next.setAttribute("aria-label", "Next day");
  next.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  const close = el("button", "pill", "Close");
  close.type = "button";
  close.dataset.close = "";
  if (isEditor()) {
    const add = el("button", "pill primary", "New post");
    add.type = "button";
    add.dataset.compose = k;
    tools.prepend(add);
  }
  tools.append(prev, next, close);
  head.append(title, tools);
  sheet.append(head);

  if (!posts.length) {
    const hidden = all.length - posts.length;
    sheet.append(el("p", "empty", hidden
      ? `${plural(hidden, "post")} on this day ${hidden === 1 ? "is" : "are"} hidden by the filters.`
      : "No posts for this day."));
    return sheet;
  }
  const list = el("div", "posts");
  list.append(...posts.map(renderPost));
  sheet.append(list);
  return sheet;
}

function renderPost(post) {
  const platform = PLATFORMS[post.platform];
  const article = el("article", `post s-${post.status}`);
  article.dataset.post = post.id;

  const meta = el("header", "post-meta");
  const name = el("span", "post-platform", platform.name);
  const time = el("time", null, timeFmt.format(new Date(post.scheduledAt)));
  time.dateTime = post.scheduledAt;
  const status = el("span", `status s-${post.status}`);
  status.append(mark(post.status), STATUSES[post.status] ?? post.status);
  meta.append(name, time, status);
  article.append(meta, post.platform === "x" ? previewX(post) : previewLinkedIn(post));

  const length = fullText(post).length;
  const thread = post.platform === "x" ? post.thread ?? [] : [];
  const foot = el("footer", "post-foot");
  const count = el("span", "count");
  const longReply = thread.findIndex((t) => t.length > platform.limit);
  if (length > platform.limit) {
    count.classList.add("over");
    count.textContent = `${length - platform.limit} characters over the ${platform.limit} limit`;
  } else if (longReply >= 0) {
    count.classList.add("over");
    count.textContent = `Tweet ${longReply + 2} is ${thread[longReply].length - platform.limit} over the ${platform.limit} limit`;
  } else {
    count.textContent = thread.length ? `${length} / ${platform.limit} · thread of ${thread.length + 1}` : `${length} / ${platform.limit}`;
  }
  const actions = el("span", "actions");
  for (const a of post.assets) {
    const dl = el("a", "pill", "Download");
    dl.href = a.download ?? a.url;
    dl.download = a.name;
    dl.setAttribute("aria-label", `Download ${a.name}`);
    actions.append(dl);
  }
  if (post.externalUrl) {
    const live = el("a", "pill", post.platform === "x" ? "Open on X" : "Open on LinkedIn");
    live.href = post.externalUrl;
    live.target = "_blank";
    live.rel = "noopener";
    actions.append(live);
  }
  const copyLabel = thread.length ? "Copy first tweet" : "Copy text";
  const copy = el("button", "pill primary", copyLabel);
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(fullText(post));
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy failed";
    }
    setTimeout(() => { copy.textContent = copyLabel; }, 1600);
  });
  actions.append(copy);
  if (isEditor()) {
    const edit = el("button", "pill", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => compose(post));
    actions.prepend(edit);
  }
  foot.append(count, actions);
  article.append(foot, renderComments(post));
  return article;
}

// Comments: anyone can leave one, signed in or not. The name is remembered on this device.


function rememberedName() {
  try { return localStorage.getItem("commentName") ?? ""; } catch { return ""; }
}

function rememberName(name) {
  try { localStorage.setItem("commentName", name); } catch { /* private mode: just don't remember */ }
}

function commentItem(c, post) {
  const li = el("li", "comment");
  const meta = el("div", "comment-meta");
  const when = el("time", null, commentTimeFmt.format(new Date(c.createdAt)));
  when.dateTime = c.createdAt;
  meta.append(el("span", "comment-name", c.authorName), when);
  if (isEditor()) {
    const rm = el("button", "comment-delete", "Delete");
    rm.type = "button";
    rm.setAttribute("aria-label", `Delete ${c.authorName}'s comment`);
    rm.addEventListener("click", async () => {
      try {
        await deleteComment(c.id);
        post.comments = post.comments.filter((x) => x.id !== c.id);
        render();
      } catch (err) {
        rm.textContent = "Couldn't delete";
        console.error(err);
      }
    });
    meta.append(rm);
  }
  li.append(meta, el("p", "comment-body", c.body));
  return li;
}

function renderComments(post) {
  const section = el("section", "comments");
  const heading = el("h3", null, post.comments.length ? plural(post.comments.length, "comment") : "Comments");
  const list = el("ol", "comment-list");
  list.append(...post.comments.map((c) => commentItem(c, post)));

  const form = el("form", "comment-form");
  const name = el("input", "field");
  name.name = "name";
  name.placeholder = "Your name";
  name.autocomplete = "name";
  name.maxLength = COMMENT_LIMITS.name;
  name.required = true;
  name.value = rememberedName();
  name.setAttribute("aria-label", "Your name");
  const body = el("textarea", "field");
  body.name = "body";
  body.rows = 1;
  body.placeholder = "Leave a note";
  body.maxLength = COMMENT_LIMITS.body;
  body.required = true;
  body.setAttribute("aria-label", "Comment");
  const send = el("button", "pill", "Send");
  send.type = "submit";
  const msg = el("p", "comment-msg");
  msg.setAttribute("role", "status");
  form.append(name, body, send, msg);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    send.disabled = true;
    msg.textContent = "";
    try {
      const c = await addComment(post.id, name.value, body.value);
      rememberName(c.authorName);
      post.comments.push(c);
      list.append(commentItem(c, post));
      heading.textContent = plural(post.comments.length, "comment");
      body.value = "";
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      send.disabled = false;
    }
  });

  section.append(heading, list, form);
  return section;
}

// Previews drawn the way each network lays a post out, so copy is judged in place.

function author(platform) {
  const acc = ACCOUNTS[platform];
  const row = el("div", "pv-author");
  const avatar = el("img", "pv-avatar");
  avatar.src = "assets/mark.svg";
  avatar.alt = "";
  const who = el("div", "pv-who");
  const name = el("span", "pv-name", acc.name);
  if (acc.badge) name.append(badge(platform, acc.badge));
  who.append(name, el("span", "pv-handle", acc.handle));
  row.append(avatar, who);
  return row;
}

const BADGE_LABELS = { gold: "Verified organisation", blue: "Verified", grey: "Verified government or official account", verified: "Verified page" };

// X's scalloped check, coloured by type, and LinkedIn's verified shield.
function badge(platform, kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `pv-badge b-${kind}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", BADGE_LABELS[kind] ?? "Verified");
  svg.innerHTML = platform === "x"
    ? '<path fill="currentColor" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91C2.63 9.33 1.75 10.57 1.75 12s.88 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z"/><path fill="#fff" d="m10.54 16.2-3.75-3.74 1.41-1.42 2.34 2.34 5.29-5.29 1.41 1.42z"/>'
    : '<path fill="currentColor" d="M12 2 4 5v6.1c0 5 3.4 9.7 8 10.9 4.6-1.2 8-5.9 8-10.9V5z"/><path fill="#fff" d="m10.6 15.4-3.3-3.3 1.4-1.4 1.9 1.9 4.7-4.7 1.4 1.4z"/>';
  return svg;
}

function textWithTags(post, node) {
  node.append(post.copy);
  if (post.hashtags.length) {
    node.append("\n\n");
    post.hashtags.forEach((t, i) => {
      if (i) node.append(" ");
      node.append(el("span", "pv-tag", `#${t}`));
    });
  }
  return node;
}

// Images and videos, up to four, as the platform would lay them out. A Drive video shows its first
// frame and plays in Drive's own player in a pop-up; a video picked in the composer plays from the file.
function media(post) {
  const items = post.assets.filter((a) => a.type === "image" || a.type === "video");
  if (!items.length) return null;
  const wrap = el("div", `pv-media n${Math.min(items.length, 4)}`);
  for (const a of items.slice(0, 4)) {
    let node;
    if (a.type === "video" && a.embed) {
      node = el("button", "pv-video");
      node.type = "button";
      node.setAttribute("aria-label", `Play ${a.alt || a.name}`);
      const poster = el("img");
      poster.src = a.url;
      poster.alt = "";
      poster.loading = "lazy";
      poster.referrerPolicy = "no-referrer";   // Drive's thumbnails refuse some referrers
      poster.addEventListener("error", () => poster.remove(), { once: true });
      const play = el("span", "pv-play");
      play.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
      node.append(poster, play);
      node.addEventListener("click", () => openPlayer(a.embed, a.alt || a.name));
    } else if (a.type === "video") {
      node = el("video");
      node.src = a.url;
      node.controls = true;
      node.preload = "metadata";
      node.setAttribute("aria-label", a.alt || a.name);
    } else {
      node = el("img");
      node.src = a.url;
      node.alt = a.alt ?? "";
      node.loading = "lazy";
    }
    wrap.append(node);
  }
  return wrap;
}

function openPlayer(src, title) {
  const frame = els.player.querySelector("iframe");
  frame.title = title;
  frame.src = src;
  els.player.showModal();
}

// An X post, and its thread below it the way X shows one: each reply under the first tweet, joined
// by a line from the avatar. Replies have their own Copy, since each one is posted separately.
function previewX(post) {
  const pv = el("div", "preview pv-x");
  const thread = post.thread ?? [];
  const first = el("div", "pv-tweet");
  first.append(author("x"), textWithTags(post, el("p", "pv-text")));
  const m = media(post);
  if (m) first.append(m);
  pv.append(first);
  if (!thread.length) return pv;
  pv.classList.add("pv-has-thread");
  thread.forEach((text, i) => {
    const tweet = el("div", "pv-tweet pv-reply");
    const body = el("p", "pv-text", text);
    const copy = el("button", "pv-copy", "Copy");
    copy.type = "button";
    copy.setAttribute("aria-label", `Copy tweet ${i + 2}`);
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Copy failed";
      }
      setTimeout(() => { copy.textContent = "Copy"; }, 1600);
    });
    tweet.append(author("x"), body, copy);
    pv.append(tweet);
  });
  return pv;
}

function previewLinkedIn(post) {
  const pv = el("div", "preview pv-li");
  pv.append(author("linkedin"));
  const text = textWithTags(post, el("p", "pv-text"));
  const fold = PLATFORMS.linkedin.fold;
  if (fullText(post).length > fold) {
    // LinkedIn cuts the feed preview at about this length; what sits above the fold has to hook.
    const short = el("p", "pv-text");
    short.append(fullText(post).slice(0, fold).trimEnd(), "… ");
    const more = el("button", "pv-more", "see more");
    more.type = "button";
    more.addEventListener("click", () => {
      short.replaceWith(text);
      note.remove();
    });
    short.append(more);
    const note = el("p", "pv-fold", `The feed shows the first ${fold} characters before "see more"`);
    pv.append(short, note);
  } else {
    pv.append(text);
  }
  const m = media(post);
  if (m) pv.append(m);
  return pv;
}

// Interaction

function select(k, { focus = false, post = null, open = state.open } = {}) {
  state.open = open;
  state.selected = k;
  state.focusPost = post;
  history.replaceState(null, "", open ? `#${k}` : location.pathname + location.search);
  render();
  if (focus) els.weeks.querySelector(`.cell[data-key="${k}"]`)?.focus();
}

function shift(n) {
  if (state.view === "week") {
    select(addDays(state.selected, n * 7));
    return;
  }
  const d = fromKey(state.selected);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0)).getUTCDate();
  select(key(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), lastDay)));
}

function setView(view) {
  state.view = view;
  for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-checked", String(b.dataset.view === view));
  render();
}

els.weeks.addEventListener("click", (e) => {
  const cell = e.target.closest(".cell");
  if (!cell) return;
  const line = e.target.closest(".line");
  select(cell.dataset.key, { post: line?.dataset.post ?? null, open: true });
});

els.day.addEventListener("click", (e) => {
  if (e.target === els.day) {   // the backdrop
    closeDay();
    return;
  }
  const step = e.target.closest("[data-step]");
  if (step) {
    select(addDays(state.selected, Number(step.dataset.step)));
    return;
  }
  if (e.target.closest("[data-close]")) {
    closeDay();
    return;
  }
  const add = e.target.closest("[data-compose]");
  if (add) compose(null, add.dataset.compose);
});

// Esc closes the pop-up on its own; keep the calendar in step with it.
els.day.addEventListener("close", () => {
  if (state.open) closeDay();
});

els.day.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select, [contenteditable]")) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    select(addDays(state.selected, e.key === "ArrowLeft" ? -1 : 1));
  }
});

els.player.addEventListener("click", (e) => {
  if (e.target === els.player) els.player.close();
});
els.player.addEventListener("close", () => {
  els.player.querySelector("iframe").src = "about:blank";
});

els.weeks.addEventListener("keydown", (e) => {
  if (!e.target.classList.contains("cell")) return;
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  if (e.key in moves) {
    e.preventDefault();
    select(addDays(state.selected, moves[e.key]), { focus: true });
  } else if (e.key === "PageUp" || e.key === "PageDown") {
    e.preventDefault();
    shift(e.key === "PageUp" ? -1 : 1);
    els.weeks.querySelector(`.cell[data-key="${state.selected}"]`)?.focus();
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    select(state.selected, { open: true });
  }
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]:not(#day)")) return;
  if (e.target.closest("input, textarea, select, [contenteditable]")) return;
  const k = e.key.toLowerCase();
  if (e.key === "Escape" && state.open) closeDay();
  else if (k === "t") select(todayKey, { focus: true });
  else if (k === "m") setView("month");
  else if (k === "w") setView("week");
  else if (k === "n" && isEditor()) { e.preventDefault(); compose(); }
  else if (e.key === "?") els.help.showModal();
});

$("prev").addEventListener("click", () => shift(-1));
$("next").addEventListener("click", () => shift(1));
$("today").addEventListener("click", () => select(todayKey));
initThemeToggle($("theme-toggle"));
$("help-open").addEventListener("click", () => els.help.showModal());

for (const btn of document.querySelectorAll("[data-view]")) {
  btn.addEventListener("click", () => setView(btn.dataset.view));
}

for (const btn of document.querySelectorAll("[data-platform]")) {
  btn.addEventListener("click", () => {
    state.platform = btn.dataset.platform;
    for (const b of document.querySelectorAll("[data-platform]")) b.setAttribute("aria-checked", String(b === btn));
    render();
  });
}

els.statuses.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-status]");
  if (!btn) return;
  const s = btn.dataset.status;
  if (state.statuses.has(s)) state.statuses.delete(s);
  else state.statuses.add(s);
  render();
});

window.addEventListener("hashchange", () => {
  const k = parseHash();
  if (k && (k !== state.selected || !state.open)) select(k, { open: true });
});

// Editing (editor only)

function preview(post) {
  return post.platform === "x" ? previewX(post) : previewLinkedIn(post);
}

function upsertPost(saved) {
  state.posts = state.posts.filter((p) => p.id !== saved.id).concat(saved);
  state.byDay = index(state.posts);
}

function compose(existing = null, day = state.selected, restore = null) {
  openComposer({
    existing,
    day,
    restore,
    preview,
    onSaved: (saved) => {
      upsertPost(saved);
      select(dayKeyFmt.format(new Date(saved.scheduledAt)), { post: saved.id, open: true });
    },
    onDeleted: (gone) => {
      state.posts = state.posts.filter((p) => p.id !== gone.id);
      state.byDay = index(state.posts);
      render();
    },
  });
}

els.newPost.addEventListener("click", () => compose());

function renderAccount() {
  els.newPost.hidden = !isEditor();
  $("today").classList.toggle("primary", !isEditor());
  els.account.replaceChildren();
  if (!state.user) {
    const b = el("button", "link", "Editor sign-in");
    b.type = "button";
    b.addEventListener("click", () => signInWithGoogle().catch((err) => { b.textContent = `Sign-in failed: ${err.message}`; }));
    els.account.append(b);
    return;
  }
  if (state.user.email === "sample mode") {
    els.account.append(el("span", null, "Sample mode: editing is on and nothing is saved."));
    return;
  }
  els.account.append(el("span", null, state.user.editor
    ? `Signed in as ${state.user.email}`
    : `${state.user.email} can view and comment, but only the editor can post.`));
  const out = el("button", "link", "Sign out");
  out.type = "button";
  out.addEventListener("click", () => signOut());
  els.account.append(out);
}

async function refreshUser() {
  try {
    state.user = await currentUser();
  } catch (err) {
    console.error(err);
    state.user = null;
  }
  renderAccount();
  render();
}

// Boot

function index(posts) {
  const byDay = new Map();
  for (const post of posts) {
    const k = dayKeyFmt.format(new Date(post.scheduledAt));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(post);
  }
  for (const list of byDay.values()) list.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  return byDay;
}

render();
const userReady = refreshUser();
onAuthChange(refreshUser);

const postsReady = loadPosts()
  .then((posts) => {
    state.posts = posts;
    state.byDay = index(posts);
    render();
  })
  .catch((err) => {
    console.error(err);
    els.sub.textContent = "Couldn't load posts. Refresh to try again.";
  });

// Back from signing in again for Drive: reopen the post that was being written.
Promise.all([userReady, postsReady]).then(() => {
  const stash = takeStashedDraft();
  if (!stash || !isEditor()) return;
  compose(state.posts.find((p) => p.id === stash.draft.id) ?? null, state.selected, stash);
});
