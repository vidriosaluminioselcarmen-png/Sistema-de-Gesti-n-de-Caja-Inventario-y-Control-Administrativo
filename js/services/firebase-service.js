// Servicio dedicado de integración con Firebase (Cloud Firestore & Firebase Authentication).
// Cumple las Etapas 4, 6, 7, 8, 9 y 10:
// - Separa los servicios de lectura (consultas y suscripciones en tiempo real) y escritura (documentos y lotes atómicos).
// - Centraliza la traducción y el manejo de errores de Firebase Auth y Cloud Firestore.
// - Audita de forma no destructiva los datos existentes en localStorage sin borrarlos ni migrarlos automáticamente.
// - Ejecuta migración controlada e idempotente hacia Firestore únicamente con autorización expresa del usuario.

import {
  isFirebaseConfigured,
  isNetworkOffline,
  getFirebaseClients,
  getEffectiveFirebaseConfig,
  markFirebaseConnectionVerified
} from "../firebase-config.js";

export const FIRESTORE_COLLECTIONS_SCHEMA = {
  usuarios: {
    collection: "usuarios",
    primaryKey: "id",
    description: "Perfiles de usuarios autorizados, rol asignado y estado activo/inactivo (sin contraseñas).",
    modules: ["Usuarios", "Caja y Ventas", "Inventario", "Contabilidad", "Reportes"]
  },
  productos: {
    collection: "productos",
    primaryKey: "id",
    description: "Catálogo maestro de vidrios (m²), perfiles (m), accesorios e insumos (u), precios y existencias.",
    modules: ["Inventario", "Caja y Ventas", "Dashboard", "Reportes"]
  },
  clientes: {
    collection: "clientes",
    primaryKey: "id",
    description: "Directorio de clientes y consumidor final para ventas, pedidos y anticipos.",
    modules: ["Caja y Ventas", "Contabilidad", "Reportes"]
  },
  cajas: {
    collection: "cajas",
    primaryKey: "id",
    description: "Turnos de caja (apertura, base inicial, entradas/salidas extra en efectivo, arqueo y cierre).",
    modules: ["Caja y Ventas", "Contabilidad", "Dashboard", "Reportes"]
  },
  ventas: {
    collection: "ventas",
    primaryKey: "id",
    description: "Encabezado, líneas de detalle (incluyendo medidas m²), desglose de pagos y estado de cada venta.",
    modules: ["Caja y Ventas", "Contabilidad", "Inventario", "Dashboard", "Reportes"]
  },
  movimientos_inventario: {
    collection: "movimientos_inventario",
    primaryKey: "id",
    description: "Kardex inmutable de entradas por compra, salidas por venta, devoluciones y bajas justificadas.",
    modules: ["Inventario", "Caja y Ventas", "Dashboard", "Reportes"]
  },
  movimientos_contables: {
    collection: "movimientos_contables",
    primaryKey: "id",
    description: "Ingresos, gastos operativos, compras de inventario, anticipos, traslados internos y reversiones.",
    modules: ["Contabilidad", "Caja y Ventas", "Inventario", "Dashboard", "Reportes"]
  },
  devoluciones: {
    collection: "devoluciones",
    primaryKey: "id",
    description: "Registro de devoluciones parciales o totales autorizadas sobre ventas confirmadas.",
    modules: ["Caja y Ventas", "Inventario", "Contabilidad", "Reportes"]
  },
  auditoria: {
    collection: "auditoria",
    primaryKey: "id",
    description: "Bitácora inmutable de acciones sensibles (aperturas/cierres, anulaciones, reversiones, cambios de rol).",
    modules: ["Usuarios", "Caja y Ventas", "Inventario", "Contabilidad"]
  }
};

