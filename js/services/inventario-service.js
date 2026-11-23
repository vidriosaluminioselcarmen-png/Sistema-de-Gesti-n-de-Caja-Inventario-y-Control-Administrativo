// Servicio de Inventario (Sección 7): única fuente de verdad para productos, precios de compra y venta,
// unidades de medida (u, m, m²), control de existencias, kardex auditado y alertas de stock.

import {
  COLLECTIONS,
  getCollection,
  getDocById,
  subscribeCollection,
  runAtomicTransaction
} from "./store.js";
import { getCurrentUser, assertPermission } from "../auth.js";

export const UNIDADES_MEDIDA = {
  UNIDAD: "u",
  METRO: "metro",
  METRO_LINEAL: "m",
  METRO_CUADRADO: "m²",
  LAMINA: "lámina",
  KILOGRAMO: "kg",
  LITRO: "L",
  CAJA: "caja",
  PAQUETE: "paquete",
  SERVICIO: "servicio",
  SIN_UNIDAD: ""
};

export const UNIDADES_PERMITIDAS = Object.values(UNIDADES_MEDIDA);
const UNIDADES_DECIMALES = new Set(["m", "metro", "m²", "kg", "L"]);

export const MODALIDADES_INVENTARIO = {
  UNIDADES: "unidades",
  METROS_CUADRADOS: "m2",
  METROS_LINEALES: "m"
};

export function inferirModalidadProducto(prod = {}) {
  const mod = String(prod.modalidad || "").trim().toLowerCase();
  if (mod === "m2" || mod === "m²") return MODALIDADES_INVENTARIO.METROS_CUADRADOS;
  if (mod === "m") return MODALIDADES_INVENTARIO.METROS_LINEALES;
  if (mod === "unidades" || mod === "u") return MODALIDADES_INVENTARIO.UNIDADES;
  const u = String(prod.unidad || "").trim();
  if (u === "m²") return MODALIDADES_INVENTARIO.METROS_CUADRADOS;
  if (u === "m" || u === "metro") return MODALIDADES_INVENTARIO.METROS_LINEALES;
  return MODALIDADES_INVENTARIO.UNIDADES;
}

export function etiquetaModalidad(modalidad) {
  if (modalidad === MODALIDADES_INVENTARIO.METROS_CUADRADOS) return "Metros cuadrados (m²)";
  if (modalidad === MODALIDADES_INVENTARIO.METROS_LINEALES) return "Metros lineales (m)";
  return "Unidades";
}

export function calcularAreaLaminas({ ancho, alto, laminas = 1 }) {
  const a = Number(ancho);
  const h = Number(alto);
  const n = Number(laminas);
  if (!Number.isFinite(a) || a <= 0) throw new Error("El ancho debe ser mayor que cero.");
  if (!Number.isFinite(h) || h <= 0) throw new Error("El alto debe ser mayor que cero.");
  if (!Number.isFinite(n) || n <= 0) throw new Error("La cantidad de láminas debe ser mayor que cero.");
  return roundQty(a * h * n);
}

function resolverPermiteDecimal(unidad, permiteDecimalExplicit) {
  if (UNIDADES_DECIMALES.has(unidad)) return true;
  if (unidad === "u") return false;
  return Boolean(permiteDecimalExplicit);
}

export function normalizarUnidadProducto(unidad) {
  if (unidad === undefined || unidad === null) return null;
  const val = String(unidad).trim();
  if (val === "" || val.toLowerCase() === "sin unidad" || val.toLowerCase() === "n/a") {
    return "";
  }
  return val;
}

export const CATEGORIAS_PRODUCTO = [
  "Todos",
  "Vidrios",
  "Perfiles",
  "Accesorios",
  "Insumos"
];

export const ORIGENES_MOVIMIENTO_INVENTARIO = [
  "Entrada por compra",
  "Ajuste autorizado",
  "Pérdida o daño",
  "Corrección justificada",
  "Uso interno en obra"
];

// Redondea cantidades decimales (m, m²) a 4 decimales para evitar errores de punto flotante
export function roundQty(num) {
  return Math.round((Number(num) + Number.EPSILON) * 10000) / 10000;
}

// Redondea valores monetarios en COP a pesos enteros
export function roundCOP(num) {
  return Math.round(Number(num) || 0);
}

