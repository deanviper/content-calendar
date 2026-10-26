import { loadPosts, addComment, COMMENT_LIMITS, manilaDate, TIME_ZONE, TIME_ZONE_LABEL, ACCOUNTS } from "./data.js";

const PLATFORMS = {
  x: { name: "X", limit: 280 },
  linkedin: { name: "LinkedIn", limit: 3000, fold: 210 },
};
// Order is the order of the status filters and of the workflow.
const STATUSES = {
  draft: "Draft",
  suggested: "Suggested",
  scheduled: "Scheduled",
  published: "Published",
};
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_CHIPS = 3;
const narrow = window.matchMedia("(max-width: 1080px)");

const $ = (id) => document.getElementById(id);
const els = {
  title: $("period-title"),
  sub: $("period-sub"),
  statuses: $("statuses"),
  grid: $("grid"),
  weekdays: $("weekdays"),
  days: $("days"),
  gaps: $("gaps"),
  day: $("day"),
  help: $("help"),
};

const today = manilaDate(new Date());
const todayKey = key(today.y, today.m, today.d);

const state = {
  posts: [],
  byDay: new Map(),
  view: "month",
  platform: "all",
  statuses: new Set(Object.keys(STATUSES)),
  selected: parseHash() ?? todayKey,
  focusPost: null,
};

const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" });
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const monthFmt = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const longDayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const shortDayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" });
const rangeFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

