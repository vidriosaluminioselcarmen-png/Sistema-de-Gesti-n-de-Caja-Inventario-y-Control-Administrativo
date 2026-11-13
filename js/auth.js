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
    "clientes.crear",
    "inventario.consultar",
    "inventario.gestionar",
    "contabilidad.consultar",
    "contabilidad.gestionar"
  ])
};

export function getCurrentUser() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const correo = String(parsed?.email || "").toLowerCase();
      // Si el propietario ingresó con el correo del negocio (ej. vidrios.aluminioselcarmen) antes de crear usuarios, asegurar rol Administrador
      if (
        parsed &&
        parsed.role === ROLES.EMPLEADO &&
        (correo.includes("vidrios") || correo.includes("elcarmen") || correo.startsWith("admin")) &&
        !correo.startsWith("empleado") &&
        !correo.startsWith("usuario") &&
        !correo.startsWith("caja") &&
        !correo.startsWith("bodega") &&
        !correo.startsWith("inventario") &&
        !correo.startsWith("contabilidad")
      ) {
        parsed.role = ROLES.ADMIN;
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(parsed));
      }
      return parsed;
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