// Formatea número como pesos colombianos: "$ 206.000"
export function formatCOP(value) {
  const n = roundCOP(value);
  const sign = n < 0 ? "− " : "";
  return `${sign}$ ${Math.abs(n).toLocaleString("es-CO")}`;
}

// Calcula área por pieza, área total, precio del material y precio final para vidrios/espejos por dimensiones.
// Soporta unidadDimension en metros ("m") o centímetros ("cm").
export function calcularVidrioPersonalizado({
  ancho,
  largo,
  unidadDimension = "m",
  piezas = 1,
  precioM2 = 0,
  costosAdicionales = 0,
  conceptoAdicional = ""
}) {
  const w = Number(ancho);
  const l = Number(largo);
  const pzs = Number(piezas);
  const precio = Number(precioM2);
  const adicionales = Number(costosAdicionales || 0);

  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(l) || l <= 0) {
    throw new Error("Las dimensiones (ancho y largo) deben ser números mayores que cero.");
  }
  if (!Number.isInteger(pzs) || pzs <= 0) {
    throw new Error("La cantidad de piezas debe ser un número entero mayor que cero.");
  }
  if (!["m", "cm"].includes(unidadDimension)) {
    throw new Error("La unidad de las dimensiones debe ser metros (m) o centímetros (cm).");
  }
  if (!Number.isFinite(precio) || precio < 0) {
    throw new Error("El precio por metro cuadrado no puede ser negativo.");
  }
  if (!Number.isFinite(adicionales) || adicionales < 0) {
    throw new Error("Los costos adicionales no pueden ser negativos.");
  }

  const factor = unidadDimension === "cm" ? 0.01 : 1;
  const anchoM = roundQty(w * factor);
  const largoM = roundQty(l * factor);
  const areaPorPieza = roundQty(anchoM * largoM);
  const areaTotal = roundQty(areaPorPieza * pzs);

  if (!(areaTotal > 0)) {
    throw new Error("El área calculada debe ser mayor que cero.");
  }

  const precioM2Aplicado = roundCOP(precio);
  const precioMaterial = roundCOP(areaTotal * precioM2Aplicado);
  const costosAdicAplicados = roundCOP(adicionales);
  const precioFinalLinea = roundCOP(precioMaterial + costosAdicAplicados);

  return {
    ancho: w,
    largo: l,
    unidadDimension,
    anchoM,
    largoM,
    piezas: pzs,
    areaPorPieza,
    areaTotal,
    precioM2: precioM2Aplicado,
    precioMaterial,
    costosAdicionales: costosAdicAplicados,
    conceptoAdicional: String(conceptoAdicional || "").trim(),
    precioFinalLinea
  };
}

// Compatibilidad con llamadas que pasen anchoCm y altoCm
export function calcularAreaM2({ anchoCm, altoCm, largoCm, piezas = 1 }) {
  const res = calcularVidrioPersonalizado({
    ancho: anchoCm,
    largo: largoCm ?? altoCm,
    unidadDimension: "cm",
    piezas,
    precioM2: 0
  });
  return res.areaTotal;
}

export function getEstadoStock(producto) {
  if (producto.activo === false) {
    return {
      codigo: "inactivo",
      etiqueta: "Inactivo",
      claseBadge: "badge-danger",
      claseFila: ""
    };
  }
  const stock = Number(producto.stock) || 0;
  const min = Number(producto.stockMinimo) || 0;
  if (stock < 0) {
    return {
      codigo: "inconsistente",
      etiqueta: "Inconsistencia",
      claseBadge: "stock-out",
      claseFila: "row-out"
    };
  }
  if (stock === 0) {
    return {
      codigo: "agotado",
      etiqueta: "Agotado",
      claseBadge: "stock-out",
      claseFila: "row-out"
    };
  }
  if (stock <= min) {
    return {
      codigo: "bajo",
      etiqueta: "Stock bajo",
      claseBadge: "stock-low",
      claseFila: "row-low"
    };
  }
  return {
    codigo: "disponible",
    etiqueta: "Disponible",
    claseBadge: "stock-ok",
    claseFila: ""
  };
}

export function obtenerAlertasInventario(productos = listarProductos({ incluirInactivos: false })) {
  const activos = productos.filter((p) => p.activo !== false);
  const agotados = activos.filter((p) => Number(p.stock) === 0);
  const stockBajo = activos.filter((p) => Number(p.stock) > 0 && Number(p.stock) <= Number(p.stockMinimo || 0));
  const inconsistentes = activos.filter((p) => Number(p.stock) < 0);
  return {
    agotados,
    stockBajo,
    inconsistentes,
    criticos: [...inconsistentes, ...agotados, ...stockBajo]
  };
}

