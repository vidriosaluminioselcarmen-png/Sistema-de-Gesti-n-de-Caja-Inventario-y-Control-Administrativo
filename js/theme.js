// Gestor de tema visual (Modo Claro / Modo Oscuro en gris neutro) — Vidrios y Aluminios El Carmen.
// Persiste la preferencia en localStorage ("elcarmen_theme") y respeta prefers-color-scheme
// únicamente cuando el usuario no ha elegido un tema manualmente.

export const THEME_STORAGE_KEY = "elcarmen_theme";

export function getPreferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // Ignorar si localStorage no está disponible
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

export function applyTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", normalized);
  syncThemeToggleButtons(normalized);
  return normalized;
}

export function setTheme(theme) {
  const normalized = applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, normalized);
  } catch {
    // Ignorar si localStorage no está disponible
  }
  return normalized;
}

export function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  return setTheme(current === "dark" ? "light" : "dark");
}

export function syncThemeToggleButtons(theme = getPreferredTheme()) {
  const isDark = theme === "dark";
  const label = isDark ? "Modo claro" : "Modo oscuro";
  const icon = isDark
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(isDark));
    btn.setAttribute("title", isDark ? "Cambiar a Modo claro" : "Cambiar a Modo oscuro");
    btn.innerHTML = `${icon}<span>${label}</span>`;
  });
}

export function initTheme() {
  applyTheme(getPreferredTheme());
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    toggleTheme();
  });
}