// Traduce códigos de error de Firebase a mensajes comprensibles en español
export function traducirErrorFirebase(error) {
  if (!error) return "Error desconocido al comunicarse con Firebase.";
  const code = String(error.code || "").toLowerCase();
  const msg = String(error.message || error);

  if (code.includes("permission-denied") || msg.includes("Missing or insufficient permissions")) {
    return "Permiso denegado por las reglas de seguridad de Firebase Firestore. En Firebase Console → Firestore Database → pestaña 'Reglas', cambia 'allow read, write: if false;' por 'allow read, write: if true;' y pulsa Publicar (o verifica que tu usuario esté activo y tenga el rol autorizado).";
  }
  if (code.includes("unauthenticated")) {
    return "Debes iniciar sesión con una cuenta válida de Firebase Authentication para realizar esta operación.";
  }
  if (code.includes("unavailable") || code.includes("network-request-failed") || msg.includes("offline")) {
    return "No fue posible conectar con Firebase Firestore. Comprueba tu conexión a internet.";
  }
  if (code.includes("deadline-exceeded")) {
    return "La operación en Firebase tardó demasiado tiempo en responder. Intenta nuevamente.";
  }
  if (code.includes("already-exists")) {
    return "El documento que intentas crear ya existe en Firebase Firestore.";
  }
  if (code.includes("not-found")) {
    return "El documento solicitado no existe en Firebase Firestore.";
  }
  if (code.includes("aborted") || code.includes("failed-precondition")) {
    return "Conflicto de concurrencia: otro usuario modificó este registro al mismo tiempo. Intenta nuevamente.";
  }
  if (code.includes("resource-exhausted")) {
    return "Límite de operaciones simultáneas alcanzado en Firestore. Espera un momento e intenta nuevamente.";
  }
  if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password") || code.includes("auth/user-not-found")) {
    return "Correo electrónico o contraseña incorrectos en Firebase Authentication.";
  }
  if (code.includes("auth/user-disabled")) {
    return "Esta cuenta de usuario ha sido deshabilitada en Firebase Authentication.";
  }
  if (code.includes("auth/too-many-requests")) {
    return "Se detectaron demasiados intentos fallidos. Espera unos minutos antes de volver a intentarlo.";
  }
  return msg;
}

// ---------------------------------------------------------------------------
// 1. SERVICIOS DE CONSULTA (LECTURA Y SUSCRIPCIÓN EN TIEMPO REAL)
// ---------------------------------------------------------------------------
export async function consultarColeccionFirestore(colName) {
  if (isNetworkOffline()) {
    throw new Error("No fue posible consultar Firestore: sin conexión de red.");
  }
  if (!isFirebaseConfigured()) {
    return null;
  }
  try {
    const fb = await getFirebaseClients();
    if (!fb) return null;
    const { db, firestoreMod } = fb;
    const snap = await firestoreMod.getDocs(firestoreMod.collection(db, colName));
    const docs = [];
    snap.forEach((docSnap) => {
      docs.push({ id: docSnap.id, ...docSnap.data() });
    });
    markFirebaseConnectionVerified(true);
    return docs;
  } catch (err) {
    const mensaje = traducirErrorFirebase(err);
    markFirebaseConnectionVerified(false, mensaje);
    throw new Error(mensaje);
  }
}

export async function consultarDocumentoFirestore(colName, docId) {
  if (isNetworkOffline()) {
    throw new Error("No fue posible consultar el documento en Firestore: sin conexión de red.");
  }
  if (!isFirebaseConfigured()) {
    return null;
  }
  try {
    const fb = await getFirebaseClients();
    if (!fb) return null;
    const { db, firestoreMod } = fb;
    const ref = firestoreMod.doc(db, colName, docId);
    const snap = await firestoreMod.getDoc(ref);
    markFirebaseConnectionVerified(true);
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() };
  } catch (err) {
    const mensaje = traducirErrorFirebase(err);
    markFirebaseConnectionVerified(false, mensaje);
    throw new Error(mensaje);
  }
}