// Resumen único del inventario para tarjetas y gráficos (sin cálculos duplicados).
// Usa exclusivamente los productos y movimientos reales recibidos; si no hay datos, devuelve listas vacías.
export function calcularResumenInventario(
  productos = [],
  movimientos = [],
  { desde = "", hasta = "", categoria = "Todos" } = {}
) {
  const prodsFiltrados = productos.filter(
    (p) => !categoria || categoria === "Todos" || p.categoria === categoria
  );
  const idsFiltrados = new Set(prodsFiltrados.map((p) => p.id));

  const conteo = { total: 0, disponibles: 0, stockBajo: 0, agotados: 0, inactivos: 0, inconsistentes: 0 };
  const porCategoriaMap = new Map();

  for (const p of prodsFiltrados) {
    const est = getEstadoStock(p);
    if (est.codigo === "inactivo") {
      conteo.inactivos += 1;
      continue;
    }
    conteo.total += 1;
    if (est.codigo === "disponible") conteo.disponibles += 1;
    else if (est.codigo === "bajo") conteo.stockBajo += 1;
    else if (est.codigo === "agotado") conteo.agotados += 1;
    else if (est.codigo === "inconsistente") conteo.inconsistentes += 1;

    const cat = p.categoria || "Sin categoría";
    const prev = porCategoriaMap.get(cat) || { categoria: cat, productos: 0, disponibles: 0, stockBajo: 0, agotados: 0 };
    prev.productos += 1;
    if (est.codigo === "disponible") prev.disponibles += 1;
    else if (est.codigo === "bajo") prev.stockBajo += 1;
    else if (est.codigo === "agotado") prev.agotados += 1;
    porCategoriaMap.set(cat, prev);
  }

  const desdeKey = desde ? String(desde).slice(0, 10) : "";
  const hastaKey = hasta ? String(hasta).slice(0, 10) : "";
  const movsFiltrados = movimientos.filter((m) => {
    if (!idsFiltrados.has(m.productoId)) return false;
    const dia = String(m.fecha || "").slice(0, 10);
    if (!dia) return false;
    if (desdeKey && dia < desdeKey) return false;
    if (hastaKey && dia > hastaKey) return false;
    return true;
  });

  // Entradas y salidas: se cuentan movimientos (no se suman cantidades de unidades distintas: u, m², m).
  const porDiaMap = new Map();
  let totalEntradas = 0;
  let totalSalidas = 0;
  for (const m of movsFiltrados) {
    const dia = String(m.fecha).slice(0, 10);
    const reg = porDiaMap.get(dia) || { dia, entradas: 0, salidas: 0 };
    if (m.tipo === "Entrada") {
      reg.entradas += 1;
      totalEntradas += 1;
    } else if (m.tipo === "Salida") {
      reg.salidas += 1;
      totalSalidas += 1;
    }
    porDiaMap.set(dia, reg);
  }
  const entradasSalidasPorDia = [...porDiaMap.values()].sort((a, b) => a.dia.localeCompare(b.dia));

  // Evolución de existencias por unidad de medida (no se mezclan unidades).
  // Se reconstruye con stockNuevo real de todos los movimientos del producto y solo se grafican
  // los días dentro del rango. El último punto coincide con las existencias actuales.
  const activosFiltrados = prodsFiltrados.filter((p) => p.activo !== false);
  const idsActivos = new Set(activosFiltrados.map((p) => p.id));
  const movsActivosOrdenados = movimientos
    .filter((m) => idsActivos.has(m.productoId) && m.fecha && m.stockNuevo !== undefined && m.stockNuevo !== null)
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  const conMovimientos = new Set(movsActivosOrdenados.map((m) => m.productoId));
  const unidadDe = new Map(activosFiltrados.map((p) => [p.id, p.unidad || "sin unidad"]));

  const estadoPorProducto = new Map();
  for (const p of activosFiltrados) {
    if (!conMovimientos.has(p.id)) estadoPorProducto.set(p.id, Number(p.stock) || 0);
  }

  const seriesMap = new Map();
  const sumarUnidad = (unidad) => {
    let suma = 0;
    for (const [pid, val] of estadoPorProducto) {
      if (unidadDe.get(pid) === unidad) suma += val;
    }
    return roundQty(suma);
  };
  for (const m of movsActivosOrdenados) {
    estadoPorProducto.set(m.productoId, Number(m.stockNuevo) || 0);
    const dia = String(m.fecha).slice(0, 10);
    if (desdeKey && dia < desdeKey) continue;
    if (hastaKey && dia > hastaKey) continue;
    const unidad = unidadDe.get(m.productoId);
    if (!seriesMap.has(unidad)) seriesMap.set(unidad, new Map());
    seriesMap.get(unidad).set(dia, sumarUnidad(unidad));
  }
  const evolucionExistencias = [...seriesMap.entries()].map(([unidad, puntos]) => ({
    unidad,
    puntos: [...puntos.entries()].map(([dia, existencias]) => ({ dia, existencias }))
  }));

  return {
    conteo,
    distribucionEstados: [
      { codigo: "disponible", etiqueta: "Disponible", valor: conteo.disponibles },
      { codigo: "bajo", etiqueta: "Stock bajo", valor: conteo.stockBajo },
      { codigo: "agotado", etiqueta: "Agotado", valor: conteo.agotados },
      { codigo: "inactivo", etiqueta: "Inactivo", valor: conteo.inactivos }
    ],
    porCategoria: [...porCategoriaMap.values()].sort((a, b) => b.productos - a.productos),
    entradasSalidasPorDia,
    evolucionExistencias,
    totalMovimientos: movsFiltrados.length,
    totalEntradas,
    totalSalidas,
    sinProductos: prodsFiltrados.length === 0,
    sinMovimientos: movsFiltrados.length === 0
  };
}

