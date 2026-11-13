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
  METRO_LINEAL: "m",
  METRO_CUADRADO: "m²",
  SIN_UNIDAD: ""
};

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

export function listarProductos({ incluirInactivos = false } = {}) {
  const todos = getCollection(COLLECTIONS.PRODUCTOS);
  return incluirInactivos ? todos : todos.filter((p) => p.activo !== false);
}

export function obtenerProducto(id) {
  return getDocById(COLLECTIONS.PRODUCTOS, id);
}

export function watchProductos(callback, { incluirInactivos = false } = {}) {
  return subscribeCollection(COLLECTIONS.PRODUCTOS, (items) => {
    callback(incluirInactivos ? items : items.filter((p) => p.activo !== false));
  });
}

export function watchMovimientosInventario(callback) {
  return subscribeCollection(COLLECTIONS.MOV_INVENTARIO, (items) => {
    const sorted = [...items].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
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
      String(p.codigo || "").toLowerCase().includes(q);
    return matchCat && matchText;
  });
}

// Valida que la cantidad sea coherente con la unidad de medida del producto
export function validarCantidadPorUnidad(producto, cantidad) {
  const cant = Number(cantidad);
  if (!Number.isFinite(cant) || cant <= 0) {
    throw new Error("La cantidad debe ser un número mayor que cero.");
  }
  const permiteDecimal = Boolean(producto.permiteDecimal || producto.unidad === "m" || producto.unidad === "m²");
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
  if (!["u", "m", "m²", ""].includes(unidad)) {
    throw new Error("La unidad de medida debe ser unidad (u), metro lineal (m), metro cuadrado (m²) o Sin unidad.");
  }
  const permiteDecimal =
    unidad === "m" || unidad === "m²"
      ? true
      : unidad === "u"
        ? false
        : Boolean(datos.permiteDecimal);

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
    const nuevo = tx.insert(COLLECTIONS.PRODUCTOS, {
      codigo: codigo || `PR-${Date.now().toString().slice(-4)}`,
      nombre,
      descripcion,
      categoria,
      unidad,
      permiteDecimal,
      permiteDimensiones: unidad === "m²",
      esPersonalizado: unidad === "m²",
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
    if (!["u", "m", "m²", ""].includes(unidad)) {
      throw new Error("La unidad de medida debe ser unidad (u), metro lineal (m), metro cuadrado (m²) o Sin unidad.");
    }
    const permiteDecimal =
      unidad === "m" || unidad === "m²"
        ? true
        : unidad === "u"
          ? false
          : cambios.permiteDecimal !== undefined
            ? Boolean(cambios.permiteDecimal)
            : Boolean(actual.permiteDecimal);

    if (!(precioCompra >= 0) || !(precio >= 0)) throw new Error("Los precios no pueden ser negativos.");
    if (!(stockMinimo >= 0)) throw new Error("El stock mínimo no puede ser negativo.");

    const existentes = tx.getAll(COLLECTIONS.PRODUCTOS);
    if (existentes.some((p) => p.id !== id && String(p.codigo || "").toUpperCase() === codigo)) {
      throw new Error(`Ya existe otro producto con el código ${codigo}.`);
    }

    const ahora = new Date().toISOString();
    const actualizado = tx.update(COLLECTIONS.PRODUCTOS, id, {
      codigo,
      nombre,
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

  return runAtomicTransaction(async (tx) => {
    const prod = tx.get(COLLECTIONS.PRODUCTOS, productoId);
    if (!prod) throw new Error("Producto no encontrado en inventario.");

    const cantValida = validarCantidadPorUnidad(prod, cantidad);
    const stockActual = roundQty(prod.stock);
    const stockNuevo = roundQty(
      tipo === "Entrada" ? stockActual + cantValida : stockActual - cantValida
    );

    if (stockNuevo < 0) {
      throw new Error(
        `La cantidad solicitada supera las existencias disponibles (${prod.nombre}: disponible ${stockActual} ${prod.unidad}).`
      );
    }

    const ahora = new Date().toISOString();
    tx.update(COLLECTIONS.PRODUCTOS, productoId, {
      stock: stockNuevo,
      actualizadoEn: ahora
    });

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
  });
}