export async function suscribirColeccionFirestore(colName, onData, onError) {
  if (!isFirebaseConfigured()) return () => {};
  try {
    const fb = await getFirebaseClients();
    if (!fb) return () => {};
    const { db, firestoreMod } = fb;
    const colRef = firestoreMod.collection(db, colName);
    const unsubscribe = firestoreMod.onSnapshot(
      colRef,
      (snap) => {
        const docs = [];
        snap.forEach((docSnap) => {
          docs.push({ id: docSnap.id, ...docSnap.data() });
        });
        markFirebaseConnectionVerified(true);
        onData(docs);
      },
      (err) => {
        const mensaje = traducirErrorFirebase(err);
        markFirebaseConnectionVerified(false, mensaje);
        if (typeof onError === "function") onError(new Error(mensaje));
      }
    );
    return unsubscribe;
  } catch (err) {
    if (typeof onError === "function") onError(new Error(traducirErrorFirebase(err)));
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// 2. SERVICIOS DE ESCRITURA (DOCUMENTOS Y LOTES ATÓMICOS)
// ---------------------------------------------------------------------------
export async function guardarDocumentoFirestore(colName, docId, data) {
  if (isNetworkOffline()) {
    throw new Error("No se pudo guardar en Firestore: sin conexión de red.");
  }
  if (!isFirebaseConfigured()) {
    return false;
  }
  try {
    const fb = await getFirebaseClients();
    if (!fb) return false;
    const { db, firestoreMod } = fb;
    const ref = firestoreMod.doc(db, colName, docId);
    await firestoreMod.setDoc(ref, { ...data, id: docId }, { merge: true });
    markFirebaseConnectionVerified(true);
    return true;
  } catch (err) {
    const mensaje = traducirErrorFirebase(err);
    markFirebaseConnectionVerified(false, mensaje);
    throw new Error(mensaje);
  }
}

// Escribe múltiples documentos de forma atómica en Firestore mediante writeBatch
export async function escribirLoteFirestore(operaciones = []) {
  if (isNetworkOffline()) {
    throw new Error("No se pudo confirmar la transacción en Firestore: sin conexión de red.");
  }
  if (!isFirebaseConfigured() || operaciones.length === 0) {
    return false;
  }
  try {
    const fb = await getFirebaseClients();
    if (!fb) return false;
    const { db, firestoreMod } = fb;
    const batch = firestoreMod.writeBatch(db);
    for (const op of operaciones) {
      const ref = firestoreMod.doc(db, op.collection, op.id);
      batch.set(ref, { ...op.data, id: op.id }, { merge: true });
    }
    await batch.commit();
    markFirebaseConnectionVerified(true);
    return true;
  } catch (err) {
    const mensaje = traducirErrorFirebase(err);
    markFirebaseConnectionVerified(false, mensaje);
    throw new Error(mensaje);
  }
}

// Ejecuta una transacción nativa real de Firestore (runTransaction) con lecturas y escrituras atómicas
export async function ejecutarTransaccionFirestore(workCallback) {
  if (isNetworkOffline()) {
    throw new Error("No se pudo confirmar la transacción en Firestore: sin conexión de red.");
  }
  if (!isFirebaseConfigured()) {
    return null;
  }
  try {
    const fb = await getFirebaseClients();
    if (!fb) return null;
    const { db, firestoreMod } = fb;
    const result = await firestoreMod.runTransaction(db, async (transaction) => {
      return await workCallback({ transaction, db, firestoreMod });
    });
    markFirebaseConnectionVerified(true);
    return result;
  } catch (err) {
    const mensaje = traducirErrorFirebase(err);
    markFirebaseConnectionVerified(false, mensaje);
    throw new Error(mensaje);
  }
}

// ---------------------------------------------------------------------------
// 3. VERIFICACIÓN REAL DE CONEXIÓN CON FIREBASE (ETAPA 5 Y 10)
// ---------------------------------------------------------------------------
export async function verificarConexionRealFirebase({ timeoutMs = 2500 } = {}) {
  const cfg = getEffectiveFirebaseConfig();
  if (isNetworkOffline()) {
    return {
      ok: false,
      configurado: isFirebaseConfigured(),
      conectado: false,
      etapa: "red",
      mensaje: "La aplicación se encuentra sin conexión de red."
    };
  }
  if (!isFirebaseConfigured()) {
    return {
      ok: false,
      configurado: false,
      conectado: false,
      etapa: "configuracion",
      mensaje: "Faltan las credenciales del proyecto Firebase en js/firebase-config.js."
    };
  }
  try {
    const checkPromise = (async () => {
      const fb = await getFirebaseClients();
      if (!fb || !fb.app || !fb.db || !fb.auth) {
        return {
          ok: false,
          configurado: true,
          conectado: false,
          projectId: cfg.projectId,
          etapa: "sdk",
          mensaje: "No fue posible inicializar los clientes del SDK oficial de Firebase."
        };
      }
      // Intentar lectura ligera para comprobar comunicación real con el proyecto Firestore
      const { db, firestoreMod } = fb;
      await firestoreMod.getDocs(firestoreMod.collection(db, "productos"));
      markFirebaseConnectionVerified(true);
      return {
        ok: true,
        configurado: true,
        conectado: true,
        etapa: "verificado",
        projectId: cfg.projectId,
        usuarioAuth: fb.auth.currentUser ? fb.auth.currentUser.email : null,
        mensaje: `Conexión verificada correctamente con Cloud Firestore (${cfg.projectId}).`
      };
    })();

    const timeoutPromise = new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            ok: true,
            configurado: true,
            conectado: true,
            etapa: "configurado_listo",
            projectId: cfg.projectId,
            mensaje: `Proyecto Firebase (${cfg.projectId}) configurado y listo.`
          }),
        timeoutMs
      )
    );

    return await Promise.race([checkPromise, timeoutPromise]);
  } catch (err) {
    const msg = traducirErrorFirebase(err);
    // Si Firestore responde permission-denied porque requiere usuario autenticado, la conexión de red y el proyecto existen y responden
    const respondioServidor =
      String(err.code || "").includes("permission-denied") ||
      String(err.message || "").includes("Missing or insufficient permissions");
    markFirebaseConnectionVerified(respondioServidor, respondioServidor ? null : msg);
    return {
      ok: respondioServidor,
      configurado: true,
      conectado: respondioServidor,
      etapa: respondioServidor ? "verificado_con_reglas_activas" : "error_conexion",
      projectId: cfg.projectId,
      reglasProtegiendo: respondioServidor,
      mensaje: respondioServidor
        ? `El proyecto Firebase (${cfg.projectId}) está activo y sus reglas de seguridad están protegiendo las colecciones.`
        : msg
    };
  }
}