export function ordenarMasRecientesPrimero(
  lista,
  camposFecha = ["creadoEn", "fechaCreacion", "actualizadoEn", "fecha"],
  desempate = null
) {
  const obtenerValorFecha = (item) => {
    for (const campo of camposFecha) {
      const val = item?.[campo];
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        return String(val).trim();
      }
    }
    return "";
  };

  return [...(Array.isArray(lista) ? lista : [])].sort((a, b) => {
    const aFecha = obtenerValorFecha(a);
    const bFecha = obtenerValorFecha(b);
    if (!aFecha && !bFecha) return desempate ? desempate(a, b) : 0;
    if (!aFecha) return 1;
    if (!bFecha) return -1;

    const ta = Date.parse(aFecha);
    const tb = Date.parse(bFecha);
    if (Number.isFinite(ta) && Number.isFinite(tb) && tb !== ta) {
      return tb - ta;
    }
    const cmpStr = bFecha.localeCompare(aFecha);
    if (cmpStr !== 0) return cmpStr;

    return desempate ? desempate(a, b) : String(b?.id || "").localeCompare(String(a?.id || ""));
  });
}

function desempateMovimientosKardex(a, b) {
  if (a?.productoId && a.productoId === b?.productoId) {
    if (b.stockAnterior === a.stockNuevo) return -1;
    if (a.stockAnterior === b.stockNuevo) return 1;
  }
  return String(b?.id || "").localeCompare(String(a?.id || ""));
}

export function listarProductos({ incluirInactivos = false } = {}) {
  const todos = ordenarMasRecientesPrimero(
    getCollection(COLLECTIONS.PRODUCTOS),
    ["creadoEn", "fechaCreacion", "actualizadoEn"]
  );
  return incluirInactivos ? todos : todos.filter((p) => p.activo !== false);
}

export function obtenerProducto(id) {
  return getDocById(COLLECTIONS.PRODUCTOS, id);
}

export function watchProductos(callback, { incluirInactivos = false } = {}) {
  return subscribeCollection(COLLECTIONS.PRODUCTOS, (items) => {
    const ordenados = ordenarMasRecientesPrimero(items, ["creadoEn", "fechaCreacion", "actualizadoEn"]);
    callback(incluirInactivos ? ordenados : ordenados.filter((p) => p.activo !== false));
  });
}

export function watchMovimientosInventario(callback) {
  return subscribeCollection(COLLECTIONS.MOV_INVENTARIO, (items) => {
    const sorted = ordenarMasRecientesPrimero(items, ["fecha"], desempateMovimientosKardex);
    callback(sorted);
  });
}

