// Servicio de Autenticación, Roles, Permisos y Control de Acceso (Secciones 10 y 12).
// Define permisos granulares para cada rol del negocio (Administrador, Cajero, Inventario,
// Contabilidad y Empleado) y bloquea cuentas desactivadas o sin autorización.

const SESSION_KEY = "elcarmen_spa_session";

export const ROLES = {
  ADMIN: "Administrador",
  CAJERO: "Cajero",
  INVENTARIO: "Inventario",
  CONTABILIDAD: "Contabilidad",
  EMPLEADO: "Empleado"
};

// Matriz de permisos del sistema (Sección 10)
const ROLE_PERMISSIONS = {
  [ROLES.ADMIN]: new Set([
    "caja.abrir",
    "caja.cerrar",
    "caja.movimiento_efectivo",
    "caja.ver_cierres",
    "ventas.registrar",
    "ventas.consultar",
    "ventas.descuento",
    "ventas.modificar_precio",
    "ventas.anular",
    "ventas.devolucion",
    "ventas.credito",
    "ventas.abonar",
    "clientes.crear",
    "inventario.consultar",
    "inventario.gestionar",
    "contabilidad.consultar",
    "contabilidad.gestionar",
    "contabilidad.revertir",
    "reportes.ver",
    "usuarios.gestionar"
  ]),
  [ROLES.CAJERO]: new Set([
    "caja.abrir",
    "caja.cerrar",
    "caja.movimiento_efectivo",
    "ventas.registrar",
    "ventas.consultar",
    "ventas.abonar",
    "clientes.crear",
    "inventario.consultar"
  ]),
  [ROLES.INVENTARIO]: new Set([
    "inventario.consultar",
    "inventario.gestionar"
  ]),
  [ROLES.CONTABILIDAD]: new Set([
    "contabilidad.consultar",
    "contabilidad.gestionar",
    "reportes.ver",
    "caja.ver_cierres"
  ]),
  [ROLES.EMPLEADO]: new Set([
    "caja.abrir",
    "caja.cerrar",
    "caja.movimiento_efectivo",
    "ventas.registrar",
    "ventas.consultar",
    "ventas.abonar",
    "clientes.crear"
  ])
};

export function getRoleLabel(role) {
  return role === ROLES.ADMIN ? "Administrador" : "Empleado general";
}

export function canAccessRoute(routeKey, user = getCurrentUser()) {
  if (!user || !user.role || user.activo === false) return false;
  if (user.role === ROLES.ADMIN) return true;
  return routeKey === "caja" || routeKey === "dashboard";
}

export function applySidebarVisibility(user = getCurrentUser()) {
  const esAdmin = user?.role === ROLES.ADMIN;
  document.querySelectorAll(".sidebar .nav-list li").forEach((li) => {
    const link = li.querySelector("a[data-route]");
    const route = link?.dataset.route;
    if (!esAdmin && route !== "dashboard" && route !== "caja") {
      li.classList.add("hidden");
      li.style.display = "none";
    } else {
      li.classList.remove("hidden");
      li.style.display = "";
    }
  });
  document.querySelectorAll("[data-role='admin']").forEach((el) => {
    if (el.closest(".sidebar .nav-list")) return;
    el.classList.toggle("hidden", !esAdmin);
  });
}

export function getCurrentUser() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {
    // Ignorar error de sessionStorage
  }
  return {
    uid: "usr-owner",
    email: "vidrios.aluminioselcarmen@gmail.com",
    name: "Vidrios y Aluminios El Carmen",
    role: ROLES.ADMIN,
    activo: true
  };
}

export function setCurrentUser(user) {
  try {
    if (user) sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignorar
  }
}

export function hasPermission(permission, user = getCurrentUser()) {
  if (!user || !user.role) return false;
  if (user.activo === false) return false;
  const set = ROLE_PERMISSIONS[user.role];
  if (!set) return false;
  return set.has(permission);
}

export function assertPermission(permission, user = getCurrentUser()) {
  if (!user) {
    throw new Error("Debes iniciar sesión para realizar esta operación.");
  }
  if (user.activo === false) {
    throw new Error("Tu cuenta de usuario está desactivada. Contacta al Administrador.");
  }
  if (!hasPermission(permission, user)) {
    throw new Error(`No tienes permisos para realizar esta acción (${permission}). Requiere autorización de Administrador o del rol correspondiente.`);
  }
}