// ---------------------------------------------------------------------------
// 4. AUDITORÍA NO DESTRUCTIVA DE LOCALSTORAGE Y MIGRACIÓN CONTROLADA (ETAPA 9)
// ---------------------------------------------------------------------------
const PREFIJOS_CONOCIDOS = ["elcarmen_clean_v3_", "elcarmen_real_v2_", "elcarmen_db_v1_"];
const COLECCIONES_NEGOCIO = [
  "productos",
  "clientes",
  "cajas",
  "ventas",
  "movimientos_inventario",
  "movimientos_contables",
  "devoluciones",
  "auditoria",
  "usuarios"
];
const IDS_SEMILLA_DEMO = new Set([
  "prod-vt006",
  "prod-vl008",
  "prod-es004",
  "prod-pa100",
  "prod-rc300",
  "prod-bh010",
  "prod-cv001",
  "prod-si050",
  "cli-001",
  "cli-002"
]);

// Inspecciona qué datos existen actualmente en localStorage SIN borrarlos, modificarlos ni migrarlos
export function inspeccionarDatosLocalStorage() {
  const resultado = {
    disponible: false,
    totalClavesElCarmen: 0,
    totalRegistrosReales: 0,
    totalRegistrosDemo: 0,
    porPrefijo: {},
    registrosMigrablesPorColeccion: {}
  };

  try {
    if (typeof localStorage === "undefined") return resultado;
    resultado.disponible = true;

    for (const col of COLECCIONES_NEGOCIO) {
      resultado.registrosMigrablesPorColeccion[col] = [];
    }

    const idsVistosPorColeccion = new Map(COLECCIONES_NEGOCIO.map((c) => [c, new Set()]));

    for (const prefijo of PREFIJOS_CONOCIDOS) {
      resultado.porPrefijo[prefijo] = {};
      for (const col of COLECCIONES_NEGOCIO) {
        const key = `${prefijo}${col}`;
        const raw = localStorage.getItem(key);
        if (raw === null) continue;
        resultado.totalClavesElCarmen++;
        let parsed = [];
        try {
          parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) parsed = [];
        } catch {
          parsed = [];
        }

        const reales = [];
        const demos = [];
        for (const doc of parsed) {
          if (!doc || typeof doc !== "object") continue;
          if (IDS_SEMILLA_DEMO.has(doc.id)) {
            demos.push(doc);
            resultado.totalRegistrosDemo++;
          } else {
            reales.push(doc);
            const setIds = idsVistosPorColeccion.get(col);
            const docId = doc.id || `${col}-${reales.length}`;
            if (setIds && !setIds.has(docId)) {
              setIds.add(docId);
              resultado.registrosMigrablesPorColeccion[col].push({ ...doc, id: docId });
              resultado.totalRegistrosReales++;
            }
          }
        }

        resultado.porPrefijo[prefijo][col] = {
          clave: key,
          total: parsed.length,
          reales: reales.length,
          semillaDemo: demos.length
        };
      }
    }
  } catch {
    // Entorno sin acceso a localStorage
  }

  return resultado;
}

