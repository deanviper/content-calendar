import { loadPosts, manilaDate, TIME_ZONE } from "./data.js";

const PLATFORMS = {
  x: { name: "X", limit: 280 },
  linkedin: { name: "LinkedIn", limit: 3000 },
};
const STATUS_LABEL = { scheduled: "Scheduled", suggested: "Suggested" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_MARKERS = 3;

const els = {
  title: document.getElementById("month-title"),
  summary: document.getElementById("month-summary"),
  weekdays: document.querySelector(".weekdays"),
  days: document.getElementById("days"),
  day: document.getElementById("day"),
  template: document.getElementById("post-template"),
  filter: document.querySelectorAll(".filter button"),
};

const today = manilaDate(new Date());
const todayKey = key(today.y, today.m, today.d);

const state = {
  posts: [],
  byDay: new Map(),
  platform: "all",
  selected: parseHash() ?? todayKey,
};
state.view = monthOf(state.selected);

const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" });
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const monthFmt = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const longDayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

// Helpers

function key(y, m, d) {
  const date = new Date(Date.UTC(y, m, d));
  return date.toISOString().slice(0, 10);
}

function fromKey(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function monthOf(k) {
  const d = fromKey(k);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
}

function addDays(k, n) {
  const d = fromKey(k);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function parseHash() {
  const h = location.hash.slice(1);
  return /^\d{4}-\d{2}-\d{2}$/.test(h) && !Number.isNaN(fromKey(h).getTime()) ? h : null;
}

function visible(posts) {
  return state.platform === "all" ? posts : posts.filter((p) => p.platform === state.platform);
}

function postsOn(k) {
  return visible(state.byDay.get(k) ?? []);
}

function fullText(post) {
  const tags = post.hashtags.map((t) => `#${t}`).join(" ");
  return tags ? `${post.copy}\n\n${tags}` : post.copy;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function breakdown(posts) {
  const scheduled = posts.filter((p) => p.status === "scheduled").length;
  const suggested = posts.length - scheduled;
  const parts = [];
  if (scheduled) parts.push(`${scheduled} scheduled`);
  if (suggested) parts.push(`${suggested} suggested`);
  return parts.join(", ");
}

// Rendering

function renderWeekdays() {
  els.weekdays.replaceChildren(...WEEKDAYS.map((w) => {
    const s = document.createElement("span");
    s.setAttribute("role", "columnheader");
    s.textContent = w;
    return s;
  }));
}

function renderMonth() {
  const { y, m } = state.view;
  const first = new Date(Date.UTC(y, m, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const weeks = Math.ceil((lead + daysInMonth) / 7);
  const start = key(y, m, 1 - lead);

  els.title.textContent = monthFmt.format(first);

  const monthPosts = [];
  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const k = addDays(start, i);
    const d = fromKey(k);
    const inMonth = d.getUTCMonth() === m;
    const posts = postsOn(k);
    if (inMonth) monthPosts.push(...posts);
    cells.push(renderCell(k, d, inMonth, posts));
  }

  const rows = [];
  for (let w = 0; w < weeks; w++) {
    const row = document.createElement("div");
    row.setAttribute("role", "row");
    row.style.display = "contents";
    row.append(...cells.slice(w * 7, w * 7 + 7));
    rows.push(row);
  }
  els.days.replaceChildren(...rows);

  els.summary.textContent = monthPosts.length
    ? `${plural(monthPosts.length, "post")} · ${breakdown(monthPosts)}`
    : "Nothing planned this month yet";
}

function renderCell(k, d, inMonth, posts) {
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = "cell";
  cell.dataset.key = k;
  cell.setAttribute("role", "gridcell");
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) cell.classList.add("weekend");
  if (!inMonth) cell.classList.add("outside");
  if (k === todayKey) cell.classList.add("today");
  const selected = k === state.selected;
  cell.setAttribute("aria-selected", String(selected));
  cell.tabIndex = selected ? 0 : -1;
  cell.setAttribute("aria-label", `${longDayFmt.format(d)}${k === todayKey ? ", today" : ""}, ${posts.length ? plural(posts.length, "post") : "no posts"}`);

  const date = document.createElement("span");
  date.className = "date";
  date.textContent = d.getUTCDate();
  date.setAttribute("aria-hidden", "true");
  cell.append(date);

  if (posts.length) {
    const list = document.createElement("span");
    list.className = "markers";
    list.setAttribute("aria-hidden", "true");
    for (const post of posts.slice(0, MAX_MARKERS)) {
      const marker = document.createElement("span");
      marker.className = "marker";
      const dot = document.createElement("span");
      dot.className = `dot dot-${post.platform}${post.status === "suggested" ? " suggested" : ""}`;
      const label = document.createElement("span");
      label.className = "marker-label";
      label.textContent = `${timeFmt.format(new Date(post.scheduledAt))} ${PLATFORMS[post.platform].name}`;
      marker.append(dot, label);
      list.append(marker);
    }
    if (posts.length > MAX_MARKERS) {
      const more = document.createElement("span");
      more.className = "more";
      more.textContent = `${posts.length - MAX_MARKERS} more`;
      list.append(more);
    }
    cell.append(list);
  }
  return cell;
}

function renderDay() {
  const k = state.selected;
  const posts = postsOn(k);
  const heading = document.createElement("h2");
  heading.textContent = longDayFmt.format(fromKey(k));

  const sub = document.createElement("p");
  sub.className = "day-sub";
  sub.textContent = k === todayKey ? "Today" : "";
  if (posts.length) sub.textContent += `${sub.textContent ? " · " : ""}${plural(posts.length, "post")}, ${breakdown(posts)}`;

  const children = [heading, sub];
  if (!posts.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    const scope = state.platform === "all" ? "" : ` on ${PLATFORMS[state.platform].name}`;
    empty.textContent = `Nothing scheduled or suggested${scope} for this day.`;
    children.push(empty);
  } else {
    children.push(...posts.map(renderPost));
  }
  els.day.replaceChildren(...children);
}

function renderPost(post) {
  const node = els.template.content.firstElementChild.cloneNode(true);
  const platform = PLATFORMS[post.platform];
  if (post.status === "suggested") node.classList.add("is-suggested");

  const name = node.querySelector(".platform");
  const dot = document.createElement("span");
  dot.className = `dot dot-${post.platform}${post.status === "suggested" ? " suggested" : ""}`;
  name.append(dot, platform.name);

  const time = node.querySelector(".post-time");
  time.dateTime = post.scheduledAt;
  time.textContent = `${timeFmt.format(new Date(post.scheduledAt))} Manila`;

  const status = node.querySelector(".status");
  status.textContent = STATUS_LABEL[post.status] ?? post.status;
  status.classList.add(post.status);

  node.querySelector(".copy").textContent = post.copy;
  node.querySelector(".tags").textContent = post.hashtags.map((t) => `#${t}`).join(" ");

  const assets = node.querySelector(".assets");
  for (const a of post.assets) {
    const link = document.createElement("a");
    link.className = "asset";
    link.href = a.url;
    link.target = "_blank";
    link.rel = "noopener";
    const fig = document.createElement("figure");
    fig.style.margin = "0";
    if (a.type === "image") {
      const img = document.createElement("img");
      img.src = a.url;
      img.alt = a.alt ?? "";
      img.loading = "lazy";
      fig.append(img);
    }
    const cap = document.createElement("figcaption");
    cap.textContent = a.name;
    fig.append(cap);
    link.append(fig);
    assets.append(link);
  }

  const length = fullText(post).length;
  const count = node.querySelector(".count");
  count.textContent = `${length} / ${platform.limit} characters`;
  if (length > platform.limit) {
    count.classList.add("over");
    count.textContent = `${length - platform.limit} over the ${platform.limit} limit`;
  }

  const btn = node.querySelector(".copy-btn");
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(fullText(post));
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => { btn.textContent = "Copy text"; }, 1600);
  });
  return node;
}

function render() {
  renderMonth();
  renderDay();
}

// Interaction

function select(k, { focus = false } = {}) {
  state.selected = k;
  const month = monthOf(k);
  if (month.y !== state.view.y || month.m !== state.view.m) state.view = month;
  history.replaceState(null, "", `#${k}`);
  render();
  if (focus) els.days.querySelector(`[data-key="${k}"]`)?.focus();
}

function shiftMonth(n) {
  const { y, m } = state.view;
  const first = new Date(Date.UTC(y, m + n, 1));
  const lastDay = new Date(Date.UTC(y, m + n + 1, 0)).getUTCDate();
  const day = Math.min(fromKey(state.selected).getUTCDate(), lastDay);
  select(key(first.getUTCFullYear(), first.getUTCMonth(), day));
}

els.days.addEventListener("click", (e) => {
  const cell = e.target.closest(".cell");
  if (cell) select(cell.dataset.key);
});

els.days.addEventListener("keydown", (e) => {
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  if (e.key in moves) {
    e.preventDefault();
    select(addDays(state.selected, moves[e.key]), { focus: true });
  } else if (e.key === "PageUp" || e.key === "PageDown") {
    e.preventDefault();
    shiftMonth(e.key === "PageUp" ? -1 : 1);
    els.days.querySelector(`[data-key="${state.selected}"]`)?.focus();
  }
});

document.getElementById("prev").addEventListener("click", () => shiftMonth(-1));
document.getElementById("next").addEventListener("click", () => shiftMonth(1));
document.getElementById("today").addEventListener("click", () => select(todayKey));

for (const btn of els.filter) {
  btn.addEventListener("click", () => {
    state.platform = btn.dataset.platform;
    for (const b of els.filter) b.setAttribute("aria-checked", String(b === btn));
    render();
  });
}

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

renderWeekdays();
render();

loadPosts()
  .then((posts) => {
    state.posts = posts;
    state.byDay = index(posts);
    render();
  })
  .catch((err) => {
    console.error(err);
    els.summary.textContent = "Couldn't load posts. Refresh to try again.";
  });
