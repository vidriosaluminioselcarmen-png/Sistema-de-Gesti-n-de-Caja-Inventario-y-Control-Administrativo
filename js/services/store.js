// Capa de acceso a datos transaccional y reactiva del sistema.
// Cumple las Secciones 3, 4, 11, 12 y 13:
// - Separa la interfaz de la persistencia y centraliza las colecciones del negocio.
// - Soporta Cloud Firestore (y Firebase Emulator Suite) cuando Firebase está configurado,
//   y almacenamiento local transaccional para desarrollo y pruebas previas a conectar Firebase/Netlify.
// - Soporta estado inicial completamente vacío (sin datos ficticios) y catálogo base opcional para pruebas.
// - Protege frente a errores de red y operaciones simultáneas.

import {
  isFirebaseConfigured,
  isNetworkOffline
} from "../firebase-config.js";
import {
  ejecutarTransaccionFirestore,
  escribirLoteFirestore,
  suscribirColeccionFirestore
} from "./firebase-service.js";
import { assertPermission, getCurrentUser } from "../auth.js";

const LEGACY_STORAGE_PREFIXES = ["elcarmen_db_v1_", "elcarmen_real_v2_"];
const STORAGE_PREFIX = "elcarmen_clean_v3_";
const DEMO_PRODUCT_IDS = new Set([
  "prod-vt006",
  "prod-vl008",
  "prod-es004",
  "prod-pa100",
  "prod-rc300",
  "prod-bh010",
  "prod-cv001",
  "prod-si050"
]);

export const COLLECTIONS = {
  PRODUCTOS: "productos",
  CLIENTES: "clientes",
  CAJAS: "cajas",
  VENTAS: "ventas",
  MOV_INVENTARIO: "movimientos_inventario",
  MOV_CONTABLES: "movimientos_contables",
  DEVOLUCIONES: "devoluciones",
  AUDITORIA: "auditoria",
  USUARIOS: "usuarios",
  CONTROL: "control",
  OPERACIONES: "operaciones",
  MOV_BILLETERA: "movimientos_billetera"
};

// Catálogo base opcional para pruebas locales de desarrollo (nunca incluye ventas ni saldos ficticios)
export const INITIAL_PRODUCTOS = [
  {
    id: "prod-vt006",
    codigo: "VT-006",
    nombre: "Vidrio templado 6 mm",
    descripcion: "Lámina de vidrio templado incoloro de seguridad 6 mm",
    categoria: "Vidrios",
    unidad: "m²",
    permiteDecimal: true,
    permiteDimensiones: true,
    esPersonalizado: true,
    precioCompra: 52000,
    precio: 85000,
    stock: 24,
    stockMinimo: 10,
    activo: true
  },
  {
    id: "prod-vl008",
    codigo: "VL-008",
    nombre: "Vidrio laminado 8 mm",
    descripcion: "Vidrio laminado acústico y de seguridad 4+4 mm",
    categoria: "Vidrios",
    unidad: "m²",
    permiteDecimal: true,
    permiteDimensiones: true,
    esPersonalizado: true,
    precioCompra: 76000,
    precio: 120000,
    stock: 12,
    stockMinimo: 10,
    activo: true
  },
  {
    id: "prod-es004",
    codigo: "ES-004",
    nombre: "Espejo 4 mm",
    descripcion: "Espejo cristal 4 mm acabado pulido",
    categoria: "Vidrios",
    unidad: "m²",
    permiteDecimal: true,
    permiteDimensiones: true,
    esPersonalizado: true,
    precioCompra: 40000,
    precio: 65000,
    stock: 18,
    stockMinimo: 6,
    activo: true
  },
  {
    id: "prod-pa100",
    codigo: "PA-100",
    nombre: "Perfil aluminio 1\"",
    descripcion: "Perfil tubular de aluminio anodizado natural",
    categoria: "Perfiles",
    unidad: "m",
    permiteDecimal: true,
    permiteDimensiones: false,
    esPersonalizado: false,
    precioCompra: 18000,
    precio: 28500,
    stock: 60,
    stockMinimo: 10,
    activo: true
  },
  {
    id: "prod-rc300",
    codigo: "RC-300",
    nombre: "Riel corredizo 3 m",
    descripcion: "Riel superior/inferior para sistema corredizo",
    categoria: "Perfiles",
    unidad: "m",
    permiteDecimal: true,
    permiteDimensiones: false,
    esPersonalizado: false,
    precioCompra: 26500,
    precio: 42000,
    stock: 35,
    stockMinimo: 8,
    activo: true
  },
  {
    id: "prod-bh010",
    codigo: "BH-010",
    nombre: "Bisagra hidráulica",
    descripcion: "Bisagra de piso/puerta para vidrio templado",
    categoria: "Accesorios",
    unidad: "u",
    permiteDecimal: false,
    permiteDimensiones: false,
    esPersonalizado: false,
    precioCompra: 11000,
    precio: 18000,
    stock: 40,
    stockMinimo: 10,
    activo: true
  },
  {
    id: "prod-cv001",
    codigo: "CV-001",
    nombre: "Cerradura para vidrio",
    descripcion: "Cerradura central con llave para puerta de vidrio",
    categoria: "Accesorios",
    unidad: "u",
    permiteDecimal: false,
    permiteDimensiones: false,
    esPersonalizado: false,
    precioCompra: 34000,
    precio: 54000,
    stock: 3,
    stockMinimo: 5,
    activo: true
  },
  {
    id: "prod-si050",
    codigo: "SI-050",
    nombre: "Silicona estructural",
    descripcion: "Cartucho de silicona neutra para sellado de vidriería",
    categoria: "Insumos",
    unidad: "u",
    permiteDecimal: false,
    permiteDimensiones: false,
    esPersonalizado: false,
    precioCompra: 10200,
    precio: 16500,
    stock: 0,
    stockMinimo: 6,
    activo: true
  }
];

