import { loadStats, addMarker } from "./stats-data.js";
import { manilaDate } from "./data.js";
import { initThemeToggle } from "./theme.js";

const PLATFORMS = {
  x: { name: "X", color: "var(--c-x)" },
  linkedin: { name: "LinkedIn", color: "var(--c-linkedin)" },
};
const DAY = 86_400_000;

const $ = (id) => document.getElementById(id);
initThemeToggle($("theme-toggle"));
const tooltip = $("tooltip");

const state = { data: null, range: 30, platform: "all", marker: null };

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en");
const pct = new Intl.NumberFormat("en", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Manila" });

const t = manilaDate(new Date());
const todayKey = new Date(Date.UTC(t.y, t.m, t.d)).toISOString().slice(0, 10);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function addDays(k, n) {
  const d = new Date(`${k}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function manilaDay(iso) {
  const p = manilaDate(new Date(iso));
  return new Date(Date.UTC(p.y, p.m, p.d)).toISOString().slice(0, 10);
}

function platforms() {
  return state.platform === "all" ? ["x", "linkedin"] : [state.platform];
}

// Days in the selected range, and the same number of days just before it.
function window_() {
  const first = state.data.daily[0]?.day ?? todayKey;
  const days = state.range === "all"
    ? Math.max(1, Math.round((new Date(todayKey) - new Date(first)) / DAY) + 1)
    : state.range;
  const start = addDays(todayKey, -(days - 1));
  return { start, end: todayKey, days, prevStart: addDays(start, -days), prevEnd: addDays(start, -1) };
}

// Daily running totals turned into what each day added. The first day of data is the starting point,
// not a gain, so it counts as zero.
function gains() {
  const out = new Map();
  for (const pf of ["x", "linkedin"]) {
    const rows = state.data.daily.filter((d) => d.platform === pf);
    let prev = null;
    for (const r of rows) {
      const g = prev ? { impressions: Math.max(0, r.impressions - prev.impressions), engagements: Math.max(0, r.engagements - prev.engagements) } : { impressions: 0, engagements: 0 };
      out.set(`${pf}:${r.day}`, g);
      prev = r;
    }
  }
  return out;
}

function sumGains(g, from, to) {
  let impressions = 0;
  let engagements = 0;
  for (let k = from; k <= to; k = addDays(k, 1)) {
    for (const pf of platforms()) {
      const v = g.get(`${pf}:${k}`);
      if (v) { impressions += v.impressions; engagements += v.engagements; }
    }
  }
  return { impressions, engagements, rate: impressions ? engagements / impressions : null };
}

function followersOn(day, pf) {
  let last = null;
  for (const f of state.data.followers) {
    if (f.platform !== pf) continue;
    if (f.day > day) break;
    last = f.followers;
  }
  return last;
}

function followerTotal(day) {
  let total = 0;
  for (const pf of platforms()) {
    const v = followersOn(day, pf);
    if (v == null) return null;
    total += v;
  }
  return total;
}

function postsBetween(from, to) {
  return state.data.posts.filter((p) => platforms().includes(p.platform) && manilaDay(p.publishedAt) >= from && manilaDay(p.publishedAt) <= to);
}

// Rendering

function render() {
  const w = window_();
  const g = gains();
  $("sub").textContent = `${dayFmt.format(new Date(w.start))} – ${dayFmt.format(new Date(w.end))} · compared with the ${w.days} days before · Manila time${state.data.live ? "" : " · sample data"}`;
  renderKpis(w, g);
  renderImpressions(w, g);
  renderFollowers(w);
  renderMarkerSelect();
  renderMarkerCompare(g);
  renderPosts(w);
  renderMarkers();
}

function delta(now, before, { points = false } = {}) {
  if (now == null || before == null) return { text: "no earlier data to compare", tone: "flat" };
  if (points) {
    const d = (now - before) * 100;
    if (Math.abs(d) < 0.05) return { text: "same as before", tone: "flat" };
    return { text: `${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)} pts`, tone: d > 0 ? "good" : "bad" };
  }
  if (before === 0) return now === 0 ? { text: "same as before", tone: "flat" } : { text: "▲ new", tone: "good" };
  const d = (now - before) / before;
  if (Math.abs(d) < 0.005) return { text: "same as before", tone: "flat" };
  return { text: `${d > 0 ? "▲" : "▼"} ${pct.format(Math.abs(d))}`, tone: d > 0 ? "good" : "bad" };
}

function renderKpis(w, g) {
  const now = sumGains(g, w.start, w.end);
  const before = w.prevStart >= (state.data.daily[0]?.day ?? w.prevStart) ? sumGains(g, w.prevStart, w.prevEnd) : null;
  const fNow = followerTotal(w.end);
  const fStart = followerTotal(addDays(w.start, -1));
  const fPrevStart = followerTotal(addDays(w.prevStart, -1));
  const gained = fNow != null && fStart != null ? fNow - fStart : null;
  const gainedBefore = fStart != null && fPrevStart != null ? fStart - fPrevStart : null;
  const postsNow = postsBetween(w.start, w.end).length;
  const postsBefore = before ? postsBetween(w.prevStart, w.prevEnd).length : null;

  const items = [
    { label: "Impressions", value: compact.format(now.impressions), d: delta(now.impressions, before?.impressions) },
    { label: "Engagements", value: compact.format(now.engagements), d: delta(now.engagements, before?.engagements) },
    { label: "Engagement rate", value: now.rate == null ? "–" : pct.format(now.rate), d: delta(now.rate, before?.rate, { points: true }) },
    { label: "Followers", value: fNow == null ? "–" : compact.format(fNow), d: gained == null ? { text: "–", tone: "flat" } : { text: `${gained >= 0 ? "+" : ""}${whole.format(gained)} in range${gainedBefore != null ? `, ${gainedBefore >= 0 ? "+" : ""}${whole.format(gainedBefore)} before` : ""}`, tone: gainedBefore == null || gained === gainedBefore ? "flat" : gained > gainedBefore ? "good" : "bad" } },
    { label: "Posts published", value: whole.format(postsNow), d: postsBefore == null ? { text: "no earlier data to compare", tone: "flat" } : { text: `${whole.format(postsBefore)} the ${w.days} days before`, tone: "flat" } },
  ];
  $("kpis").replaceChildren(...items.map((k) => {
    const cell = el("div", "kpi");
    cell.append(el("span", "kpi-label", k.label), el("span", "kpi-value", k.value), el("span", `kpi-delta ${k.d.tone}`, k.d.text));
    return cell;
  }));
}

function renderImpressions(w, g) {
  const days = [];
  for (let k = w.start; k <= w.end; k = addDays(k, 1)) days.push(k);
  const series = platforms().map((pf) => ({
    key: pf,
    label: PLATFORMS[pf].name,
    color: PLATFORMS[pf].color,
    values: days.map((k) => g.get(`${pf}:${k}`)?.impressions ?? null),
  }));
  lineChart($("imp-chart"), { days, series, markers: visibleMarkers(w), height: 260 });
  legend($("imp-legend"), series);

  const table = el("table", "daily-table");
  const head = el("tr");
  head.append(el("th", null, "Day"), ...series.map((s) => el("th", "num", s.label)));
  table.append(head);
  for (let i = days.length - 1; i >= 0; i--) {
    const tr = el("tr");
    tr.append(el("td", null, dayFmt.format(new Date(days[i]))), ...series.map((s) => el("td", "num", s.values[i] == null ? "–" : whole.format(s.values[i]))));
    table.append(tr);
  }
  $("imp-table").replaceChildren(table);
}

function renderFollowers(w) {
  const days = [];
  for (let k = w.start; k <= w.end; k = addDays(k, 1)) days.push(k);
  // Each platform gets its own chart: their follower counts differ too much to share one scale.
  $("fol-charts").replaceChildren(...platforms().map((pf) => {
    const box = el("div", "multiple");
    const values = days.map((k) => followersOn(k, pf));
    const last = values.filter((v) => v != null).at(-1);
    const first = values.find((v) => v != null);
    const head = el("div", "multiple-head");
    head.append(el("span", "multiple-name", PLATFORMS[pf].name), el("span", "multiple-value", last == null ? "–" : whole.format(last)));
    if (first != null && last != null) head.append(el("span", "kpi-delta flat", `${last - first >= 0 ? "+" : ""}${whole.format(last - first)}`));
    const chart = el("div", "chart small");
    box.append(head, chart);
    queueMicrotask(() => lineChart(chart, {
      days,
      series: [{ key: pf, label: PLATFORMS[pf].name, color: PLATFORMS[pf].color, values }],
      markers: visibleMarkers(w),
      height: 140,
      zeroBased: false,
    }));
    return box;
  }));
}

function visibleMarkers(w) {
  return state.data.markers.filter((m) => {
    const d = manilaDay(m.markedAt);
    return d >= w.start && d <= w.end && (!m.platform || platforms().includes(m.platform));
  });
}

function legend(node, series) {
  if (series.length < 2) {
    node.replaceChildren();
    return;
  }
  node.replaceChildren(...series.map((s) => {
    const li = el("li");
    const key = el("span", "key-line");
    key.style.background = s.color;
    li.append(key, s.label);
    return li;
  }));
}

// Markers: what changed after one.

function renderMarkerSelect() {
  const select = $("marker-select");
  const markers = [...state.data.markers].sort((a, b) => b.markedAt.localeCompare(a.markedAt));
  if (!state.marker || !markers.some((m) => m.id === state.marker)) state.marker = markers[0]?.id ?? null;
  select.replaceChildren(...markers.map((m) => {
    const o = el("option", null, `${m.label} · ${dayFmt.format(new Date(m.markedAt))}`);
    o.value = m.id;
    o.selected = m.id === state.marker;
    return o;
  }));
  select.hidden = !markers.length;
}

function renderMarkerCompare(g) {
  const box = $("marker-compare");
  const m = state.data.markers.find((x) => x.id === state.marker);
  if (!m) {
    box.replaceChildren(el("p", "empty", "Add a marker below to compare what came before it with what came after."));
    return;
  }
  const day = manilaDay(m.markedAt);
  const after = Math.round((new Date(todayKey) - new Date(day)) / DAY);
  if (after < 1) {
    box.replaceChildren(el("p", "empty", `${m.label} is today. Check back tomorrow for the first comparison.`));
    return;
  }
  // Equal windows on each side, up to 30 days, so the two sides are fair to compare.
  const n = Math.min(after, 30);
  const beforeFrom = addDays(day, -n);
  const beforeTo = addDays(day, -1);
  const afterFrom = day;
  const afterTo = addDays(day, n - 1);
  const firstDay = state.data.daily[0]?.day;
  if (!firstDay || beforeTo < firstDay) {
    box.replaceChildren(el("p", "empty", `${m.label} is where tracking starts, so there is nothing before it yet. It's the baseline the other markers are measured against.`));
    return;
  }

  const side = (from, to) => {
    const sums = sumGains(g, from, to);
    const posts = postsBetween(from, to);
    const f0 = followerTotal(addDays(from, -1));
    const f1 = followerTotal(to);
    return {
      perDay: sums.impressions / n,
      rate: sums.rate,
      perPost: posts.length ? posts.reduce((s, p) => s + p.impressions, 0) / posts.length : null,
      followers: f0 != null && f1 != null ? (f1 - f0) / n : null,
      posts: posts.length,
    };
  };
  const b = side(beforeFrom, beforeTo);
  const a = side(afterFrom, afterTo);
  const rows = [
    ["Impressions per day", (v) => compact.format(v), b.perDay, a.perDay],
    ["Engagement rate", (v) => pct.format(v), b.rate, a.rate, true],
    ["Impressions per post", (v) => compact.format(v), b.perPost, a.perPost],
    ["Followers gained per day", (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`, b.followers, a.followers],
    ["Posts", (v) => whole.format(v), b.posts, a.posts],
  ];

  const table = el("table", "compare");
  const head = el("tr");
  head.append(el("th"), el("th", "num", `${n} days before`), el("th", "num", `${n} days after`), el("th", "num", "Change"));
  table.append(head);
  for (const [label, fmt, before, afterV, points] of rows) {
    const tr = el("tr");
    const d = label === "Posts" ? { text: "", tone: "flat" } : delta(afterV, before, { points });
    tr.append(
      el("th", null, label),
      el("td", "num", before == null ? "–" : fmt(before)),
      el("td", "num", afterV == null ? "–" : fmt(afterV)),
      el("td", `num kpi-delta ${d.tone}`, d.text),
    );
    table.append(tr);
  }
  const note = el("p", "panel-note", `${m.label}, ${dateTimeFmt.format(new Date(m.markedAt))}${m.note ? `: ${m.note}` : ""}`);
  box.replaceChildren(note, table);
}

// Posts table

const SORTS = {
  publishedAt: (p) => p.publishedAt,
  impressions: (p) => p.impressions,
  engagements: (p) => p.engagements,
  rate: (p) => p.rate ?? -1,
  growth: (p) => p.impressions - (p.baselineImpressions ?? p.impressions),
};
let sort = { key: "impressions", dir: -1 };
let showAll = false;
const TOP = 10;

function renderPosts(w) {
  const posts = postsBetween(w.start, w.end).sort((a, b) => {
    const va = SORTS[sort.key](a);
    const vb = SORTS[sort.key](b);
    return (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir;
  });
  $("posts-note").textContent = posts.length ? `${posts.length} posts · numbers as of the latest capture` : "";
  const shown = showAll ? posts : posts.slice(0, TOP);

  const table = $("posts-table");
  const head = el("tr");
  const cols = [
    ["Post", null], ["Published", "publishedAt"], ["Impressions", "impressions"], ["Engagements", "engagements"],
    ["Rate", "rate"], ["Since first capture", "growth"],
  ];
  for (const [label, key] of cols) {
    const th = el("th", key && key !== "publishedAt" ? "num" : null);
    th.scope = "col";
    if (key) {
      const btn = el("button", "sort", label);
      btn.type = "button";
      btn.dataset.sort = key;
      if (sort.key === key) {
        th.setAttribute("aria-sort", sort.dir < 0 ? "descending" : "ascending");
        btn.append(sort.dir < 0 ? " ↓" : " ↑");
      }
      th.append(btn);
    } else {
      th.textContent = label;
    }
    head.append(th);
  }
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  if (!posts.length) {
    const tr = el("tr");
    const td = el("td", "empty-row", "No posts were published in this range.");
    td.colSpan = cols.length;
    tr.append(td);
    tbody.append(tr);
  }
  for (const p of shown) {
    const tr = el("tr");
    const post = el("td", "post-cell");
    const name = el("span", `pf-tag ${p.platform}`, PLATFORMS[p.platform].name);
    const copy = p.url ? el("a", "post-copy", p.copy) : el("span", "post-copy", p.copy);
    if (p.url) { copy.href = p.url; copy.target = "_blank"; copy.rel = "noopener"; }
    post.append(name, copy);
    const growth = p.baselineImpressions == null ? null : p.impressions - p.baselineImpressions;
    tr.append(
      post,
      el("td", null, dayFmt.format(new Date(p.publishedAt))),
      el("td", "num", whole.format(p.impressions)),
      el("td", "num", whole.format(p.engagements)),
      el("td", "num", p.rate == null ? "–" : pct.format(p.rate)),
      el("td", "num", growth == null ? "–" : `+${whole.format(growth)}`),
    );
    tbody.append(tr);
  }
  table.replaceChildren(thead, tbody);

  const more = $("posts-more");
  more.hidden = posts.length <= TOP;
  more.textContent = showAll ? `Show the top ${TOP}` : `Show all ${posts.length} posts`;
}

$("posts-more").addEventListener("click", () => {
  showAll = !showAll;
  renderPosts(window_());
});

$("posts-table").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-sort]");
  if (!btn) return;
  sort = sort.key === btn.dataset.sort ? { key: sort.key, dir: -sort.dir } : { key: btn.dataset.sort, dir: -1 };
  renderPosts(window_());
});

// Marker list and form

function renderMarkers() {
  const list = $("markers");
  const markers = [...state.data.markers].sort((a, b) => b.markedAt.localeCompare(a.markedAt));
  list.replaceChildren(...markers.map((m) => {
    const li = el("li");
    li.append(el("span", "marker-label", m.label), el("span", "marker-when", dateTimeFmt.format(new Date(m.markedAt))));
    li.append(el("span", "marker-scope", m.platform ? PLATFORMS[m.platform].name : "Both platforms"));
    if (m.note) li.append(el("span", "marker-note", m.note));
    return li;
  }));
  if (!markers.length) list.replaceChildren(el("li", "empty", "No markers yet."));
}

function defaultWhen() {
  const now = new Date(Date.now() + 8 * 3_600_000);
  return now.toISOString().slice(0, 16);
}

$("marker-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const msg = $("marker-msg");
  const fd = new FormData(form);
  msg.textContent = "Saving…";
  try {
    const marker = await addMarker({
      label: fd.get("label").trim(),
      markedAt: new Date(`${fd.get("markedAt")}:00+08:00`).toISOString(),
      platform: fd.get("platform"),
      note: fd.get("note").trim(),
    });
    state.data.markers.push(marker);
    state.marker = marker.id;
    form.reset();
    form.markedAt.value = defaultWhen();
    msg.textContent = state.data.live ? "Marker added." : "Marker added for this visit. Sample data isn't saved.";
    render();
  } catch (err) {
    msg.textContent = `Couldn't save the marker: ${err.message}`;
  }
});

$("marker-select").addEventListener("change", (e) => {
  state.marker = e.target.value;
  renderMarkerCompare(gains());
});

// A small SVG line chart: one shared x axis of days, a recessive grid, markers as dashed rules,
// and a crosshair that reads out every series at the hovered day.

// A round tick step that gives three to five gridlines.
function niceStep(range) {
  if (range <= 0) return 1;
  const raw = range / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= raw);
}