// Dates are handled as "YYYY-MM-DD" keys in Manila time.

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
  svg.setAttribute("class", `pf pf-${platform}`);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${platform}`);
  svg.append(use);
  return svg;
}

// The period on screen: a month of weeks, or one week.

function period() {
  if (state.view === "week") {
    const start = weekStart(state.selected);
    return { start, days: 7, inPeriod: () => true };
  }
  const d = fromKey(state.selected);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const first = key(y, m, 1);
  const start = weekStart(first);
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const lead = (fromKey(first).getUTCDay() + 6) % 7;
  return {
    start,
    days: Math.ceil((lead + daysInMonth) / 7) * 7,
    inPeriod: (k) => fromKey(k).getUTCMonth() === m,
  };
}

function periodKeys() {
  const p = period();
  return Array.from({ length: p.days }, (_, i) => addDays(p.start, i)).map((k) => ({ k, inPeriod: p.inPeriod(k) }));
}

// Rendering

function render() {
  const keys = periodKeys();
  const inPeriod = keys.filter((d) => d.inPeriod);
  const platformPosts = inPeriod.flatMap(({ k }) =>
    (state.byDay.get(k) ?? []).filter((p) => state.platform === "all" || p.platform === state.platform));
  const shown = platformPosts.filter((p) => state.statuses.has(p.status));

  renderTitle(inPeriod);
  renderSub(shown);
  renderStatuses(platformPosts);
  renderGrid(keys);
  renderGaps(inPeriod);
  renderDay();
}

function renderTitle(inPeriod) {
  if (state.view === "week") {
    const first = fromKey(inPeriod[0].k);
    const last = fromKey(inPeriod[6].k);
    els.title.textContent = `${rangeFmt.format(first)} – ${rangeFmt.format(last)} ${last.getUTCFullYear()}`;
  } else {
    els.title.textContent = monthFmt.format(fromKey(state.selected));
  }
}

function renderSub(shown) {
  const per = (pf) => shown.filter((p) => p.platform === pf).length;
  const parts = [shown.length ? plural(shown.length, "post") : `Nothing planned this ${state.view} yet`];
  if (shown.length && state.platform === "all") parts.push(`X ${per("x")}`, `LinkedIn ${per("linkedin")}`);
  parts.push(`Times in ${TIME_ZONE_LABEL}`);
  els.sub.textContent = parts.join(" · ");
}

function renderStatuses(platformPosts) {
  els.statuses.replaceChildren(...Object.entries(STATUSES).map(([status, label]) => {
    const count = platformPosts.filter((p) => p.status === status).length;
    const btn = el("button", `status-toggle s-${status}`);
    btn.type = "button";
    btn.dataset.status = status;
    btn.setAttribute("aria-pressed", String(state.statuses.has(status)));
    btn.append(el("span", "swatch"), el("span", null, label), el("span", "n", String(count)));
    return btn;
  }));
}

function renderGrid(keys) {
  els.grid.dataset.view = state.view;
  els.weekdays.replaceChildren(...keys.slice(0, 7).map(({ k }) => {
    const head = el("span", null, state.view === "week" ? shortDayFmt.format(fromKey(k)) : WEEKDAYS[(fromKey(k).getUTCDay() + 6) % 7]);
    head.setAttribute("role", "columnheader");
    if (state.view === "week" && k === todayKey) head.classList.add("is-today");
    return head;
  }));

  const rows = [];
  for (let w = 0; w < keys.length / 7; w++) {
    const row = el("div", "week-row");
    row.setAttribute("role", "row");
    row.append(...keys.slice(w * 7, w * 7 + 7).map(({ k, inPeriod }) => renderCell(k, inPeriod)));
    rows.push(row);
  }
  els.days.replaceChildren(...rows);
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
  if (k < todayKey) cell.classList.add("past");
  if (k === todayKey) cell.classList.add("today");
  const selected = k === state.selected;
  cell.setAttribute("aria-selected", String(selected));
  cell.tabIndex = selected ? 0 : -1;
  cell.setAttribute("aria-label",
    `${longDayFmt.format(d)}${k === todayKey ? ", today" : ""}, ${posts.length ? plural(posts.length, "post") : "nothing planned"}`);

  const date = el("span", "date", String(d.getUTCDate()));
  date.setAttribute("aria-hidden", "true");
  cell.append(date);

  const max = state.view === "week" ? Infinity : MAX_CHIPS;
  if (posts.length) {
    const list = el("span", "chips");
    list.setAttribute("aria-hidden", "true");
    for (const post of posts.slice(0, max)) list.append(renderChip(post));
    if (posts.length > max) list.append(el("span", "more", `${posts.length - max} more`));
    cell.append(list);
  }
  return cell;
}

function renderChip(post) {
  const chip = el("span", `chip s-${post.status}`);
  chip.dataset.post = post.id;
  chip.append(icon(post.platform), el("span", "chip-time", timeFmt.format(new Date(post.scheduledAt))));
  chip.append(el("span", "chip-text", post.copy.split("\n")[0]));
  if (state.view === "week") {
    chip.append(el("span", "chip-status", STATUSES[post.status]));
    const img = post.assets.find((a) => a.type === "image");
    if (img) {
      const thumb = el("img", "chip-thumb");
      thumb.src = img.url;
      thumb.alt = "";
      thumb.loading = "lazy";
      chip.append(thumb);
    }
  }
  return chip;
}

// Upcoming weekdays in the period with nothing planned: the gaps a planner fills next.
function renderGaps(inPeriod) {
  const gaps = inPeriod
    .map(({ k }) => k)
    .filter((k) => k >= todayKey && ![0, 6].includes(fromKey(k).getUTCDay()) && !postsOn(k).length);
  if (!gaps.length) {
    els.gaps.textContent = "";
    return;
  }
  const list = gaps.slice(0, 6).map((k) => shortDayFmt.format(fromKey(k))).join(", ");
  els.gaps.textContent = `${plural(gaps.length, "upcoming weekday")} with nothing planned: ${list}${gaps.length > 6 ? "…" : ""}`;
}

function renderDay() {
  const k = state.selected;
  const posts = postsOn(k);
  const all = state.byDay.get(k) ?? [];

  const head = el("div", "day-head");
  head.append(el("h2", null, longDayFmt.format(fromKey(k))));
  const sub = [];
  if (k === todayKey) sub.push("Today");
  sub.push(posts.length ? plural(posts.length, "post") : "Nothing planned");
  head.append(el("p", "day-sub", sub.join(" · ")));

  const children = [head];
  if (!posts.length) {
    const hidden = all.length - posts.length;
    children.push(el("p", "empty", hidden
      ? `${plural(hidden, "post")} on this day ${hidden === 1 ? "is" : "are"} hidden by the filters.`
      : "No posts scheduled or suggested for this day."));
  } else {
    children.push(...posts.map(renderPost));
  }
  els.day.replaceChildren(...children);

  if (state.focusPost) {
    els.day.querySelector(`[data-post="${state.focusPost}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    state.focusPost = null;
  }
}

function renderPost(post) {
  const platform = PLATFORMS[post.platform];
  const card = el("article", `post s-${post.status}`);
  card.dataset.post = post.id;

  const head = el("header", "post-head");
  const name = el("span", "platform");
  name.append(icon(post.platform), platform.name);
  const time = el("time", "post-time", `${timeFmt.format(new Date(post.scheduledAt))}`);
  time.dateTime = post.scheduledAt;
  head.append(name, time, el("span", `status s-${post.status}`, STATUSES[post.status] ?? post.status));
  card.append(head, post.platform === "x" ? previewX(post) : previewLinkedIn(post));

  const length = fullText(post).length;
  const foot = el("footer", "post-foot");
  const count = el("span", "count");
  if (length > platform.limit) {
    count.classList.add("over");
    count.textContent = `${length - platform.limit} characters over the ${platform.limit} limit`;
  } else {
    count.textContent = `${length} / ${platform.limit}`;
  }
  const actions = el("span", "post-actions");
  for (const a of post.assets) {
    const dl = el("a", "pill-btn", "Download asset");
    dl.href = a.url;
    dl.download = a.name;
    dl.setAttribute("aria-label", `Download ${a.name}`);
    actions.append(dl);
  }
  const copy = el("button", "pill-btn primary", "Copy text");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(fullText(post));
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy failed";
    }
    setTimeout(() => { copy.textContent = "Copy text"; }, 1600);
  });
  actions.append(copy);
  foot.append(count, actions);
  card.append(foot, renderComments(post));
  return card;
}