export const INITIAL_CLIENTES = [
  {
    id: "cli-consumidor",
    nombre: "Consumidor Final",
    documento: "222222222222",
    telefono: "",
    esConsumidorFinal: true
  },
  {
    id: "cli-001",
    nombre: "Constructora del Norte S.A.S.",
    documento: "900412589-1",
    telefono: "3104558899",
    esConsumidorFinal: false
  },
  {
    id: "cli-002",
    nombre: "Carlos Andrés Mejía",
    documento: "71289450",
    telefono: "3157782310",
    esConsumidorFinal: false
  }
];

export const INITIAL_USUARIOS = [
  {
    id: "usr-admin",
    uid: "usr-admin",
    nombre: "Administrador",
    email: "admin@elcarmen.com",
    rol: "Administrador",
    activo: true,
    creadoEn: "2026-10-01T08:00:00.000Z"
  },
  {
    id: "usr-caja",
    uid: "usr-caja",
    nombre: "Cajero Principal",
    email: "caja@elcarmen.com",
    rol: "Cajero",
    activo: true,
    creadoEn: "2026-10-01T08:00:00.000Z"
  },
  {
    id: "usr-bodega",
    uid: "usr-bodega",
    nombre: "Encargado Inventario",
    email: "bodega@elcarmen.com",
    rol: "Inventario",
    activo: true,
    creadoEn: "2026-10-01T08:00:00.000Z"
  },
  {
    id: "usr-contabilidad",
    uid: "usr-contabilidad",
    nombre: "Auxiliar Contable",
    email: "contabilidad@elcarmen.com",
    rol: "Contabilidad",
    activo: true,
    creadoEn: "2026-10-01T08:00:00.000Z"
  }
];

const listeners = new Map();
const firestoreUnsubscribers = new Map();
let firestoreCache = {};
let memoryStore = null;
let inMemoryTestMode = false;
const activeLocks = new Set();

export function isInMemoryTestMode() {
  return inMemoryTestMode;
}

function getStorage() {
  if (inMemoryTestMode) return null;
  try {
    if (
      typeof localStorage !== "undefined" &&
      typeof localStorage.getItem === "function" &&
      typeof localStorage.setItem === "function"
    ) {
      return localStorage;
    }
  } catch {
    // Entorno sin localStorage
  }
  return null;
}

