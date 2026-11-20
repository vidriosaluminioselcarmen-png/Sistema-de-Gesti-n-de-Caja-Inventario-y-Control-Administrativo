// Controlador principal del SPA:
// - Alterna entre #login-view y #dashboard-view sin recargar la página.
// - Registra los controladores reactivos de los 6 módulos (Dashboard, Caja y Ventas, Inventario,
//   Contabilidad, Reportes y Usuarios).
// - Gestiona autenticación, permisos de ruta, aviso de estado de Firebase, modales e impresión.

import {
  navigateTo,
  resolveRouteKey,
  getRouteFromLocation,
  getCurrentRoute,
  registerView,
  DEFAULT_ROUTE
} from "./router.js";
import { ROLES, getCurrentUser, setCurrentUser, canAccessRoute, getRoleLabel, applySidebarVisibility } from "./auth.js";
import { getFirebaseStatus, isFirebaseConfigured } from "./firebase-config.js";
import { verificarConexionRealFirebase } from "./services/firebase-service.js";
import { ensureSeedData } from "./services/store.js";
import { autenticarUsuario, cerrarSesionUsuario, watchUsuarios } from "./services/usuarios-service.js";
import { initTheme } from "./theme.js";
import { mountCajaView } from "./views/caja-view.js";
import {
  mountInventarioView,
  mountContabilidadView,
  mountDashboardView,
  mountReportesView,
  mountUsuariosView
} from "./views/other-views.js";

// Registrar los controladores reactivos de cada módulo en el router
registerView("dashboard", mountDashboardView);
registerView("caja", mountCajaView);
registerView("inventario", mountInventarioView);
registerView("contabilidad", mountContabilidadView);
registerView("reportes", mountReportesView);
registerView("usuarios", mountUsuariosView);

const loginView = document.getElementById("login-view");
const dashboardView = document.getElementById("dashboard-view");
const loginForm = document.getElementById("login-form");

function hasActiveSession() {
  try {
    return Boolean(sessionStorage.getItem("elcarmen_spa_session"));
  } catch {
    return false;
  }
}

export function renderFirebaseConnectionBadge(liveStatus = null) {
  const badge = document.getElementById("firebase-status-badge");
  if (!badge) return;
  const status = getFirebaseStatus();
  if (liveStatus) {
    badge.textContent = `Firebase activo (${liveStatus.projectId || status.projectId})`;
    badge.className = "badge badge-success";
    badge.title = liveStatus.mensaje || status.message;
    return;
  }
  badge.textContent = status.connected
    ? `Firebase activo (${status.projectId})`
    : "Modo local · Firebase pendiente";
  badge.className = `badge ${status.connected ? "badge-success" : "badge-warning"}`;
  badge.title = status.message;

  if (isFirebaseConfigured() && !badge.dataset.verified) {
    badge.dataset.verified = "1";
    verificarConexionRealFirebase()
      .then((res) => {
        if (res && (res.conectado || res.configurado)) {
          renderFirebaseConnectionBadge(res);
        }
      })
      .catch(() => {});
  }
}

export function showLoginView() {
  if (!loginView || !dashboardView) {
    window.location.href = "../index.html";
    return;
  }
  dashboardView.classList.add("hidden");
  loginView.classList.remove("hidden");
  document.title = "Iniciar sesión | Vidrios y Aluminios El Carmen";
  window.history.replaceState({}, "", window.location.pathname);
}

function applyUserShellPermissions(user) {
  const nameEl = document.getElementById("user-name");
  const roleEl = document.getElementById("user-role");
  const avatarEl = document.getElementById("user-avatar");
  if (user && nameEl) nameEl.textContent = user.name;
  if (user && roleEl) roleEl.textContent = `Rol: ${getRoleLabel(user.role)}`;
  if (user && avatarEl) {
    avatarEl.textContent = String(user.name || "US")
      .split(" ")
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  }

  // Ocultar del menú lateral todo módulo distinto a Dashboard y Caja y Ventas para Empleado general
  applySidebarVisibility(user);
}

export async function showDashboardView(user, initialRoute) {
  if (loginView && dashboardView) {
    loginView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
  }

  applyUserShellPermissions(user);
  renderFirebaseConnectionBadge();

  let target = initialRoute || getRouteFromLocation() || DEFAULT_ROUTE;
  if (!canAccessRoute(target, user)) {
    target = DEFAULT_ROUTE;
  }
  await navigateTo(target, { replace: true });
}