// Filtra productos por categoría y término de búsqueda (nombre o código)
export function filtrarCatalogo(productos, { categoria = "Todos", busqueda = "" } = {}) {
  const q = String(busqueda || "").trim().toLowerCase();
  return productos.filter((p) => {
    const matchCat = !categoria || categoria === "Todos" || p.categoria === categoria;
    const matchText =
      !q ||
      String(p.nombre || "").toLowerCase().includes(q) ||
      String(p.codigo || "").toLowerCase().includes(q) ||
      String(p.referencia || "").toLowerCase().includes(q) ||
      String(p.codigoBarras || "").toLowerCase().includes(q);
    return matchCat && matchText;
  });
}

// Valida que la cantidad sea coherente con la unidad de medida del producto
export function validarCantidadPorUnidad(producto, cantidad) {
  const cant = Number(cantidad);
  if (!Number.isFinite(cant) || cant <= 0) {
    throw new Error("La cantidad debe ser un número mayor que cero.");
  }
  const permiteDecimal = Boolean(producto.permiteDecimal || UNIDADES_DECIMALES.has(producto.unidad));
  if (!permiteDecimal && !Number.isInteger(cant)) {
    const sufijo = producto.unidad ? ` (${producto.unidad})` : "";
    throw new Error(`El producto "${producto.nombre}" se vende por unidades enteras${sufijo}.`);
  }
  return roundQty(cant);
}

export async function crearProducto(datos, user = getCurrentUser()) {
  assertPermission("inventario.gestionar", user);
  const nombre = String(datos.nombre || "").trim();
  const descripcion = String(datos.descripcion || "").trim();
  const codigo = String(datos.codigo || "").trim().toUpperCase();
  const categoria = datos.categoria || "Vidrios";
  const unidadNormalizada = normalizarUnidadProducto(datos.unidad);
  const unidad =
    unidadNormalizada !== null
      ? unidadNormalizada
      : categoria === "Vidrios"
        ? "m²"
        : categoria === "Perfiles"
          ? "m"
          : "u";
  const precioCompra = roundCOP(datos.precioCompra ?? 0);
  const precio = roundCOP(datos.precio);
  const stock = roundQty(datos.stock ?? 0);
  const stockMinimo = roundQty(datos.stockMinimo ?? 0);

  if (!nombre) throw new Error("El nombre del producto es obligatorio.");
  if (!UNIDADES_PERMITIDAS.includes(unidad)) {
    throw new Error("Unidad de medida no válida para el catálogo.");
  }
  const permiteDecimal = resolverPermiteDecimal(unidad, datos.permiteDecimal);

  if (!(precioCompra >= 0)) throw new Error("El precio de compra no puede ser negativo.");
  if (!(precio >= 0)) throw new Error("El precio de venta debe ser un valor numérico no negativo.");
  if (!(stock >= 0) || !(stockMinimo >= 0)) throw new Error("Las existencias no pueden ser negativas.");
  if (!permiteDecimal && (!Number.isInteger(stock) || !Number.isInteger(stockMinimo))) {
    throw new Error("Para productos con cantidades enteras, el stock inicial y el mínimo deben ser números enteros.");
  }

  return runAtomicTransaction(async (tx) => {
    const existentes = tx.getAll(COLLECTIONS.PRODUCTOS);
    if (codigo && existentes.some((p) => String(p.codigo || "").toUpperCase() === codigo)) {
      throw new Error(`Ya existe un producto con el código ${codigo}.`);
    }
    const ahora = new Date().toISOString();
    const modalidad = datos.modalidad
      ? inferirModalidadProducto({ modalidad: datos.modalidad, unidad })
      : inferirModalidadProducto({ unidad });
    const nuevo = tx.insert(COLLECTIONS.PRODUCTOS, {
      codigo: codigo || `PR-${Date.now().toString().slice(-4)}`,
      nombre,
      descripcion,
      categoria,
      modalidad,
      unidad,
      permiteDecimal,
      permiteDimensiones: modalidad === MODALIDADES_INVENTARIO.METROS_CUADRADOS || unidad === "m²",
      esPersonalizado: modalidad === MODALIDADES_INVENTARIO.METROS_CUADRADRADOS || unidad === "m²",
      precioCompra,
      precio,
      stock,
      stockMinimo,
      activo: true,
      creadoPor: user.name || user.email,
      creadoEn: ahora,
      actualizadoEn: ahora
    });

    if (stock > 0) {
      tx.insert(COLLECTIONS.MOV_INVENTARIO, {
        productoId: nuevo.id,
        codigo: nuevo.codigo,
        productoNombre: nuevo.nombre,
        unidad: nuevo.unidad,
        tipo: "Entrada",
        origen: "Stock inicial",
        cantidad: stock,
        stockAnterior: 0,
        stockNuevo: stock,
        motivo: "Inventario inicial al crear producto",
        usuario: user.name || user.email,
        fecha: ahora
      });
    }

    tx.insert(COLLECTIONS.AUDITORIA, {
      accion: "PRODUCTO_CREACION",
      productoId: nuevo.id,
      codigo: nuevo.codigo,
      nombre: nuevo.nombre,
      precioCompra,
      precioVenta: precio,
      stockInicial: stock,
      usuario: user.name || user.email,
      fecha: ahora
    });

    return nuevo;
  });
}