function readCollectionRaw(colName) {
  if (!inMemoryTestMode && isFirebaseConfigured() && Array.isArray(firestoreCache[colName])) {
    return firestoreCache[colName];
  }
  const storage = getStorage();
  if (storage) {
    const raw = storage.getItem(STORAGE_PREFIX + colName);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return [];
      }
    }
    return null;
  }
  if (!memoryStore) memoryStore = {};
  return memoryStore[colName] || null;
}

function writeCollectionRaw(colName, docs) {
  if (!inMemoryTestMode && isFirebaseConfigured()) {
    firestoreCache[colName] = JSON.parse(JSON.stringify(docs));
  }
  const storage = getStorage();
  if (storage) {
    storage.setItem(STORAGE_PREFIX + colName, JSON.stringify(docs));
  } else {
    if (!memoryStore) memoryStore = {};
    memoryStore[colName] = JSON.parse(JSON.stringify(docs));
  }
}

// En la aplicación real NO se inyectan productos, ventas, cajas ni movimientos ficticios,
// ni se eliminan o sobrescriben datos existentes del usuario en localStorage (Etapa 9).
export function ensureSeedData() {
  if (inMemoryTestMode) {
    if (!readCollectionRaw(COLLECTIONS.PRODUCTOS)) {
      writeCollectionRaw(COLLECTIONS.PRODUCTOS, INITIAL_PRODUCTOS);
    }
    if (!readCollectionRaw(COLLECTIONS.CLIENTES)) {
      writeCollectionRaw(COLLECTIONS.CLIENTES, INITIAL_CLIENTES);
    }
    if (!readCollectionRaw(COLLECTIONS.USUARIOS)) {
      writeCollectionRaw(COLLECTIONS.USUARIOS, INITIAL_USUARIOS);
    }
  } else {
    if (!readCollectionRaw(COLLECTIONS.CLIENTES)) {
      writeCollectionRaw(COLLECTIONS.CLIENTES, [
        {
          id: "cli-consumidor",
          nombre: "Consumidor Final",
          documento: "222222222222",
          telefono: "",
          esConsumidorFinal: true
        }
      ]);
    }
    if (!readCollectionRaw(COLLECTIONS.USUARIOS)) {
      writeCollectionRaw(COLLECTIONS.USUARIOS, [
        {
          id: "usr-owner",
          uid: "usr-owner",
          nombre: "Vidrios y Aluminios El Carmen",
          email: "vidrios.aluminioselcarmen@gmail.com",
          rol: "Administrador",
          esPropietario: true,
          activo: true,
          creadoEn: new Date().toISOString()
        }
      ]);
    }
  }
  for (const col of Object.values(COLLECTIONS)) {
    if (!readCollectionRaw(col)) writeCollectionRaw(col, []);
  }
}

// Deja todas las colecciones completamente vacías (para verificar Carga inicial sin datos — Prueba 1)
export function resetDatabaseEmpty() {
  inMemoryTestMode = true;
  if (!memoryStore) memoryStore = {};
  for (const col of Object.values(COLLECTIONS)) {
    writeCollectionRaw(col, []);
    memoryStore[col] = [];
  }
  for (const col of Object.values(COLLECTIONS)) notifyListeners(col);
}

// Reinicia la base de datos en memoria para la suite de pruebas sin contaminar localStorage de la app real
export function resetDatabaseForTests() {
  inMemoryTestMode = true;
  memoryStore = {};
  ensureSeedData();
  for (const col of Object.values(COLLECTIONS)) notifyListeners(col);
}

function notifyListeners(colName) {
  const subs = listeners.get(colName);
  if (!subs) return;
  const snapshot = getCollection(colName);
  subs.forEach((cb) => {
    try {
      cb(snapshot);
    } catch (e) {
      console.error("Error en listener de colección:", colName, e);
    }
  });
}

export function getCollection(colName) {
  if (isNetworkOffline()) {
    throw new Error("No fue posible consultar los datos: sin conexión con la base de datos.");
  }
  ensureSeedData();
  const docs = readCollectionRaw(colName) || [];
  return JSON.parse(JSON.stringify(docs));
}

export function getDocById(colName, id) {
  const docs = getCollection(colName);
  return docs.find((d) => d.id === id) || null;
}

