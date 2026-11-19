// Enrutador SPA: intercepta clics de navegación, actualiza history.pushState
// e inyecta dinámicamente las vistas de /html/<modulo>.html dentro de #app-root.
import { canAccessRoute, getCurrentUser, applySidebarVisibility } from "./auth.js";

export const ROUTES = {
  dashboard: {
    path: "/dashboard",
    file: "dashboard.html",
    title: "Dashboard",
    subtitle: "Estado en tiempo real de Caja y Ventas, Inventario y Contabilidad"
  },
  caja: {
    path: "/caja",
    file: "caja.html",
    title: "Caja y Ventas",
    subtitle: "Punto de venta, métodos de pago y cierre de caja"
  },
  inventario: {
    path: "/inventario",
    file: "inventario.html",
    title: "Inventario",
    subtitle: "Catálogo, existencias y movimientos de entrada y salida"
  },
  contabilidad: {
    path: "/contabilidad",
    file: "contabilidad.html",
    title: "Contabilidad Básica",
    subtitle: "Ingresos, gastos y movimientos administrativos"
  },
  reportes: {
    path: "/reportes",
    file: "reportes.html",
    title: "Consultas y Reportes",
    subtitle: "Filtros por fecha, cierres históricos y exportación PDF"
  },
  usuarios: {
    path: "/usuarios",
    file: "usuarios.html",
    title: "Usuarios y Seguridad",
    subtitle: "Usuarios, roles y permisos de acceso",
    adminOnly: true
  }
};

export const DEFAULT_ROUTE = "caja";

const viewCache = new Map();
const viewHandlers = new Map();
let activeCleanup = null;
let currentRouteKey = null;

// Permite que cada módulo registre su lógica post-inyección: registerView("caja", (root) => cleanupFn)
export function registerView(routeKey, mountFn) {
  viewHandlers.set(routeKey, mountFn);
}

// Resuelve el directorio base donde están las plantillas /html/*.html
function getHtmlBaseUrl() {
  const path = window.location.pathname;
  if (path.includes("/html/")) {
    return new URL("./", window.location.href).href;
  }
  const baseDir = path.endsWith("/") ? path : path.substring(0, path.lastIndexOf("/") + 1);
  return new URL(`${baseDir}html/`, window.location.origin).href;
}

// Extrae únicamente el bloque <main id="app-root">...</main> del archivo HTML del módulo
async function loadViewMarkup(routeKey) {
  if (viewCache.has(routeKey)) return viewCache.get(routeKey);

  // 1. Si existe <template id="tpl-<modulo>"> en el documento, lectura instantánea
  const inlineTpl = document.getElementById(`tpl-${routeKey}`);
  if (inlineTpl) {
    const markup = inlineTpl.innerHTML.trim();
    viewCache.set(routeKey, markup);
    return markup;
  }

  // 2. De lo contrario, cargar desde /html/<modulo>.html vía fetch
  const route = ROUTES[routeKey];
  const url = `${getHtmlBaseUrl()}${route.file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo cargar la vista: ${route.file}`);

  const htmlText = await res.text();
  const doc = new DOMParser().parseFromString(htmlText, "text/html");
  const mainEl = doc.querySelector("#app-root");
  const markup = mainEl ? mainEl.innerHTML.trim() : htmlText;

  viewCache.set(routeKey, markup);
  return markup;
}

// Convierte cualquier href ("html/caja.html", "caja.html", "/caja", "#") o data-route en clave de ROUTES
export function resolveRouteKey(rawTarget) {
  if (!rawTarget) return null;
  const clean = rawTarget.split("?")[0].split("#")[0].trim();
  if (!clean) return null;

  if (ROUTES[clean]) return clean;

  const byFile = Object.entries(ROUTES).find(
    ([key, r]) => clean.endsWith(`/${r.file}`) || clean === r.file || clean.endsWith(`/${key}`)
  );
  return byFile ? byFile[0] : null;
}

// Determina qué ruta corresponde a la URL actual del navegador
export function getRouteFromLocation() {
  const hashKey = window.location.hash.replace(/^#\/?/, "");
  if (ROUTES[hashKey]) return hashKey;

  const fromPath = resolveRouteKey(window.location.pathname);
  return fromPath || DEFAULT_ROUTE;
}

// Actualiza título, subtítulo y estado activo de la barra lateral
function updateShellUI(routeKey) {
  const route = ROUTES[routeKey];
  document.title = `${route.title} | El Carmen`;

  const titleEl = document.querySelector(".topbar-title h1");
  const subEl = document.querySelector(".topbar-title p");
  if (titleEl) titleEl.textContent = route.title;
  if (subEl) subEl.textContent = route.subtitle;

  document.querySelectorAll(".sidebar .nav-link").forEach((link) => {
    const key = link.dataset.route || resolveRouteKey(link.getAttribute("href"));
    link.classList.toggle("active", key === routeKey);
  });
  applySidebarVisibility(getCurrentUser());

  // Cerrar drawer móvil si estaba abierto
  const navToggle = document.getElementById("nav-toggle");
  if (navToggle) navToggle.checked = false;
}

// Navega a una vista e inyecta su plantilla en #app-root sin recargar la página
export async function navigateTo(routeKey, { replace = false, updateHistory = true } = {}) {
  let targetKey = ROUTES[routeKey] ? routeKey : DEFAULT_ROUTE;
  if (!canAccessRoute(targetKey, getCurrentUser())) {
    targetKey = DEFAULT_ROUTE;
  }
  const appRoot = document.getElementById("app-root");
  if (!appRoot) return;

  if (typeof activeCleanup === "function") {
    activeCleanup();
    activeCleanup = null;
  }

  // Si la vista inicial ya está renderizada en el DOM, la guardamos en caché antes de reemplazar
  const existingView = appRoot.querySelector(".view[data-view]");
  if (existingView && !viewCache.has(existingView.dataset.view)) {
    viewCache.set(existingView.dataset.view, appRoot.innerHTML.trim());
  }

  try {
    const markup = await loadViewMarkup(targetKey);
    appRoot.innerHTML = markup;
  } catch (err) {
    console.error(err);
  }

  currentRouteKey = targetKey;
  updateShellUI(targetKey);

  if (updateHistory) {
    const inHtmlSubfolder = window.location.pathname.includes("/html/");
    const newUrl = inHtmlSubfolder ? ROUTES[targetKey].file : `#/${targetKey}`;
    window.history[replace ? "replaceState" : "pushState"]({ route: targetKey }, "", newUrl);
  }

  window.scrollTo({ top: 0, behavior: "instant" });

  // Ejecutar controlador del módulo si está registrado
  const handler = viewHandlers.get(targetKey);
  if (typeof handler === "function") {
    activeCleanup = await handler(appRoot);
  }
}

export function getCurrentRoute() {
  return currentRouteKey;
}