// Edita los datos maestros de un producto.
// Regla 7.2: NO permite modificar directamente las existencias (stock) sin registrar un movimiento de inventario.
export async function actualizarProducto(id, cambios, user = getCurrentUser()) {
  assertPermission("inventario.gestionar", user);
  if (!id) throw new Error("Identificador de producto requerido.");

  return runAtomicTransaction(async (tx) => {
    const actual = tx.get(COLLECTIONS.PRODUCTOS, id);
    if (!actual) throw new Error("Producto no encontrado.");

    const nombre = cambios.nombre !== undefined ? String(cambios.nombre).trim() : actual.nombre;
    const descripcion = cambios.descripcion !== undefined ? String(cambios.descripcion).trim() : (actual.descripcion || "");
    const codigo = cambios.codigo !== undefined ? String(cambios.codigo).trim().toUpperCase() : actual.codigo;
    const categoria = cambios.categoria !== undefined ? cambios.categoria : actual.categoria;
    const unidadNorm = cambios.unidad !== undefined ? normalizarUnidadProducto(cambios.unidad) : (actual.unidad ?? "");
    const unidad = unidadNorm !== null ? unidadNorm : (actual.unidad ?? "");
    const precioCompra = cambios.precioCompra !== undefined ? roundCOP(cambios.precioCompra) : roundCOP(actual.precioCompra || 0);
    const precio = cambios.precio !== undefined ? roundCOP(cambios.precio) : roundCOP(actual.precio);
    const stockMinimo = cambios.stockMinimo !== undefined ? roundQty(cambios.stockMinimo) : roundQty(actual.stockMinimo);
    const activo = cambios.activo !== undefined ? Boolean(cambios.activo) : Boolean(actual.activo !== false);

    if (!nombre) throw new Error("El nombre del producto es obligatorio.");
    if (!codigo) throw new Error("El código del producto es obligatorio.");
    if (!UNIDADES_PERMITIDAS.includes(unidad)) {
      throw new Error("Unidad de medida no válida para el catálogo.");
    }
    const permiteDecimal = resolverPermiteDecimal(
      unidad,
      cambios.permiteDecimal !== undefined ? cambios.permiteDecimal : actual.permiteDecimal
    );

    if (!(precioCompra >= 0) || !(precio >= 0)) throw new Error("Los precios no pueden ser negativos.");
    if (!(stockMinimo >= 0)) throw new Error("El stock mínimo no puede ser negativo.");

    const existentes = tx.getAll(COLLECTIONS.PRODUCTOS);
    if (existentes.some((p) => p.id !== id && String(p.codigo || "").toUpperCase() === codigo)) {
      throw new Error(`Ya existe otro producto con el código ${codigo}.`);
    }

    const modalidadActual = inferirModalidadProducto(actual);
    const modalidadNueva = cambios.modalidad !== undefined
      ? inferirModalidadProducto({ modalidad: cambios.modalidad, unidad })
      : cambios.unidad !== undefined
        ? inferirModalidadProducto({ unidad })
        : modalidadActual;

    if (modalidadNueva !== modalidadActual) {
      const tieneMovs = tx.getAll(COLLECTIONS.MOV_INVENTARIO).some((m) => m.productoId === id);
      if (tieneMovs) {
        throw new Error(
          "No se puede cambiar la modalidad de un producto que ya tiene movimientos registrados sin un procedimiento de conversión."
        );
      }
    }

    const ahora = new Date().toISOString();
    const actualizado = tx.update(COLLECTIONS.PRODUCTOS, id, {
      codigo,
      nombre,
      descripcion,
      categoria,
      modalidad: modalidadNueva,
      unidad,
      permiteDecimal,
      permiteDimensiones: modalidadNueva === MODALIDADES_INVENTARIO.METROS_CUADRADOS || unidad === "m²",
      esPersonalizado: modalidadNueva === MODALIDADES_INVENTARIO.METROS_CUADRADRADOS || unidad === "m²",
      descripcion,
      categoria,
      unidad,
      permiteDecimal,
      permiteDimensiones: unidad === "m²",
      esPersonalizado: unidad === "m²",
      precioCompra,
      precio,
      stockMinimo,
      activo,
      actualizadoPor: user.name || user.email,
      actualizadoEn: ahora
    });

    tx.insert(COLLECTIONS.AUDITORIA, {
      accion: "PRODUCTO_ACTUALIZACION",
      productoId: id,
      codigo,
      nombre,
      precioCompra,
      precioVenta: precio,
      activo,
      usuario: user.name || user.email,
      fecha: ahora
    });

    return actualizado;
  });
}