export function subscribeCollection(colName, callback) {
  ensureSeedData();
  if (!listeners.has(colName)) listeners.set(colName, new Set());
  const subs = listeners.get(colName);
  subs.add(callback);

  // Si Firebase está configurado (y no estamos en modo de prueba en memoria), activar listener onSnapshot de Firestore
  if (!inMemoryTestMode && isFirebaseConfigured() && !firestoreUnsubscribers.has(colName)) {
    suscribirColeccionFirestore(
      colName,
      (remoteDocs) => {
        firestoreCache[colName] = remoteDocs;
        notifyListeners(colName);
      },
      (err) => {
        console.warn(`Aviso en suscripción Firestore (${colName}):`, err.message);
      }
    ).then((unsub) => {
      firestoreUnsubscribers.set(colName, unsub);
    });
  }

  try {
    callback(getCollection(colName));
  } catch (err) {
    console.error("Error inicializando suscripción:", colName, err);
  }
  return () => subs.delete(callback);
}

let idCounter = 1;
export function generateId(prefix = "doc") {
  const rand = Math.random().toString(36).substring(2, 7);
  return `${prefix}-${Date.now()}-${idCounter++}-${rand}`;
}

function cloneSnapshotFromCache() {
  const snapshot = {};
  for (const col of Object.values(COLLECTIONS)) {
    snapshot[col] = readCollectionRaw(col)
      ? JSON.parse(JSON.stringify(readCollectionRaw(col)))
      : [];
  }
  return snapshot;
}

function buildTxContext(snapshotBefore) {
  const touchedCollections = new Set();
  const dirtyMap = new Map();

  const tx = {
    getAll(colName) {
      return snapshotBefore[colName] ? JSON.parse(JSON.stringify(snapshotBefore[colName])) : [];
    },
    get(colName, id) {
      const list = snapshotBefore[colName] || [];
      const found = list.find((d) => d.id === id);
      return found ? JSON.parse(JSON.stringify(found)) : null;
    },
    insert(colName, docData) {
      const list = snapshotBefore[colName] || [];
      const newDoc = {
        ...JSON.parse(JSON.stringify(docData)),
        id: docData.id || generateId(colName.slice(0, 3))
      };
      list.push(newDoc);
      snapshotBefore[colName] = list;
      touchedCollections.add(colName);
      dirtyMap.set(`${colName}::${newDoc.id}`, { collection: colName, id: newDoc.id, data: newDoc });
      return newDoc;
    },
    update(colName, id, patch) {
      const list = snapshotBefore[colName] || [];
      const idx = list.findIndex((d) => d.id === id);
      if (idx === -1) throw new Error(`Registro no encontrado en ${colName}: ${id}`);
      list[idx] = { ...list[idx], ...JSON.parse(JSON.stringify(patch)), id };
      touchedCollections.add(colName);
      dirtyMap.set(`${colName}::${id}`, { collection: colName, id, data: list[idx] });
      return list[idx];
    },
    upsert(colName, id, docData) {
      const list = snapshotBefore[colName] || [];
      const idx = list.findIndex((d) => d.id === id);
      const nextDoc = {
        ...(idx !== -1 ? list[idx] : {}),
        ...JSON.parse(JSON.stringify(docData)),
        id
      };
      if (idx !== -1) {
        list[idx] = nextDoc;
      } else {
        list.push(nextDoc);
      }
      snapshotBefore[colName] = list;
      touchedCollections.add(colName);
      dirtyMap.set(`${colName}::${id}`, { collection: colName, id, data: nextDoc });
      return nextDoc;
    }
  };

  return {
    tx,
    getDirtyDocs: () => Array.from(dirtyMap.values()),
    getTouchedCollections: () => Array.from(touchedCollections)
  };
}