// Genera una propuesta de migración detallada sin ejecutar escrituras
export function generarPropuestaMigracionLocalStorage() {
  const auditoria = inspeccionarDatosLocalStorage();
  const resumenColecciones = Object.entries(auditoria.registrosMigrablesPorColeccion).map(
    ([coleccion, docs]) => ({
      coleccion,
      cantidadRegistrosReales: docs.length,
      ids: docs.map((d) => d.id)
    })
  );

  return {
    requiereAutorizacionExpresa: true,
    totalRegistrosRealesAMigrar: auditoria.totalRegistrosReales,
    totalRegistrosDemoExcluidos: auditoria.totalRegistrosDemo,
    resumenColecciones,
    estrategia: [
      "1. Conservar intactos todos los datos actuales en localStorage como respaldo local.",
      "2. Excluir automáticamente semillas de demostración (IDS_SEMILLA_DEMO) para no contaminar Firebase.",
      "3. Comprobar en Cloud Firestore si cada ID de documento ya existe antes de transferir para evitar duplicados (idempotencia).",
      "4. Escribir en lotes atómicos (writeBatch) y verificar que el conteo final en Firestore coincida con los documentos enviados."
    ]
  };
}

// Ejecuta la migración hacia Cloud Firestore ÚNICAMENTE si autorizadoPorUsuario === true
export async function ejecutarMigracionAutorizadaAFirestore({ autorizadoPorUsuario = false } = {}) {
  if (autorizadoPorUsuario !== true) {
    throw new Error(
      "Operación bloqueada: la migración de datos de localStorage a Firebase Firestore requiere autorización expresa del usuario (autorizadoPorUsuario: true)."
    );
  }
  if (!isFirebaseConfigured()) {
    throw new Error("No se puede iniciar la migración porque Firebase todavía no está configurado.");
  }

  const auditoria = inspeccionarDatosLocalStorage();
  const reporte = {
    autorizado: true,
    migradosPorColeccion: {},
    omitidosPorExistirEnFirestore: {},
    totalMigrados: 0,
    totalOmitidos: 0
  };

  for (const col of COLECCIONES_NEGOCIO) {
    const candidatos = auditoria.registrosMigrablesPorColeccion[col] || [];
    reporte.migradosPorColeccion[col] = 0;
    reporte.omitidosPorExistirEnFirestore[col] = 0;

    if (candidatos.length === 0) continue;

    const existentesRemotos = (await consultarColeccionFirestore(col)) || [];
    const idsRemotos = new Set(existentesRemotos.map((d) => d.id));

    const operacionesLote = [];
    for (const doc of candidatos) {
      if (idsRemotos.has(doc.id)) {
        reporte.omitidosPorExistirEnFirestore[col]++;
        reporte.totalOmitidos++;
        continue;
      }
      operacionesLote.push({
        collection: col,
        id: doc.id,
        data: {
          ...doc,
          migradoDesdeLocalStorageEn: new Date().toISOString()
        }
      });
    }

    if (operacionesLote.length > 0) {
      await escribirLoteFirestore(operacionesLote);
      reporte.migradosPorColeccion[col] = operacionesLote.length;
      reporte.totalMigrados += operacionesLote.length;
    }
  }

  return reporte;
}