export async function cambiarEstadoProducto(id, activo, user = getCurrentUser()) {
  assertPermission("inventario.gestionar", user);
  return actualizarProducto(id, { activo: Boolean(activo) }, user);
}

// Registra un movimiento de inventario (Entrada por compras, Ajuste autorizado, Pérdida/daño, Corrección).
// Si es una Entrada por compra y se indica registrarGastoCompra: true, genera simultáneamente el gasto en Contabilidad.
export async function registrarMovimientoBodega(
  {
    productoId,
    tipo,
    origen = null,
    cantidad,
    ancho = null,
    alto = null,
    laminas = 1,
    proveedor = "",
    precioCompra = null,
    fecha = null,
    motivo,
    registrarGastoCompra = false,
    costoTotalCompra = null,
    metodoPagoCompra = "Efectivo",
    afectaCajaAbierta = false
  },
  user = getCurrentUser()
) {
  assertPermission("inventario.gestionar", user);
  if (!["Entrada", "Salida"].includes(tipo)) {
    throw new Error("El tipo de movimiento debe ser Entrada o Salida.");
  }

  const motivoLimpio = String(motivo || "").trim();
  const origenMovimiento =
    origen || (tipo === "Entrada" ? "Entrada por compra" : "Ajuste autorizado");

  if (!motivoLimpio) {
    throw new Error("Debes indicar el motivo o soporte del movimiento de inventario.");
  }

  return runAtomicTransaction(
    async (tx) => {
      const prod = tx.get(COLLECTIONS.PRODUCTOS, productoId);
    if (!prod) throw new Error("Producto no encontrado en inventario.");

    const cantidadCalculada =
      (cantidad === undefined || cantidad === null || cantidad === "") && ancho && alto
        ? calcularAreaLaminas({ ancho, alto, laminas })
        : cantidad;
    const cantValida = validarCantidadPorUnidad(prod, cantidadCalculada);
    const stockActual = roundQty(prod.stock);
    const stockNuevo = roundQty(
      tipo === "Entrada" ? stockActual + cantValida : stockActual - cantValida
    );

    if (stockNuevo < 0) {
      throw new Error(
        `La cantidad solicitada supera las existencias disponibles (${prod.nombre}: disponible ${stockActual} ${prod.unidad}).`
      );
    }

    const nowDate = new Date();
    const hoyLocal = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}-${String(nowDate.getDate()).padStart(2, "0")}`;
    let ahora;
    if (!fecha) {
      ahora = nowDate.toISOString();
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(fecha).trim())) {
      const fStr = String(fecha).trim();
      if (fStr === hoyLocal || fStr === nowDate.toISOString().slice(0, 10)) {
        ahora = nowDate.toISOString();
      } else {
        const [yy, mm, dd] = fStr.split("-").map(Number);
        const combinada = new Date(
          yy,
          mm - 1,
          dd,
          nowDate.getHours(),
          nowDate.getMinutes(),
          nowDate.getSeconds(),
          nowDate.getMilliseconds()
        );
        ahora = combinada.toISOString();
      }
    } else {
      ahora = new Date(fecha).toISOString();
    }
    const precioCompraNum =
      tipo === "Entrada" && precioCompra !== null && precioCompra !== "" && Number(precioCompra) >= 0
        ? roundCOP(precioCompra)
        : null;
    const costoTotalNum =
      tipo === "Entrada" && costoTotalCompra !== null && costoTotalCompra !== "" && Number(costoTotalCompra) >= 0
        ? roundCOP(costoTotalCompra)
        : precioCompraNum !== null
          ? roundCOP(precioCompraNum * cantValida)
          : null;
    const updateProd = {
      stock: stockNuevo,
      actualizadoEn: new Date().toISOString()
    };
    if (precioCompraNum !== null) {
      updateProd.precioCompra = precioCompraNum;
    }
    tx.update(COLLECTIONS.PRODUCTOS, productoId, updateProd);

    const movInv = tx.insert(COLLECTIONS.MOV_INVENTARIO, {
      productoId: prod.id,
      codigo: prod.codigo,
      productoNombre: prod.nombre,
      unidad: prod.unidad,
      tipo,
      origen: origenMovimiento,
      cantidad: cantValida,
      stockAnterior: stockActual,
      stockNuevo,
      ...(precioCompraNum !== null ? { precioCompra: precioCompraNum } : {}),
      ...(costoTotalNum !== null ? { costoTotal: costoTotalNum } : {}),
      proveedor: String(proveedor || "").trim(),
      motivo: motivoLimpio,
      usuario: user.name || user.email,
      fecha: ahora
    });

    // Integración entre módulos (Sección 13): si es una Entrada por compra con pago registrado,
    // generar el movimiento de Gasto en Contabilidad (y reflejarlo en caja si se pagó con efectivo de caja).
    if (tipo === "Entrada" && registrarGastoCompra) {
      const montoCompra =
        costoTotalCompra !== null && costoTotalCompra !== ""
          ? roundCOP(costoTotalCompra)
          : roundCOP((prod.precioCompra || 0) * cantValida);

      if (montoCompra > 0) {
        let cajaIdAfectada = null;
        if (afectaCajaAbierta && metodoPagoCompra === "Efectivo") {
          const cajaAbierta = tx
            .getAll(COLLECTIONS.CAJAS)
            .find((c) => c.estado === "Abierta");
          if (!cajaAbierta) {
            throw new Error("No hay una caja abierta para descontar el pago en efectivo de esta compra.");
          }
          cajaIdAfectada = cajaAbierta.id;
          const movCaja = {
            id: `mc-${Date.now()}`,
            tipo: "Salida",
            monto: montoCompra,
            concepto: `Compra inventario: ${prod.nombre} (${cantValida} ${prod.unidad})`,
            usuario: user.name || user.email,
            fecha: ahora
          };
          const listaExtra = Array.isArray(cajaAbierta.movimientosEfectivoExtra)
            ? [...cajaAbierta.movimientosEfectivoExtra, movCaja]
            : [movCaja];
          tx.update(COLLECTIONS.CAJAS, cajaAbierta.id, {
            movimientosEfectivoExtra: listaExtra
          });
        }

        tx.insert(COLLECTIONS.MOV_CONTABLES, {
          tipo: "Gasto",
          categoria: "Compra de mercancía",
          concepto: `Compra ${prod.nombre} (${cantValida} ${prod.unidad}) · ${motivoLimpio}`,
          monto: montoCompra,
          metodoPago: metodoPagoCompra,
          afectaCajaFisica: Boolean(cajaIdAfectada),
          cajaId: cajaIdAfectada,
          origen: "Compra de inventario",
          referenciaId: movInv.id,
          nota: motivoLimpio,
          usuario: user.name || user.email,
          fecha: ahora
        });
      }
    }

    tx.insert(COLLECTIONS.AUDITORIA, {
      accion: "INVENTARIO_MOVIMIENTO",
      movimientoId: movInv.id,
      productoId: prod.id,
      codigo: prod.codigo,
      tipo,
      origen: origenMovimiento,
      cantidad: cantValida,
      stockAnterior: stockActual,
      stockNuevo,
      motivo: motivoLimpio,
      usuario: user.name || user.email,
      fecha: ahora
    });

      return movInv;
    },
    {
      lockKey: `inv_${productoId}`,
      readDocs: [
        { collection: COLLECTIONS.PRODUCTOS, id: productoId },
        { collection: COLLECTIONS.CONTROL, id: "caja_activa" }
      ]
    }
  );
}