// Comments: anyone can leave one, signed in or not. The name is remembered on this device.

const commentTimeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function rememberedName() {
  try { return localStorage.getItem("commentName") ?? ""; } catch { return ""; }
}

function rememberName(name) {
  try { localStorage.setItem("commentName", name); } catch { /* private mode: just don't remember */ }
}

function commentItem(c) {
  const li = el("li", "comment");
  const meta = el("div", "comment-meta");
  const when = el("time", null, commentTimeFmt.format(new Date(c.createdAt)));
  when.dateTime = c.createdAt;
  meta.append(el("span", "comment-name", c.authorName), when);
  li.append(meta, el("p", "comment-body", c.body));
  return li;
}

function renderComments(post) {
  const section = el("details", "comments");
  if (post.comments.length) section.open = true;
  const summary = el("summary", null, post.comments.length ? plural(post.comments.length, "comment") : "Add a comment");
  const list = el("ol", "comment-list");
  list.append(...post.comments.map(commentItem));

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
  body.rows = 2;
  body.placeholder = "What should change?";
  body.maxLength = COMMENT_LIMITS.body;
  body.required = true;
  body.setAttribute("aria-label", "Comment");
  const send = el("button", "pill-btn primary", "Comment");
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
      list.append(commentItem(c));
      summary.textContent = plural(post.comments.length, "comment");
      body.value = "";
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      send.disabled = false;
    }
  });

  section.append(summary, list, form);
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
  who.append(el("span", "pv-name", acc.name), el("span", "pv-handle", acc.handle));
  row.append(avatar, who);
  return row;
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

function media(post) {
  const images = post.assets.filter((a) => a.type === "image");
  if (!images.length) return null;
  const wrap = el("div", `pv-media n${Math.min(images.length, 4)}`);
  for (const a of images.slice(0, 4)) {
    const img = el("img");
    img.src = a.url;
    img.alt = a.alt ?? "";
    img.loading = "lazy";
    wrap.append(img);
  }
  return wrap;
}

function previewX(post) {
  const pv = el("div", "preview pv-x");
  pv.append(author("x"), textWithTags(post, el("p", "pv-text")));
  const m = media(post);
  if (m) pv.append(m);
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
    const note = el("p", "pv-fold", `Readers see the first ${fold} characters before "see more"`);
    pv.append(short, note);
  } else {
    pv.append(text);
  }
  const m = media(post);
  if (m) pv.append(m);
  return pv;
}

// Interaction

function select(k, { focus = false, post = null, reveal = false } = {}) {
  state.selected = k;
  state.focusPost = post;
  history.replaceState(null, "", `#${k}`);
  render();
  if (focus) els.days.querySelector(`[data-key="${k}"]`)?.focus();
  if (reveal && narrow.matches) els.day.scrollIntoView({ behavior: "smooth", block: "start" });
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

els.days.addEventListener("click", (e) => {
  const cell = e.target.closest(".cell");
  if (!cell) return;
  const chip = e.target.closest(".chip");
  select(cell.dataset.key, { post: chip?.dataset.post ?? null, reveal: true });
});

els.days.addEventListener("keydown", (e) => {
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  if (e.key in moves) {
    e.preventDefault();
    select(addDays(state.selected, moves[e.key]), { focus: true });
  } else if (e.key === "PageUp" || e.key === "PageDown") {
    e.preventDefault();
    shift(e.key === "PageUp" ? -1 : 1);
    els.days.querySelector(`[data-key="${state.selected}"]`)?.focus();
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.day.focus();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || els.help.open) return;
  if (e.target.closest("input, textarea, [contenteditable]")) return;
  const k = e.key.toLowerCase();
  if (k === "t") select(todayKey, { focus: true });
  else if (k === "m") setView("month");
  else if (k === "w") setView("week");
  else if (e.key === "?") els.help.showModal();
});

$("prev").addEventListener("click", () => shift(-1));
$("next").addEventListener("click", () => shift(1));
$("today").addEventListener("click", () => select(todayKey));
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
  if (k && k !== state.selected) select(k);
});

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

loadPosts()
  .then((posts) => {
    state.posts = posts;
    state.byDay = index(posts);
    render();
  })
  .catch((err) => {
    console.error(err);
    els.sub.textContent = "Couldn't load posts. Refresh to try again.";
  });