function resolveTxReadDocs(options, snapshot) {
  const specs = [];
  if (Array.isArray(options.readDocs)) {
    specs.push(...options.readDocs);
  }
  if (typeof options.resolveReadDocs === "function") {
    const extra = options.resolveReadDocs(snapshot);
    if (Array.isArray(extra)) specs.push(...extra);
  }
  const seen = new Set();
  return specs.filter((spec) => {
    if (!spec?.collection || !spec?.id) return false;
    const key = `${spec.collection}::${spec.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Ejecuta una transacción atómica sobre las colecciones con bloqueo contra ejecuciones simultáneas conflictivas.
// En modo Firebase real utiliza runTransaction() nativo de Firestore (todas las lecturas antes de todas las escrituras).
// Si cualquier validación lanza error o hay fallo de red, ningún cambio se persiste.
export async function runAtomicTransaction(workFn, options = {}) {
  if (isNetworkOffline()) {
    throw new Error("No se pudo guardar la operación por error de red. No se ha confirmado ningún cambio.");
  }

  const lockKey = options.lockKey || "global_tx";
  if (activeLocks.has(lockKey)) {
    throw new Error("Hay otra operación en curso. Espera a que finalice antes de enviar una solicitud simultánea.");
  }

  activeLocks.add(lockKey);
  try {
    ensureSeedData();

    if (!inMemoryTestMode && isFirebaseConfigured()) {
      const txOutput = await ejecutarTransaccionFirestore(async ({ transaction, db, firestoreMod }) => {
        const snapshotBefore = cloneSnapshotFromCache();
        const readSpecs = resolveTxReadDocs(options, snapshotBefore);

        // Todas las lecturas transaccionales en servidor se ejecutan ANTES de cualquier escritura
        const readSet = new Set();
        const readFromServer = async (colName, docId) => {
          const key = `${colName}::${docId}`;
          if (readSet.has(key)) return null;
          readSet.add(key);
          const ref = firestoreMod.doc(db, colName, docId);
          const snap = await transaction.get(ref);
          const list = snapshotBefore[colName] || [];
          const idx = list.findIndex((d) => d.id === docId);
          let serverDoc = null;
          if (snap.exists()) {
            serverDoc = { ...snap.data(), id: snap.id };
            if (idx !== -1) list[idx] = serverDoc;
            else list.push(serverDoc);
          } else if (idx !== -1) {
            list.splice(idx, 1);
          }
          snapshotBefore[colName] = list;
          return serverDoc;
        };

        for (const spec of readSpecs) {
          const serverDoc = await readFromServer(spec.collection, spec.id);
          // Si se leyó control/caja_activa, asegurar lectura transaccional de la caja referenciada
          if (spec.collection === COLLECTIONS.CONTROL && spec.id === "caja_activa" && serverDoc?.cajaId) {
            await readFromServer(COLLECTIONS.CAJAS, serverDoc.cajaId);
          }
        }

        const { tx, getDirtyDocs, getTouchedCollections } = buildTxContext(snapshotBefore);
        const result = await workFn(tx);

        if (isNetworkOffline()) {
          throw new Error("Se perdió la conexión de red antes de confirmar la escritura. No se guardaron cambios.");
        }

        const dirtyDocs = getDirtyDocs();
        for (const op of dirtyDocs) {
          const ref = firestoreMod.doc(db, op.collection, op.id);
          transaction.set(ref, { ...op.data, id: op.id }, { merge: true });
        }

        return {
          result,
          snapshotAfter: snapshotBefore,
          touchedCollections: getTouchedCollections()
        };
      });

      if (txOutput) {
        for (const col of txOutput.touchedCollections) {
          writeCollectionRaw(col, txOutput.snapshotAfter[col]);
        }
        for (const col of txOutput.touchedCollections) {
          notifyListeners(col);
        }
        return txOutput.result;
      }
    }

    // Modo local / pruebas en memoria
    const snapshotBefore = cloneSnapshotFromCache();
    const { tx, getTouchedCollections } = buildTxContext(snapshotBefore);

    const result = await workFn(tx);

    // Verificar nuevamente la conexión antes de confirmar el commit
    if (isNetworkOffline()) {
      throw new Error("Se perdió la conexión de red antes de confirmar la escritura. No se guardaron cambios.");
    }

    const touchedCollections = getTouchedCollections();
    for (const col of touchedCollections) {
      writeCollectionRaw(col, snapshotBefore[col]);
    }

    for (const col of touchedCollections) {
      notifyListeners(col);
    }

    return result;
  } finally {
    activeLocks.delete(lockKey);
  }
}

// ---------------------------------------------------------------------------
// PERFIL TRIBUTARIO DEL NEGOCIO (No responsable de IVA) Y COPIAS DE SEGURIDAD
// ---------------------------------------------------------------------------
export const PERFIL_NEGOCIO_DOC_ID = "perfil_negocio";
export const DEFAULT_PERFIL_NEGOCIO = {
  nombreEstablecimiento: "Vidrios y Aluminios El Carmen",
  tipoPersona: "Persona natural",
  documentoNit: "",
  regimenIva: "No responsable de IVA",
  direccion: "",
  telefono: "",
  ciudad: "",
  topeAnualUvt: 183309000
};

export function obtenerPerfilNegocio() {
  const doc = getDocById(COLLECTIONS.CONTROL, PERFIL_NEGOCIO_DOC_ID);
  return {
    ...DEFAULT_PERFIL_NEGOCIO,
    ...(doc || {}),
    nombreEstablecimiento:
      String(doc?.nombreEstablecimiento || "").trim() || DEFAULT_PERFIL_NEGOCIO.nombreEstablecimiento,
    regimenIva: String(doc?.regimenIva || "").trim() || DEFAULT_PERFIL_NEGOCIO.regimenIva,
    topeAnualUvt:
      Number(doc?.topeAnualUvt) > 0 ? Math.round(Number(doc.topeAnualUvt)) : DEFAULT_PERFIL_NEGOCIO.topeAnualUvt
  };
}

export function watchPerfilNegocio(callback) {
  return subscribeCollection(COLLECTIONS.CONTROL, () => {
    callback(obtenerPerfilNegocio());
  });
}

export async function guardarPerfilNegocio(datos = {}, user = getCurrentUser()) {
  assertPermission("usuarios.gestionar", user);
  const nombreEstablecimiento =
    String(datos.nombreEstablecimiento || "").trim() || DEFAULT_PERFIL_NEGOCIO.nombreEstablecimiento;
  const tipoPersona =
    datos.tipoPersona === "Persona jurídica" ? "Persona jurídica" : "Persona natural";
  const documentoNit = String(datos.documentoNit || "").trim();
  const regimenIva = String(datos.regimenIva || "").trim() || "No responsable de IVA";
  const direccion = String(datos.direccion || "").trim();
  const telefono = String(datos.telefono || "").trim();
  const ciudad = String(datos.ciudad || "").trim();
  const topeNum = Number(datos.topeAnualUvt);
  const topeAnualUvt = Number.isFinite(topeNum) && topeNum > 0 ? Math.round(topeNum) : 183309000;

  return runAtomicTransaction(
    async (tx) => {
      const ahora = new Date().toISOString();
      const actualizado = tx.upsert(COLLECTIONS.CONTROL, PERFIL_NEGOCIO_DOC_ID, {
        nombreEstablecimiento,
        tipoPersona,
        documentoNit,
        regimenIva,
        direccion,
        telefono,
        ciudad,
        topeAnualUvt,
        actualizadoEn: ahora,
        actualizadoPor: user.name || user.email
      });

      tx.insert(COLLECTIONS.AUDITORIA, {
        accion: "NEGOCIO_PERFIL_ACTUALIZADO",
        nombreEstablecimiento,
        documentoNit,
        regimenIva,
        usuario: user.name || user.email,
        fecha: ahora
      });

      return actualizado;
    },
    { readDocs: [{ collection: COLLECTIONS.CONTROL, id: PERFIL_NEGOCIO_DOC_ID }] }
  );
}

const COLECCIONES_RESPALDO = [
  COLLECTIONS.PRODUCTOS,
  COLLECTIONS.CLIENTES,
  COLLECTIONS.CAJAS,
  COLLECTIONS.VENTAS,
  COLLECTIONS.MOV_INVENTARIO,
  COLLECTIONS.MOV_CONTABLES,
  COLLECTIONS.DEVOLUCIONES,
  COLLECTIONS.USUARIOS,
  COLLECTIONS.CONTROL,
  COLLECTIONS.MOV_BILLETERA,
  COLLECTIONS.AUDITORIA
];

export function exportarRespaldoJSON(user = getCurrentUser()) {
  assertPermission("usuarios.gestionar", user);
  ensureSeedData();
  const ahora = new Date().toISOString();
  const colecciones = {};
  const conteos = {};
  let totalRegistros = 0;

  for (const col of COLECCIONES_RESPALDO) {
    const docs = getCollection(col);
    colecciones[col] = docs;
    conteos[col] = docs.length;
    totalRegistros += docs.length;
  }

  const respaldo = {
    version: 1,
    sistema: "Vidrios y Aluminios El Carmen",
    fechaRespaldo: ahora,
    generadoPor: user.name || user.email,
    totalRegistros,
    conteos,
    colecciones
  };

  return {
    ...respaldo,
    filename: `respaldo-el-carmen-${ahora.slice(0, 10)}.json`,
    jsonString: JSON.stringify(respaldo, null, 2)
  };
}

export function validarRespaldoJSON(jsonData) {
  let parsed = jsonData;
  if (typeof jsonData === "string") {
    try {
      parsed = JSON.parse(jsonData);
    } catch {
      throw new Error("El archivo seleccionado no contiene un JSON válido.");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Formato de respaldo inválido: se esperaba un objeto JSON.");
  }
  if (!parsed.colecciones || typeof parsed.colecciones !== "object" || Array.isArray(parsed.colecciones)) {
    throw new Error("El archivo de respaldo no contiene el bloque 'colecciones'.");
  }

  const permitidas = new Set(Object.values(COLLECTIONS));
  const claves = Object.keys(parsed.colecciones);
  if (claves.length === 0) {
    throw new Error("El archivo de respaldo no contiene ninguna colección para restaurar.");
  }

  const conteosPorColeccion = {};
  let totalRegistros = 0;
  for (const col of claves) {
    if (!permitidas.has(col)) {
      throw new Error(`Colección desconocida o corrupta en el respaldo: "${col}".`);
    }
    const lista = parsed.colecciones[col];
    if (!Array.isArray(lista)) {
      throw new Error(`Los registros de la colección "${col}" deben ser un arreglo válido.`);
    }
    for (let i = 0; i < lista.length; i++) {
      const doc = lista[i];
      if (!doc || typeof doc !== "object" || Array.isArray(doc) || !doc.id) {
        throw new Error(`Documento corrupto o sin identificador en "${col}" (posición ${i}).`);
      }
    }
    conteosPorColeccion[col] = lista.length;
    totalRegistros += lista.length;
  }

  return {
    parsed,
    conteosPorColeccion,
    totalRegistros,
    fechaRespaldo: parsed.fechaRespaldo || null
  };
}

export async function restaurarRespaldoJSON(jsonData, user = getCurrentUser()) {
  assertPermission("usuarios.gestionar", user);
  const { parsed, conteosPorColeccion, totalRegistros } = validarRespaldoJSON(jsonData);

  if (!inMemoryTestMode && isFirebaseConfigured()) {
    const ops = [];
    for (const [col, lista] of Object.entries(parsed.colecciones)) {
      for (const doc of lista) {
        ops.push({ collection: col, id: String(doc.id), data: { ...doc, id: String(doc.id) } });
      }
    }
    if (ops.length > 0) {
      await escribirLoteFirestore(ops);
    }
  }

  const ahora = new Date().toISOString();
  const colsTocadas = [];
  for (const [col, lista] of Object.entries(parsed.colecciones)) {
    writeCollectionRaw(col, lista);
    colsTocadas.push(col);
  }

  const auditoriaActual = readCollectionRaw(COLLECTIONS.AUDITORIA) || [];
  const regAud = {
    id: generateId("aud"),
    accion: "RESPALDO_RESTAURADO",
    totalRegistros,
    fechaRespaldoOriginal: parsed.fechaRespaldo || "",
    usuario: user.name || user.email,
    fecha: ahora
  };
  writeCollectionRaw(COLLECTIONS.AUDITORIA, [...auditoriaActual, regAud]);
  if (!colsTocadas.includes(COLLECTIONS.AUDITORIA)) colsTocadas.push(COLLECTIONS.AUDITORIA);

  for (const col of colsTocadas) {
    notifyListeners(col);
  }

  return {
    totalRestaurados: totalRegistros,
    conteosPorColeccion,
    fechaRestauracion: ahora
  };
}