function lineChart(node, { days, series, markers = [], height = 240, zeroBased = true }) {
  const width = Math.max(280, node.clientWidth || 600);
  const pad = { top: 12, right: 12, bottom: 26, left: 48 };
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  const lo = zeroBased || !all.length ? 0 : Math.min(...all);
  const hi = all.length ? Math.max(...all) : 1;
  const step = niceStep(Math.max(1, hi - lo));
  const min = Math.floor(lo / step) * step;
  const max = Math.max(min + step, Math.ceil(hi / step) * step);
  const x = (i) => pad.left + (days.length < 2 ? 0 : (i / (days.length - 1)) * (width - pad.left - pad.right));
  const y = (v) => pad.top + (1 - (v - min) / (max - min || 1)) * (height - pad.top - pad.bottom);

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${series.map((s) => s.label).join(" and ")}, ${dayFmt.format(new Date(days[0]))} to ${dayFmt.format(new Date(days.at(-1)))}`);
  const add = (tag, attrs, text) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    svg.append(n);
    return n;
  };

  const ticks = Math.round((max - min) / step);
  for (let i = 0; i <= ticks; i++) {
    const v = min + step * i;
    add("line", { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v), class: i === 0 && zeroBased ? "axis" : "grid" });
    add("text", { x: pad.left - 8, y: y(v) + 4, "text-anchor": "end", class: "tick" }, compact.format(v));
  }
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor((width - pad.left) / 90))));
  days.forEach((d, i) => {
    if (i % labelEvery === 0 || i === days.length - 1) {
      if (i === days.length - 1 && i % labelEvery !== 0 && i - Math.floor(i / labelEvery) * labelEvery < labelEvery / 2) return;
      add("text", { x: x(i), y: height - 6, "text-anchor": i === 0 ? "start" : i === days.length - 1 ? "end" : "middle", class: "tick" }, dayFmt.format(new Date(d)));
    }
  });

  for (const m of markers) {
    const i = days.indexOf(manilaDay(m.markedAt));
    if (i < 0) continue;
    add("line", { x1: x(i), x2: x(i), y1: pad.top, y2: height - pad.bottom, class: "marker-rule" });
    if (height > 180) add("text", { x: x(i) + 4, y: pad.top + 10, class: "marker-text" }, m.label);
  }

  for (const s of series) {
    let d = "";
    s.values.forEach((v, i) => {
      if (v == null) return;
      d += `${d && s.values[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    add("path", { d, class: "series", style: `stroke:${s.color}` });
  }

  const cross = add("line", { y1: pad.top, y2: height - pad.bottom, class: "crosshair", visibility: "hidden" });
  const dots = series.map((s) => add("circle", { r: 4, class: "dot", style: `fill:${s.color}`, visibility: "hidden" }));
  const hit = add("rect", { x: pad.left, y: 0, width: width - pad.left - pad.right, height, fill: "transparent", tabindex: 0 });

  let focusIndex = days.length - 1;
  const show = (i, clientX, clientY) => {
    focusIndex = i;
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    series.forEach((s, j) => {
      const v = s.values[i];
      dots[j].setAttribute("visibility", v == null ? "hidden" : "visible");
      if (v != null) { dots[j].setAttribute("cx", x(i)); dots[j].setAttribute("cy", y(v)); }
    });
    tooltip.replaceChildren(el("div", "tt-day", dayFmt.format(new Date(days[i]))));
    for (const s of series) {
      const row = el("div", "tt-row");
      const key = el("span", "key-line");
      key.style.background = s.color;
      row.append(key, el("strong", null, s.values[i] == null ? "–" : whole.format(s.values[i])), el("span", null, s.label));
      tooltip.append(row);
    }
    const marker = markers.find((m) => manilaDay(m.markedAt) === days[i]);
    if (marker) tooltip.append(el("div", "tt-marker", marker.label));
    tooltip.hidden = false;
    const box = node.getBoundingClientRect();
    const px = clientX ?? box.left + x(i);
    const py = clientY ?? box.top + pad.top;
    const left = Math.min(window.innerWidth - tooltip.offsetWidth - 8, px + 14);
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, py - tooltip.offsetHeight - 10)}px`;
  };
  const hide = () => {
    cross.setAttribute("visibility", "hidden");
    dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    tooltip.hidden = true;
  };
  const indexAt = (clientX) => {
    const box = svg.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * width;
    return Math.max(0, Math.min(days.length - 1, Math.round(((px - pad.left) / (width - pad.left - pad.right)) * (days.length - 1))));
  };
  hit.addEventListener("pointermove", (e) => show(indexAt(e.clientX), e.clientX, e.clientY));
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => show(focusIndex));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      show(Math.max(0, Math.min(days.length - 1, focusIndex + (e.key === "ArrowLeft" ? -1 : 1))));
    }
  });

  node.replaceChildren(svg);
}

// Controls

function bindRadios(groupId, attr, apply) {
  const group = $(groupId);
  group.addEventListener("click", (e) => {
    const btn = e.target.closest(`[data-${attr}]`);
    if (!btn) return;
    for (const b of group.querySelectorAll("button")) b.setAttribute("aria-checked", String(b === btn));
    apply(btn.dataset[attr]);
    render();
  });
}

bindRadios("ranges", "range", (v) => { state.range = v === "all" ? "all" : Number(v); });
bindRadios("platforms", "platform", (v) => { state.platform = v; });

// Charts are drawn to their container's width, so redraw when the width changes.
let resizeTimer;
let lastWidth = 0;
new ResizeObserver(([entry]) => {
  const w = Math.round(entry.contentRect.width);
  if (w === lastWidth) return;
  lastWidth = w;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.data && render(), 120);
}).observe(document.querySelector(".stats"));

$("marker-form").markedAt.value = defaultWhen();

loadStats()
  .then((data) => {
    state.data = data;
    render();
  })
  .catch((err) => {
    console.error(err);
    $("sub").textContent = `Couldn't load stats: ${err.message}`;
  });
