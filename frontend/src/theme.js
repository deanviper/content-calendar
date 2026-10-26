// Light and dark themes. The inline script in each page's <head> sets data-theme before the first
// paint; this module wires the toggle button and follows the system setting until the viewer picks.

const KEY = "theme";
const root = document.documentElement;
const system = matchMedia("(prefers-color-scheme: light)");

function stored() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

function apply(theme) {
  root.dataset.theme = theme;
}

export function initThemeToggle(button) {
  const label = () => {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    button.setAttribute("aria-label", `Switch to ${next} mode`);
    button.title = `Switch to ${next} mode`;
  };
  button.addEventListener("click", () => {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    apply(next);
    try { localStorage.setItem(KEY, next); } catch { /* the choice lasts this visit */ }
    label();
  });
  system.addEventListener("change", () => {
    if (stored()) return;
    apply(system.matches ? "light" : "dark");
    label();
  });
  label();
}