function closeAllModals() {
  document.querySelectorAll(".modal-overlay.is-open").forEach((m) => m.classList.remove("is-open"));
}

function setupEventDelegation() {
  if (loginForm) {
    const loginErrEl = document.getElementById("login-error");
    const ocultarErrorLogin = () => {
      if (loginErrEl) loginErrEl.classList.add("hidden");
    };
    loginForm.email?.addEventListener("input", ocultarErrorLogin);
    loginForm.password?.addEventListener("input", ocultarErrorLogin);

    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      ocultarErrorLogin();
      try {
        const email = loginForm.email?.value || "admin@elcarmen.com";
        const password = loginForm.password?.value || "123456";
        const user = await autenticarUsuario({ email, password });
        await showDashboardView(user, DEFAULT_ROUTE);
      } catch (err) {
        if (loginErrEl) {
          loginErrEl.textContent = err.message || "No se pudo iniciar sesión.";
          loginErrEl.classList.remove("hidden");
        }
      }
    });
  }

  document.addEventListener("click", async (e) => {
    const printBtn = e.target.closest("#btn-imprimir");
    if (printBtn) {
      e.preventDefault();
      window.print();
      return;
    }

    const link = e.target.closest("a, button[data-route]");
    if (!link) return;

    if (link.classList.contains("logout")) {
      e.preventDefault();
      await cerrarSesionUsuario();
      showLoginView();
      return;
    }

    const href = link.getAttribute("href") || "";

    if (href.startsWith("#modal-")) {
      const modal = document.querySelector(href);
      if (modal) {
        e.preventDefault();
        modal.classList.add("is-open");
      }
      return;
    }

    if (href === "#" && link.closest(".modal-overlay")) {
      e.preventDefault();
      link.closest(".modal-overlay").classList.remove("is-open");
      return;
    }

    if (link.closest("#login-form")) {
      e.preventDefault();
      if (loginForm) loginForm.requestSubmit();
      return;
    }

    const routeKey = link.dataset.route || resolveRouteKey(href);
    if (routeKey) {
      e.preventDefault();
      const user = getCurrentUser();
      if (!canAccessRoute(routeKey, user)) {
        return;
      }
      closeAllModals();
      await navigateTo(routeKey);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllModals();
  });

  window.addEventListener("popstate", (e) => {
    const routeKey = e.state?.route || getRouteFromLocation();
    if (routeKey) navigateTo(routeKey, { updateHistory: false });
  });
}

function subscribeCurrentUserRoleSync() {
  watchUsuarios((lista) => {
    if (!hasActiveSession()) return;
    const actual = getCurrentUser();
    const correo = String(actual?.email || "").toLowerCase();
    const perfil = lista.find(
      (u) => (actual?.uid && u.uid === actual.uid) || String(u.email || "").toLowerCase() === correo
    );
    if (!perfil) return;
    if (perfil.activo === false) {
      cerrarSesionUsuario().catch(() => {});
      showLoginView();
      return;
    }
    const rolVigente = perfil.rol === ROLES.ADMIN ? ROLES.ADMIN : ROLES.EMPLEADO;
    const nombreVigente = perfil.nombre || actual.name;
    if (actual.role !== rolVigente || actual.name !== nombreVigente) {
      const actualizado = { ...actual, name: nombreVigente, role: rolVigente, activo: true };
      setCurrentUser(actualizado);
      applyUserShellPermissions(actualizado);
      const rutaActual = getCurrentRoute() || getRouteFromLocation();
      if (!canAccessRoute(rutaActual, actualizado)) {
        navigateTo(DEFAULT_ROUTE, { replace: true });
      }
    }
  });
}

function initApp() {
  initTheme();
  ensureSeedData();
  setupEventDelegation();
  renderFirebaseConnectionBadge();
  subscribeCurrentUserRoleSync();

  if (loginView && dashboardView) {
    if (hasActiveSession()) {
      const user = getCurrentUser();
      setCurrentUser(user);
      showDashboardView(user, getRouteFromLocation());
    } else {
      showLoginView();
    }
    return;
  }

  // Bloquear acceso directo a /html/*.html sin sesión autenticada
  if (!hasActiveSession()) {
    window.location.replace("../index.html");
    return;
  }

  const user = getCurrentUser();
  setCurrentUser(user);
  applyUserShellPermissions(user);
  navigateTo(getRouteFromLocation(), { replace: true, updateHistory: false });
}

initApp();
