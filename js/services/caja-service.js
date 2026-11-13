// Servicio de Caja y Ventas — Vidrios y Aluminios El Carmen.
// Implementa el proceso comercial completo:
// - Apertura de caja (sin contabilizar la base como ingreso por ventas)
// - Cálculo de líneas, subtotales, descuentos autorizados, impuestos y total
// - Pagos simples y divididos (Efectivo, Transferencia, Tarjeta débito, Tarjeta crédito)
// - Registro transaccional atómico (venta + descuento de stock + kardex + contabilidad + caja)
// - Protección de idempotencia contra doble clic / reintentos
// - Anulaciones y devoluciones con autorización de Administrador y auditoría
// - Arqueo y cierre de caja (Efectivo esperado = base + entradas efectivo - salidas efectivo)

import {
  COLLECTIONS,
  getCollection,
  getDocById,
  subscribeCollection,
  runAtomicTransaction
} from "./store.js";
import { getCurrentUser, assertPermission, hasPermission } from "../auth.js";
import {
  roundQty,
  roundCOP,
  validarCantidadPorUnidad,
  calcularVidrioPersonalizado
} from "./inventario-service.js";
import { TIPOS_CONTABLE } from "./contabilidad-service.js";

export const METODOS_PAGO = [
  "Efectivo",
  "Transferencia",
  "Tarjeta débito",
  "Tarjeta crédito"
];

export const ESTADOS_CAJA = {
  ABIERTA: "Abierta",
  CERRADA: "Cerrada"
};

export const ESTADOS_VENTA = {
  COMPLETADA: "Completada",
  ANULADA: "Anulada",
  DEVUELTA: "Devuelta"
};

// Conjunto de claves de idempotencia en vuelo o procesadas recientemente
const processedIdempotencyKeys = new Set();
let lineIdCounter = 1;

export function generarLineId() {
  const rand = Math.random().toString(36).slice(2, 6);
  return `line-${Date.now()}-${lineIdCounter++}-${rand}`;
}

function normalizarIdOperacion(prefijo, idempotencyKey) {
  const safe = String(idempotencyKey || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${prefijo}_${safe}`.slice(0, 120);
}

// Calcula el siguiente consecutivo de venta (V-0001) tomando el mayor número existente,
// sin reutilizar números de ventas anuladas ni depender de ventasExistentes.length.
export function obtenerSiguienteNumeroVenta(ventasExistentes = []) {
  let maxNumero = 0;
  for (const v of ventasExistentes) {
    const match = String(v.numero || "").match(/^V-(\d+)$/i);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (Number.isFinite(num) && num > maxNumero) {
        maxNumero = num;
      }
    }
  }
  return `V-${String(maxNumero + 1).padStart(4, "0")}`;
}

// Reserva e incrementa atómicamente el consecutivo en control/consecutivo_ventas dentro de la misma transacción.
// Si la transacción falla o se aborta, el contador no avanza ni se desperdicia un número.
function obtenerYReservarConsecutivoVenta(tx, ventasExistentes = [], ahora = new Date().toISOString()) {
  const controlDoc = tx.get(COLLECTIONS.CONTROL, "consecutivo_ventas");
  let baseActual = Number.isFinite(Number(controlDoc?.ultimoNumero))
    ? Number(controlDoc.ultimoNumero)
    : 0;

  for (const v of ventasExistentes) {
    const match = String(v.numero || "").match(/^V-(\d+)$/i);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (Number.isFinite(num) && num > baseActual) {
        baseActual = num;
      }
    }
  }

  const siguiente = baseActual + 1;
  const numeroFormateado = `V-${String(siguiente).padStart(4, "0")}`;
  tx.upsert(COLLECTIONS.CONTROL, "consecutivo_ventas", {
    ultimoNumero: siguiente,
    ultimoNumeroFormateado: numeroFormateado,
    actualizadoEn: ahora
  });
  return numeroFormateado;
}

// Obtiene la caja actualmente abierta (solo se permite 1 caja abierta activa en el punto de venta)
export function obtenerCajaAbierta() {
  const cajas = getCollection(COLLECTIONS.CAJAS);
  return cajas.find((c) => c.estado === ESTADOS_CAJA.ABIERTA) || null;
}

export function watchCajas(callback) {
  return subscribeCollection(COLLECTIONS.CAJAS, (cajas) => {
    const abierta = cajas.find((c) => c.estado === ESTADOS_CAJA.ABIERTA) || null;
    const historial = [...cajas].sort((a, b) => (b.fechaApertura || "").localeCompare(a.fechaApertura || ""));
    callback({ cajaAbierta: abierta, historial });
  });
}

export function listarVentas() {
  const ventas = getCollection(COLLECTIONS.VENTAS);
  return [...ventas].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
}

export function obtenerVentaPorId(ventaId) {
  return getDocById(COLLECTIONS.VENTAS, ventaId);
}

export function watchVentas(callback) {
  return subscribeCollection(COLLECTIONS.VENTAS, (ventas) => {
    const sorted = [...ventas].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
    callback(sorted);
  });
}

// ---------------------------------------------------------------------------
// 1. APERTURA DE CAJA (Sección 3)
// ---------------------------------------------------------------------------
export async function abrirCaja({ montoInicial, observaciones = "" }, user = getCurrentUser()) {
  assertPermission("caja.abrir", user);

  const montoNum = Number(montoInicial);
  if (!Number.isFinite(montoNum) || montoNum < 0 || String(montoInicial).trim() === "") {
    throw new Error("El monto inicial debe ser un valor numérico igual o mayor que cero.");
  }

  return runAtomicTransaction(
    async (tx) => {
      const controlCaja = tx.get(COLLECTIONS.CONTROL, "caja_activa");
      if (controlCaja?.activa && controlCaja?.cajaId) {
        const cajaControl = tx.get(COLLECTIONS.CAJAS, controlCaja.cajaId);
        if (!cajaControl || cajaControl.estado === ESTADOS_CAJA.ABIERTA) {
          throw new Error(
            `Ya existe una caja abierta por ${controlCaja.usuarioApertura || "otro usuario"}. No se permite duplicar la apertura.`
          );
        }
      }

      const cajas = tx.getAll(COLLECTIONS.CAJAS);
      const yaAbierta = cajas.find((c) => c.estado === ESTADOS_CAJA.ABIERTA);
      if (yaAbierta) {
        throw new Error(`Ya existe una caja abierta por ${yaAbierta.usuarioApertura}. No se permite duplicar la apertura.`);
      }

      const ahora = new Date().toISOString();
      const montoBase = roundCOP(montoNum);

      // Importante: el monto inicial representa el efectivo disponible al comienzo del turno.
      // NO se contabiliza como venta ni como ingreso generado por ventas en movimientos_contables.
      const nuevaCaja = tx.insert(COLLECTIONS.CAJAS, {
        estado: ESTADOS_CAJA.ABIERTA,
        usuarioApertura: user.name || user.email,
        usuarioUid: user.uid || user.email,
        fechaApertura: ahora,
        montoInicial: montoBase,
        observacionesApertura: String(observaciones || "").trim(),
        movimientosEfectivoExtra: [], // Entradas o salidas manuales de efectivo físico en caja
        fechaCierre: null,
        usuarioCierre: null,
        resumenCierre: null
      });

      tx.upsert(COLLECTIONS.CONTROL, "caja_activa", {
        activa: true,
        cajaId: nuevaCaja.id,
        usuarioApertura: nuevaCaja.usuarioApertura,
        usuarioUid: nuevaCaja.usuarioUid,
        fechaApertura: ahora
      });

      tx.insert(COLLECTIONS.AUDITORIA, {
        accion: "CAJA_APERTURA",
        cajaId: nuevaCaja.id,
        montoInicial: montoBase,
        usuario: user.name || user.email,
        fecha: ahora
      });

      return nuevaCaja;
    },
    {
      lockKey: "caja_activa",
      readDocs: [{ collection: COLLECTIONS.CONTROL, id: "caja_activa" }]
    }
  );
}

// Registrar entrada o salida manual de efectivo físico en la caja abierta (p. ej. cambio sencillo, gasto menor de caja)
export async function registrarMovimientoEfectivoCaja(
  { cajaId, tipo, monto, concepto },
  user = getCurrentUser()
) {
  assertPermission("caja.movimiento_efectivo", user);
  if (!["Entrada", "Salida"].includes(tipo)) {
    throw new Error("El tipo de movimiento de caja debe ser Entrada o Salida.");
  }
  const valor = roundCOP(monto);
  if (!(valor > 0)) {
    throw new Error("El monto del movimiento de efectivo debe ser mayor que cero.");
  }
  const conc = String(concepto || "").trim();
  if (!conc) {
    throw new Error("El concepto del movimiento de caja es obligatorio.");
  }

  return runAtomicTransaction(async (tx) => {
    const caja = tx.get(COLLECTIONS.CAJAS, cajaId);
    if (!caja || caja.estado !== ESTADOS_CAJA.ABIERTA) {
      throw new Error("La caja ya está cerrada.");
    }
    const ahora = new Date().toISOString();
    const mov = {
      id: `mc-${Date.now()}`,
      tipo,
      monto: valor,
      concepto: conc,
      usuario: user.name || user.email,
      fecha: ahora
    };
    const lista = Array.isArray(caja.movimientosEfectivoExtra) ? [...caja.movimientosEfectivoExtra, mov] : [mov];
    tx.update(COLLECTIONS.CAJAS, caja.id, { movimientosEfectivoExtra: lista });

    // Reflejar también en contabilidad interna manteniendo trazabilidad con caja
    tx.insert(COLLECTIONS.MOV_CONTABLES, {
      tipo: tipo === "Entrada" ? TIPOS_CONTABLE.INGRESO : TIPOS_CONTABLE.GASTO,
      categoria: tipo === "Entrada" ? "Entrada de efectivo en caja" : "Salida de efectivo en caja",
      concepto: conc,
      monto: valor,
      metodoPago: "Efectivo",
      afectaCajaFisica: true,
      cajaId: caja.id,
      origen: "Movimiento de caja",
      referenciaId: mov.id,
      usuario: user.name || user.email,
      fecha: ahora
    });

    return mov;
  });
}

// ---------------------------------------------------------------------------
// 2. CÁLCULOS DE LÍNEAS, SUBTOTAL, DESCUENTOS, IMPUESTOS Y TOTAL (Secciones 5 y 6)
// ---------------------------------------------------------------------------
export function calcularLineaVenta(item) {
  const esTemporal = Boolean(item.esTemporal);
  const prodInv = !esTemporal && item.productoId ? getDocById(COLLECTIONS.PRODUCTOS, item.productoId) : null;
  const precioBase = item.precioUnitario ?? item.precio ?? item.dimensiones?.precioM2 ?? prodInv?.precio ?? 0;
  const lineId = String(item.lineId || "").trim() || generarLineId();

  // Si la línea es un vidrio/espejo por medidas personalizadas, recalcular a partir de sus dimensiones
  if (item.dimensiones && item.dimensiones.ancho && (item.dimensiones.largo || item.dimensiones.altoCm)) {
    const d = item.dimensiones;
    const calc = calcularVidrioPersonalizado({
      ancho: d.ancho ?? d.anchoCm,
      largo: d.largo ?? d.largoCm ?? d.altoCm,
      unidadDimension: d.unidadDimension || (d.anchoCm ? "cm" : "m"),
      piezas: d.piezas ?? 1,
      precioM2: precioBase,
      costosAdicionales: item.costosAdicionales ?? d.costosAdicionales ?? 0,
      conceptoAdicional: item.conceptoAdicional ?? d.conceptoAdicional ?? ""
    });
    return {
      ...item,
      lineId,
      precioUnitario: calc.precioM2,
      cantidad: calc.areaTotal,
      precioMaterial: calc.precioMaterial,
      costosAdicionales: calc.costosAdicionales,
      conceptoAdicional: calc.conceptoAdicional,
      dimensiones: {
        ancho: calc.ancho,
        largo: calc.largo,
        unidadDimension: calc.unidadDimension,
        anchoM: calc.anchoM,
        largoM: calc.largoM,
        piezas: calc.piezas,
        areaPorPieza: calc.areaPorPieza,
        areaTotal: calc.areaTotal
      },
      subtotal: calc.precioFinalLinea
    };
  }

  const precioUnitario = roundCOP(precioBase);
  const cantidad = roundQty(item.cantidad);
  const costosAdicionales = roundCOP(item.costosAdicionales || 0);
  if (!(cantidad > 0)) throw new Error("La cantidad de cada línea debe ser mayor que cero.");
  if (!(precioUnitario >= 0)) throw new Error("El precio unitario no puede ser negativo.");
  if (costosAdicionales < 0) throw new Error("Los costos adicionales no pueden ser negativos.");
  const precioMaterial = roundCOP(precioUnitario * cantidad);
  const subtotal = roundCOP(precioMaterial + costosAdicionales);
  return {
    ...item,
    lineId,
    precioUnitario,
    cantidad,
    precioMaterial,
    costosAdicionales,
    subtotal
  };
}

// Fórmula general: Total = subtotal − descuentos + impuestos.
// Si no se especifican descuentos o impuestos, subtotal === total.
export function calcularTotalesVenta(items = [], { descuento = 0, impuesto = 0 } = {}) {
  const lineas = items.map(calcularLineaVenta);
  const subtotal = lineas.reduce((acc, item) => acc + item.subtotal, 0);
  const desc = roundCOP(descuento);
  const imp = roundCOP(impuesto);

  if (desc < 0) throw new Error("El descuento no puede ser negativo.");
  if (desc > subtotal) throw new Error("El descuento no puede superar el subtotal de la venta.");
  if (imp < 0) throw new Error("El impuesto no puede ser negativo.");

  const total = roundCOP(subtotal - desc + imp);
  return {
    lineas,
    subtotal: roundCOP(subtotal),
    descuento: desc,
    impuesto: imp,
    total
  };
}

// Calcula el cambio o faltante para un pago en efectivo o pagos divididos
export function evaluarPagos({ total, pagos = [] }) {
  const totalVenta = roundCOP(total);
  if (!Array.isArray(pagos) || pagos.length === 0) {
    throw new Error("Debe seleccionar al menos un método de pago.");
  }

  let sumaEfectivoRecibido = 0;
  let sumaOtrosMetodos = 0;

  const pagosNormalizados = pagos.map((p) => {
    const metodo = p.metodo;
    if (!METODOS_PAGO.includes(metodo)) {
      throw new Error(`Método de pago no válido: ${metodo}`);
    }
    const importe = roundCOP(p.importe ?? p.recibido ?? 0);
    if (!(importe > 0)) {
      throw new Error(`El importe del pago en ${metodo} debe ser mayor que cero.`);
    }
    if (metodo !== "Efectivo") {
      sumaOtrosMetodos += importe;
    } else {
      sumaEfectivoRecibido += importe;
    }
    return {
      metodo,
      importe,
      referencia: String(p.referencia || "").trim(),
      estadoConfirmacion: p.estadoConfirmacion || "Confirmado"
    };
  });

  if (sumaOtrosMetodos > totalVenta) {
    throw new Error("La suma de pagos electrónicos no puede superar el total de la venta.");
  }

  const totalRecibido = sumaEfectivoRecibido + sumaOtrosMetodos;
  const faltante = Math.max(0, totalVenta - totalRecibido);
  const cambio = totalRecibido > totalVenta ? roundCOP(totalRecibido - totalVenta) : 0;

  // Dinero neto en efectivo que entra y se queda en la caja física
  const efectivoNetoCaja = Math.max(0, roundCOP(sumaEfectivoRecibido - cambio));

  return {
    pagos: pagosNormalizados,
    totalVenta,
    totalRecibido: roundCOP(totalRecibido),
    sumaEfectivoRecibido: roundCOP(sumaEfectivoRecibido),
    sumaOtrosMetodos: roundCOP(sumaOtrosMetodos),
    efectivoNetoCaja,
    cambio,
    faltante,
    completo: faltante === 0
  };
}

// ---------------------------------------------------------------------------
// 3. CONFIRMACIÓN Y REGISTRO ATÓMICO DE LA VENTA (Secciones 8, 9, 10 y 14)
// ---------------------------------------------------------------------------
export async function registrarVenta(
  {
    cajaId,
    items,
    pagos,
    metodoPago,
    valorRecibido,
    referenciaPago = "",
    descuento = 0,
    impuesto = 0,
    clienteId = "cli-consumidor",
    ordenReferencia = "",
    anticipoPrevio = 0,
    esVentaCredito = false,
    idempotencyKey = null
  },
  user = getCurrentUser()
) {
  assertPermission("ventas.registrar", user);

  // Protección de idempotencia contra doble clic o reintentos de red
  if (idempotencyKey) {
    if (processedIdempotencyKeys.has(idempotencyKey)) {
      throw new Error("Esta venta ya fue procesada (solicitud duplicada bloqueada).");
    }
    processedIdempotencyKeys.add(idempotencyKey);
  }

  const opDocId = idempotencyKey ? normalizarIdOperacion("venta", idempotencyKey) : null;
  const readDocsVenta = [
    { collection: COLLECTIONS.CONTROL, id: "consecutivo_ventas" },
    { collection: COLLECTIONS.CONTROL, id: "caja_activa" }
  ];
  if (opDocId) readDocsVenta.push({ collection: COLLECTIONS.OPERACIONES, id: opDocId });
  if (cajaId) readDocsVenta.push({ collection: COLLECTIONS.CAJAS, id: cajaId });
  if (clienteId && clienteId !== "cli-consumidor") {
    readDocsVenta.push({ collection: COLLECTIONS.CLIENTES, id: clienteId });
  }
  for (const item of Array.isArray(items) ? items : []) {
    if (item && item.esTemporal !== true && item.productoId) {
      readDocsVenta.push({ collection: COLLECTIONS.PRODUCTOS, id: item.productoId });
    }
  }

  try {
    return await runAtomicTransaction(
      async (tx) => {
        // 1. Validar que la caja exista y siga abierta
        const caja = cajaId
          ? tx.get(COLLECTIONS.CAJAS, cajaId)
          : tx.getAll(COLLECTIONS.CAJAS).find((c) => c.estado === ESTADOS_CAJA.ABIERTA);

        if (!caja) {
          throw new Error("Debes abrir una caja antes de registrar ventas.");
        }
        if (caja.estado !== ESTADOS_CAJA.ABIERTA) {
          throw new Error("La caja ya está cerrada.");
        }

        // Verificar idempotencia persistida (operaciones/{opDocId} y ventas)
        if (opDocId && tx.get(COLLECTIONS.OPERACIONES, opDocId)) {
          throw new Error("Esta venta ya fue registrada.");
        }
        const ventasExistentes = tx.getAll(COLLECTIONS.VENTAS);
        if (idempotencyKey && ventasExistentes.some((v) => v.idempotencyKey === idempotencyKey)) {
          throw new Error("Esta venta ya fue registrada.");
        }

      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("Agrega al menos un producto a la venta actual.");
      }

      // Validar permiso de descuento si se aplica
      if (Number(descuento) > 0) {
        assertPermission("ventas.descuento", user);
      }

      // 2. Validar cada producto contra el inventario vigente y recalcular importes desde precios oficiales
      const lineasValidadas = [];
      const acumuladoPorProducto = new Map();

      for (const item of items) {
        if (item.esTemporal === true) {
          const nombreTemp = String(item.nombre || item.descripcion || "").trim();
          if (!nombreTemp) {
            throw new Error("La descripción o nombre del concepto temporal es obligatorio.");
          }
          const cantidadTemp = roundQty(item.cantidad ?? 1);
          if (!Number.isFinite(cantidadTemp) || !(cantidadTemp > 0)) {
            throw new Error(`La cantidad del concepto "${nombreTemp}" debe ser mayor que cero.`);
          }
          const precioTempRaw = item.precioUnitario ?? item.precio;
          const precioTemp = roundCOP(precioTempRaw);
          if (precioTempRaw === undefined || precioTempRaw === null || precioTempRaw === "" || !Number.isFinite(Number(precioTempRaw)) || precioTemp < 0) {
            throw new Error(`El precio unitario del concepto "${nombreTemp}" debe ser un valor válido y no negativo.`);
          }
          const costosAdicTemp = roundCOP(item.costosAdicionales || 0);
          if (costosAdicTemp < 0) {
            throw new Error("Los costos adicionales no pueden ser negativos.");
          }
          const precioMaterialTemp = roundCOP(precioTemp * cantidadTemp);
          const subtotalTemp = roundCOP(precioMaterialTemp + costosAdicTemp);

          lineasValidadas.push({
            lineId: String(item.lineId || "").trim() || generarLineId(),
            productoId: null,
            esTemporal: true,
            codigo: "",
            nombre: nombreTemp,
            descripcion: String(item.descripcion || nombreTemp).trim(),
            categoria: "Concepto temporal",
            unidad: String(item.unidad || "").trim(),
            observacion: String(item.observacion || "").trim(),
            esPersonalizado: false,
            dimensiones: null,
            precioInventario: null,
            precioUnitario: precioTemp,
            precioAutorizado: false,
            cantidad: cantidadTemp,
            precioMaterial: precioMaterialTemp,
            costosAdicionales: costosAdicTemp,
            conceptoAdicional: "",
            subtotal: subtotalTemp
          });
          continue;
        }

        const prod = tx.get(COLLECTIONS.PRODUCTOS, item.productoId);
        if (!prod || prod.activo === false) {
          throw new Error(`El producto "${item.nombre || item.productoId}" no existe o no está disponible.`);
        }

        // Determinar precio por unidad / m²: usa el del inventario salvo que un usuario con permiso explícito lo haya modificado
        let precioAplicado = roundCOP(prod.precio);
        if (item.precioUnitario !== undefined && roundCOP(item.precioUnitario) !== roundCOP(prod.precio)) {
          if (item.precioAutorizado) {
            assertPermission("ventas.modificar_precio", user);
            if (!(roundCOP(item.precioUnitario) > 0)) {
              throw new Error("El precio autorizado debe ser mayor que cero.");
            }
            precioAplicado = roundCOP(item.precioUnitario);
          } else {
            throw new Error("El producto fue actualizado. Verifica el precio y las existencias.");
          }
        }

        let cantidad = 0;
        let dimensionesGuardadas = null;
        let precioMaterial = 0;
        let costosAdicionales = roundCOP(item.costosAdicionales || 0);
        let conceptoAdicional = String(item.conceptoAdicional || "").trim();
        let subtotalLinea = 0;

        if (item.dimensiones && item.dimensiones.ancho && (item.dimensiones.largo || item.dimensiones.altoCm)) {
          const d = item.dimensiones;
          const calcVidrio = calcularVidrioPersonalizado({
            ancho: d.ancho ?? d.anchoCm,
            largo: d.largo ?? d.largoCm ?? d.altoCm,
            unidadDimension: d.unidadDimension || (d.anchoCm ? "cm" : "m"),
            piezas: d.piezas ?? 1,
            precioM2: precioAplicado,
            costosAdicionales,
            conceptoAdicional
          });
          cantidad = calcVidrio.areaTotal;
          precioMaterial = calcVidrio.precioMaterial;
          costosAdicionales = calcVidrio.costosAdicionales;
          conceptoAdicional = calcVidrio.conceptoAdicional;
          subtotalLinea = calcVidrio.precioFinalLinea;
          dimensionesGuardadas = {
            ancho: calcVidrio.ancho,
            largo: calcVidrio.largo,
            unidadDimension: calcVidrio.unidadDimension,
            anchoM: calcVidrio.anchoM,
            largoM: calcVidrio.largoM,
            piezas: calcVidrio.piezas,
            areaPorPieza: calcVidrio.areaPorPieza,
            areaTotal: calcVidrio.areaTotal
          };
        } else {
          cantidad = validarCantidadPorUnidad(prod, item.cantidad);
          if (costosAdicionales < 0) throw new Error("Los costos adicionales no pueden ser negativos.");
          precioMaterial = roundCOP(precioAplicado * cantidad);
          subtotalLinea = roundCOP(precioMaterial + costosAdicionales);
        }

        const previa = acumuladoPorProducto.get(prod.id) || 0;
        const totalSolicitado = roundQty(previa + cantidad);

        if (totalSolicitado > roundQty(prod.stock)) {
          const unidadTxt = prod.unidad ? ` ${prod.unidad}` : "";
          throw new Error(
            `No hay existencias suficientes para esta cantidad (${prod.nombre}: disponible ${prod.stock}${unidadTxt}).`
          );
        }
        acumuladoPorProducto.set(prod.id, totalSolicitado);

        lineasValidadas.push({
          lineId: String(item.lineId || "").trim() || generarLineId(),
          productoId: prod.id,
          esTemporal: false,
          codigo: prod.codigo,
          nombre: prod.nombre,
          categoria: prod.categoria,
          unidad: prod.unidad ?? "",
          esPersonalizado: Boolean(prod.esPersonalizado || dimensionesGuardadas),
          dimensiones: dimensionesGuardadas,
          precioInventario: roundCOP(prod.precio),
          precioUnitario: precioAplicado,
          precioAutorizado: Boolean(item.precioAutorizado && precioAplicado !== roundCOP(prod.precio)),
          cantidad,
          precioMaterial,
          costosAdicionales,
          conceptoAdicional,
          subtotal: subtotalLinea
        });
      }

      // 3. Recalcular subtotal, descuentos, impuestos y total en capa de negocio
      const calculo = calcularTotalesVenta(lineasValidadas, { descuento, impuesto });
      if (!(calculo.total > 0)) {
        throw new Error("El total de la venta debe ser mayor que cero.");
      }

      // Verificar si existe un anticipo previo aplicable para no duplicar el ingreso al completar la venta
      const ordenRefLimpia = String(ordenReferencia || "").trim();
      let anticipoReconocido = roundCOP(anticipoPrevio || 0);
      if (anticipoReconocido === 0 && ordenRefLimpia) {
        const movsPrevios = tx.getAll(COLLECTIONS.MOV_CONTABLES);
        anticipoReconocido = movsPrevios
          .filter(
            (m) =>
              !m.anulado &&
              m.estado !== "Revertido" &&
              m.tipo === TIPOS_CONTABLE.INGRESO &&
              (m.categoria === "Anticipos de clientes" || m.categoria === "Abonos") &&
              String(m.pedidoRelacionado || "").trim().toLowerCase() === ordenRefLimpia.toLowerCase() &&
              !m.aplicadoEnVentaId
          )
          .reduce((acc, m) => acc + roundCOP(m.monto), 0);
      }

      if (anticipoReconocido < 0 || anticipoReconocido > calculo.total) {
        throw new Error("El anticipo previo no puede ser negativo ni superar el total de la venta.");
      }

      const montoExigibleEnCobro = roundCOP(calculo.total - anticipoReconocido);

      // 4. Normalizar y validar pagos (pago único, pagos divididos o venta a crédito)
      let evalPago = {
        pagos: [],
        totalRecibido: 0,
        efectivoRecibido: 0,
        otrosMetodos: 0,
        efectivoNetoCaja: 0,
        cambio: 0,
        faltante: 0,
        completo: true
      };
      let saldoPendiente = 0;

      if (esVentaCredito && (!Array.isArray(pagos) || pagos.length === 0) && !valorRecibido) {
        // Venta 100% a crédito: no entra dinero en efectivo ni en bancos en este momento (Sección 7)
        saldoPendiente = montoExigibleEnCobro;
      } else if (montoExigibleEnCobro > 0) {
        const listaPagos =
          Array.isArray(pagos) && pagos.length > 0
            ? pagos
            : [
                {
                  metodo: metodoPago || "Efectivo",
                  importe:
                    (metodoPago || "Efectivo") === "Efectivo"
                      ? roundCOP(valorRecibido ?? 0)
                      : montoExigibleEnCobro,
                  referencia: referenciaPago
                }
              ];

        evalPago = evaluarPagos({ total: montoExigibleEnCobro, pagos: listaPagos });
        if (!evalPago.completo) {
          if (esVentaCredito) {
            saldoPendiente = evalPago.faltante;
          } else {
            throw new Error(
              `El valor recibido no cubre el total de la venta. Faltan $ ${evalPago.faltante.toLocaleString("es-CO")}.`
            );
          }
        }
      }

      // 5. Resolver cliente asociado (por defecto Consumidor Final) y validar reglas de crédito
      const cliente =
        tx.get(COLLECTIONS.CLIENTES, clienteId) || {
          id: "cli-consumidor",
          nombre: "Consumidor Final",
          documento: "222222222222",
          esConsumidorFinal: true
        };

      if (esVentaCredito || saldoPendiente > 0) {
        assertPermission("ventas.credito", user);
        if (!clienteId || clienteId === "cli-consumidor" || cliente.esConsumidorFinal) {
          throw new Error(
            "Las ventas a crédito o con saldo pendiente requieren un cliente identificado (no se permiten para Consumidor Final)."
          );
        }
      }

      const ahora = new Date().toISOString();
      const numeroVenta = obtenerYReservarConsecutivoVenta(tx, ventasExistentes, ahora);

      // 6. Descontar inventario una sola vez por producto y registrar kardex
      for (const [prodId, cantTotal] of acumuladoPorProducto.entries()) {
        const prod = tx.get(COLLECTIONS.PRODUCTOS, prodId);
        const stockAnterior = roundQty(prod.stock);
        const stockNuevo = roundQty(stockAnterior - cantTotal);
        tx.update(COLLECTIONS.PRODUCTOS, prodId, {
          stock: stockNuevo,
          actualizadoEn: ahora
        });

        tx.insert(COLLECTIONS.MOV_INVENTARIO, {
          ...(opDocId ? { id: `kardex-${opDocId}-${prod.id}` } : {}),
          productoId: prod.id,
          codigo: prod.codigo,
          productoNombre: prod.nombre,
          unidad: prod.unidad,
          tipo: "Salida",
          origen: "Venta POS",
          referenciaId: numeroVenta,
          cantidad: cantTotal,
          stockAnterior,
          stockNuevo,
          motivo: `Venta ${numeroVenta}`,
          usuario: user.name || user.email,
          fecha: ahora
        });
      }

      // 7. Insertar documento de venta
      const metodoResumen =
        evalPago.pagos.length === 0
          ? saldoPendiente > 0
            ? "Crédito"
            : "Anticipo aplicado"
          : evalPago.pagos.length === 1
            ? evalPago.pagos[0].metodo
            : `Mixto (${evalPago.pagos.map((p) => p.metodo).join(" + ")})`;

      const importePagadoEnTurno = roundCOP(montoExigibleEnCobro - saldoPendiente);
      const pagosIniciales = evalPago.pagos.map((p, idx) => ({
        ...p,
        id: `pay-ini-${Date.now().toString(36)}-${idx + 1}`,
        tipoPago: "Inicial",
        fecha: ahora,
        usuario: user.name || user.email,
        cajaId: caja.id,
        estado: "Confirmado"
      }));

      const ventaDoc = tx.insert(COLLECTIONS.VENTAS, {
        ...(opDocId ? { id: `v-${opDocId}` } : {}),
        numero: numeroVenta,
        cajaId: caja.id,
        estado: ESTADOS_VENTA.COMPLETADA,
        estadoCuenta: saldoPendiente > 0 ? "Pendiente" : "Pagada",
        cliente: {
          id: cliente.id,
          nombre: cliente.nombre,
          documento: cliente.documento
        },
        ordenReferencia: ordenRefLimpia,
        items: calculo.lineas,
        subtotal: calculo.subtotal,
        descuento: calculo.descuento,
        impuesto: calculo.impuesto,
        total: calculo.total,
        anticipoAplicado: anticipoReconocido,
        importePagado: roundCOP(anticipoReconocido + importePagadoEnTurno),
        saldoPendiente,
        metodoPago: metodoResumen,
        pagos: pagosIniciales,
        valorRecibido: evalPago.totalRecibido,
        efectivoNetoCaja: evalPago.efectivoNetoCaja,
        cambio: evalPago.cambio,
        vendedor: user.name || user.email,
        vendedorUid: user.uid || user.email,
        fecha: ahora,
        idempotencyKey
      });

      // Si se aplicaron anticipos previos de este pedido, vincularlos a la venta para no volver a aplicarlos
      if (anticipoReconocido > 0 && ordenRefLimpia) {
        const movsPrevios = tx.getAll(COLLECTIONS.MOV_CONTABLES);
        for (const m of movsPrevios) {
          if (
            !m.anulado &&
            m.estado !== "Revertido" &&
            m.tipo === TIPOS_CONTABLE.INGRESO &&
            (m.categoria === "Anticipos de clientes" || m.categoria === "Abonos") &&
            String(m.pedidoRelacionado || "").trim().toLowerCase() === ordenRefLimpia.toLowerCase() &&
            !m.aplicadoEnVentaId
          ) {
            tx.update(COLLECTIONS.MOV_CONTABLES, m.id, {
              aplicadoEnVentaId: ventaDoc.id,
              numeroVentaAsociada: numeroVenta,
              saldoPendientePedido: saldoPendiente
            });
          }
        }
      }

      // 8. Registrar en Contabilidad Básica únicamente los pagos efectivamente recibidos en este cobro,
      // desglosando cada método cuando hay pagos divididos y sin duplicar anticipos ni ventas a crédito (Sección 7).
      for (let idxPago = 0; idxPago < evalPago.pagos.length; idxPago++) {
        const pago = evalPago.pagos[idxPago];
        const montoPagoNeto = roundCOP(pago.importeNeto ?? pago.importe ?? 0);
        if (montoPagoNeto <= 0) continue;

        tx.insert(COLLECTIONS.MOV_CONTABLES, {
          ...(opDocId ? { id: `mc-${opDocId}-${idxPago + 1}` } : {}),
          tipo: TIPOS_CONTABLE.INGRESO,
          categoria: "Ventas de mostrador",
          concepto: `Venta ${numeroVenta} · ${cliente.nombre}${evalPago.pagos.length > 1 ? ` (${pago.metodo})` : ""}`,
          monto: montoPagoNeto,
          valor: montoPagoNeto,
          metodoPago: pago.metodo,
          afectaCajaFisica: pago.metodo === "Efectivo",
          cajaId: pago.metodo === "Efectivo" ? caja.id : null,
          origen: "Venta POS",
          referenciaId: ventaDoc.id,
          referencia: pago.referencia || numeroVenta,
          numeroVenta,
          clienteRelacionado: cliente.nombre,
          pedidoRelacionado: ordenRefLimpia,
          estado: "Confirmado",
          usuario: user.name || user.email,
          fechaEfectiva: ahora.slice(0, 10),
          fechaRegistro: ahora,
          fecha: ahora
        });
      }

      if (calculo.descuento > 0) {
        tx.insert(COLLECTIONS.AUDITORIA, {
          ...(opDocId ? { id: `aud-desc-${opDocId}` } : {}),
          accion: "VENTA_DESCUENTO",
          ventaId: ventaDoc.id,
          numeroVenta,
          descuento: calculo.descuento,
          usuario: user.name || user.email,
          fecha: ahora
        });
      }

      if (opDocId) {
        tx.upsert(COLLECTIONS.OPERACIONES, opDocId, {
          tipo: "VENTA",
          idempotencyKey,
          ventaId: ventaDoc.id,
          numeroVenta,
          usuario: user.name || user.email,
          fecha: ahora
        });
      }

      return ventaDoc;
    },
    {
      lockKey: "registrar_venta",
      readDocs: readDocsVenta
    }
  );
  } catch (err) {
    if (idempotencyKey) processedIdempotencyKeys.delete(idempotencyKey);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 4. ANULACIÓN Y DEVOLUCIONES CON AUTORIZACIÓN Y AUDITORÍA (Sección 11 y Fase 4)
// ---------------------------------------------------------------------------
export function getLineaKey(linea, index = 0) {
  if (linea?.lineId) return String(linea.lineId);
  if (linea?.productoId) return `legacy-${linea.productoId}-${index}`;
  return `legacy-idx-${index}`;
}

export function calcularDisponibilidadDevolucion(venta, devolucionesVenta = []) {
  if (!venta || !Array.isArray(venta.items)) return [];
  const devs = Array.isArray(devolucionesVenta) ? devolucionesVenta : [];

  return venta.items.map((linea, idx) => {
    const lineKey = getLineaKey(linea, idx);
    let devueltaPrevia = 0;

    for (const dev of devs) {
      for (const itemDev of dev.items || []) {
        const matchExacto =
          (itemDev.lineKey && itemDev.lineKey === lineKey) ||
          (linea.lineId && itemDev.lineId && itemDev.lineId === linea.lineId);
        const matchLegacy =
          !itemDev.lineKey &&
          !itemDev.lineId &&
          linea.productoId &&
          itemDev.productoId === linea.productoId;
        if (matchExacto || matchLegacy) {
          devueltaPrevia = roundQty(devueltaPrevia + Number(itemDev.cantidad || 0));
        }
      }
    }

    const cantOrig = roundQty(linea.cantidad || 0);
    const disponible = roundQty(Math.max(0, cantOrig - devueltaPrevia));
    return {
      ...linea,
      lineIndex: idx,
      lineKey,
      devueltaPrevia,
      disponible
    };
  });
}

export async function anularVenta(
  { ventaId, motivo, reintegrarInventario = true },
  user = getCurrentUser()
) {
  assertPermission("ventas.anular", user);
  const motivoLimpio = String(motivo || "").trim();
  if (!motivoLimpio) {
    throw new Error("Debe indicar el motivo de la anulación.");
  }

  return runAtomicTransaction(
    async (tx) => {
      const venta = tx.get(COLLECTIONS.VENTAS, ventaId);
    if (!venta) throw new Error("La venta indicada no existe.");
    if (venta.estado === ESTADOS_VENTA.DEVUELTA) {
      throw new Error(`La venta ${venta.numero} ya fue devuelta en su totalidad; no se puede anular.`);
    }
    if (venta.estado !== ESTADOS_VENTA.COMPLETADA) {
      throw new Error(`La venta ${venta.numero} ya se encuentra en estado ${venta.estado}.`);
    }

    const ahora = new Date().toISOString();
    const cajaOriginal = tx.get(COLLECTIONS.CAJAS, venta.cajaId);
    const cajaAbiertaActual = tx.getAll(COLLECTIONS.CAJAS).find((c) => c.estado === ESTADOS_CAJA.ABIERTA);
    const devsPrevias = tx.getAll(COLLECTIONS.DEVOLUCIONES).filter((d) => d.ventaId === venta.id);
    const disponibilidad = calcularDisponibilidadDevolucion(venta, devsPrevias);
    const totalYaDevuelto = devsPrevias.reduce((acc, d) => acc + roundCOP(d.totalDevuelto), 0);

    // Si reintegrarInventario está activo, devolver únicamente existencias aún disponibles (no devueltas previamente)
    const ajustesInventario = [];
    if (reintegrarInventario) {
      for (const linea of disponibilidad) {
        if (linea.esTemporal || !linea.productoId) continue;
        if (linea.dimensiones && linea.noReintegrable) continue;
        const cantReintegrar = roundQty(linea.disponible);
        if (!(cantReintegrar > 0)) continue;
        const prod = tx.get(COLLECTIONS.PRODUCTOS, linea.productoId);
        if (!prod) continue;
        const stockAnterior = roundQty(prod.stock);
        const stockNuevo = roundQty(stockAnterior + cantReintegrar);
        tx.update(COLLECTIONS.PRODUCTOS, prod.id, { stock: stockNuevo, actualizadoEn: ahora });

        tx.insert(COLLECTIONS.MOV_INVENTARIO, {
          productoId: prod.id,
          codigo: prod.codigo,
          productoNombre: prod.nombre,
          unidad: prod.unidad,
          tipo: "Entrada",
          origen: "Anulación de venta",
          referenciaId: venta.numero,
          cantidad: cantReintegrar,
          stockAnterior,
          stockNuevo,
          motivo: `Anulación ${venta.numero}: ${motivoLimpio}`,
          usuario: user.name || user.email,
          fecha: ahora
        });
        ajustesInventario.push({ productoId: prod.id, lineKey: linea.lineKey, nombre: prod.nombre, cantidad: cantReintegrar });
      }
    }

    // Marcar la venta como Anulada (sin borrar el registro histórico ni modificar retroactivamente cajas cerradas)
    const cajaAfectadaId =
      cajaOriginal && cajaOriginal.estado === ESTADOS_CAJA.ABIERTA
        ? cajaOriginal.id
        : cajaAbiertaActual
        ? cajaAbiertaActual.id
        : null;

    const ventaActualizada = tx.update(COLLECTIONS.VENTAS, venta.id, {
      estado: ESTADOS_VENTA.ANULADA,
      estadoCuenta: "Anulada",
      saldoPendiente: 0,
      anulacion: {
        motivo: motivoLimpio,
        usuario: user.name || user.email,
        fecha: ahora,
        cajaAjusteId: cajaAfectadaId,
        enCajaCerrada: Boolean(cajaOriginal && cajaOriginal.estado === ESTADOS_CAJA.CERRADA),
        devolucionesPreviasCount: devsPrevias.length,
        totalYaDevueltoPrevio: roundCOP(totalYaDevuelto),
        ajustesInventario
      }
    });

    // Marcar los movimientos contables originales de esta venta como Revertidos (conservando su historial)
    const movsContables = tx.getAll(COLLECTIONS.MOV_CONTABLES);
    for (const m of movsContables) {
      if (m.referenciaId === venta.id || m.numeroVenta === venta.numero) {
        tx.update(COLLECTIONS.MOV_CONTABLES, m.id, {
          anulado: true,
          estado: "Revertido",
          motivoReversion: `Anulación de venta ${venta.numero}: ${motivoLimpio}`,
          revertidoPor: user.name || user.email,
          fechaReversion: ahora
        });
      }
    }

    // Registrar también el asiento de ajuste auditable sin inflar gastos operativos
    tx.insert(COLLECTIONS.MOV_CONTABLES, {
      tipo: "Reversión",
      categoria: "Anulación / Devolución de venta",
      concepto: `Reversión por anulación ${venta.numero} · ${motivoLimpio}`,
      monto: venta.total,
      valor: venta.total,
      metodoPago: venta.metodoPago,
      afectaCajaFisica: venta.efectivoNetoCaja > 0,
      cajaId: cajaAfectadaId,
      origen: "Anulación POS",
      referenciaId: venta.id,
      referencia: venta.numero,
      estado: "Ajuste aplicado",
      anulado: true,
      usuario: user.name || user.email,
      fechaEfectiva: ahora.slice(0, 10),
      fechaRegistro: ahora,
      fecha: ahora
    });

    tx.insert(COLLECTIONS.AUDITORIA, {
      accion: "VENTA_ANULADA",
      ventaId: venta.id,
      numeroVenta: venta.numero,
      motivo: motivoLimpio,
      monto: venta.total,
      usuario: user.name || user.email,
      fecha: ahora
    });

    return ventaActualizada;
  },
  {
    lockKey: `anular_${ventaId}`,
    readDocs: [
      { collection: COLLECTIONS.VENTAS, id: ventaId },
      { collection: COLLECTIONS.CONTROL, id: "caja_activa" }
    ],
    resolveReadDocs: (snapshot) => {
      const v = (snapshot[COLLECTIONS.VENTAS] || []).find((x) => x.id === ventaId);
      if (!v) return [];
      const refs = [];
      if (v.cajaId) refs.push({ collection: COLLECTIONS.CAJAS, id: v.cajaId });
      for (const item of v.items || []) {
        if (item.esTemporal !== true && item.productoId) {
          refs.push({ collection: COLLECTIONS.PRODUCTOS, id: item.productoId });
        }
      }
      return refs;
    }
  });
}

// Flujo independiente de devolución parcial o total referenciando la venta original
export async function registrarDevolucionVenta(
  {
    ventaId,
    itemsDevueltos,
    motivo,
    reintegrarStock = true,
    tipoReembolso = null,
    reembolsoEfectivo = undefined,
    referenciaReembolso = "",
    idempotencyKey = null
  },
  user = getCurrentUser()
) {
  assertPermission("ventas.devolucion", user);
  const motivoLimpio = String(motivo || "").trim();
  if (!motivoLimpio) throw new Error("Debe indicar el motivo de la devolución.");
  if (!Array.isArray(itemsDevueltos) || itemsDevueltos.length === 0) {
    throw new Error("Seleccione al menos un producto o concepto a devolver.");
  }

  if (idempotencyKey) {
    if (processedIdempotencyKeys.has(idempotencyKey)) {
      throw new Error("Esta devolución ya fue procesada (solicitud duplicada bloqueada).");
    }
    processedIdempotencyKeys.add(idempotencyKey);
  }

  const opDocId = idempotencyKey ? normalizarIdOperacion("dev", idempotencyKey) : null;
  const readDocsDev = [
    { collection: COLLECTIONS.VENTAS, id: ventaId },
    { collection: COLLECTIONS.CONTROL, id: "caja_activa" }
  ];
  if (opDocId) readDocsDev.push({ collection: COLLECTIONS.OPERACIONES, id: opDocId });
  for (const d of itemsDevueltos) {
    if (d && d.productoId) {
      readDocsDev.push({ collection: COLLECTIONS.PRODUCTOS, id: d.productoId });
    }
  }

  try {
    return await runAtomicTransaction(
      async (tx) => {
        const venta = tx.get(COLLECTIONS.VENTAS, ventaId);
        if (!venta) throw new Error("La venta original no existe.");
        if (venta.estado === ESTADOS_VENTA.ANULADA) {
          throw new Error("No se puede registrar una devolución sobre una venta anulada.");
        }
        if (venta.estado === ESTADOS_VENTA.DEVUELTA) {
          throw new Error("Esta venta ya fue devuelta en su totalidad.");
        }

        if (opDocId && tx.get(COLLECTIONS.OPERACIONES, opDocId)) {
          throw new Error("Esta devolución ya fue registrada anteriormente.");
        }
        const todasDevs = tx.getAll(COLLECTIONS.DEVOLUCIONES);
        if (idempotencyKey && todasDevs.some((d) => d.idempotencyKey === idempotencyKey)) {
          throw new Error("Esta devolución ya fue registrada anteriormente.");
        }

      const devsVenta = todasDevs.filter((d) => d.ventaId === venta.id);
      const disponibilidad = calcularDisponibilidadDevolucion(venta, devsVenta);
      const usadasEnSolicitud = new Set();

      const ahora = new Date().toISOString();
      const factorDescuento =
        roundCOP(venta.subtotal) > 0 && roundCOP(venta.descuento || 0) > 0
          ? Math.max(0, roundCOP(venta.subtotal) - roundCOP(venta.descuento)) / roundCOP(venta.subtotal)
          : 1;

      let totalDevuelto = 0;
      const detalleDevolucion = [];

      for (const dev of itemsDevueltos) {
        const lineaDisp = dev.lineKey
          ? disponibilidad.find((i) => i.lineKey === dev.lineKey)
          : dev.lineId
            ? disponibilidad.find((i) => i.lineId === dev.lineId)
            : disponibilidad.find((i) => i.productoId === dev.productoId && !usadasEnSolicitud.has(i.lineKey));

        if (!lineaDisp) {
          throw new Error("El producto o concepto indicado no pertenece a la venta original.");
        }
        if (usadasEnSolicitud.has(lineaDisp.lineKey)) {
          throw new Error(`La línea "${lineaDisp.nombre}" aparece duplicada en la misma devolución.`);
        }
        usadasEnSolicitud.add(lineaDisp.lineKey);

        const cantDev = roundQty(dev.cantidad);
        if (!Number.isFinite(Number(dev.cantidad)) || !(cantDev > 0)) {
          throw new Error(`La cantidad a devolver para "${lineaDisp.nombre}" debe ser mayor que cero.`);
        }
        if (cantDev > lineaDisp.disponible) {
          throw new Error(
            `La cantidad a devolver de "${lineaDisp.nombre}" (${cantDev}) supera la disponible (${lineaDisp.disponible}).`
          );
        }

        const costoAdicOrig = roundCOP(lineaDisp.costosAdicionales || 0);
        const costoAdicProporcional =
          costoAdicOrig > 0 && lineaDisp.cantidad > 0
            ? roundCOP((costoAdicOrig * cantDev) / lineaDisp.cantidad)
            : 0;
        const brutoLinea = roundCOP(cantDev * roundCOP(lineaDisp.precioUnitario) + costoAdicProporcional);
        const importeLinea = roundCOP(brutoLinea * factorDescuento);
        totalDevuelto = roundCOP(totalDevuelto + importeLinea);

        const esTemporal = Boolean(lineaDisp.esTemporal || !lineaDisp.productoId);
        const reintegraEsteItem = Boolean(
          reintegrarStock && !esTemporal && dev.aptoInventario !== false
        );
        const condicionProducto = esTemporal
          ? "Concepto temporal"
          : reintegraEsteItem
            ? "Apto (reintegrado)"
            : "No apto / sin reintegro";

        if (reintegraEsteItem) {
          const prod = tx.get(COLLECTIONS.PRODUCTOS, lineaDisp.productoId);
          if (prod) {
            const stockAnt = roundQty(prod.stock);
            const stockNvo = roundQty(stockAnt + cantDev);
            tx.update(COLLECTIONS.PRODUCTOS, prod.id, { stock: stockNvo, actualizadoEn: ahora });
            tx.insert(COLLECTIONS.MOV_INVENTARIO, {
              productoId: prod.id,
              codigo: prod.codigo,
              productoNombre: prod.nombre,
              unidad: prod.unidad,
              tipo: "Entrada",
              origen: "Devolución de cliente",
              referenciaId: venta.numero,
              cantidad: cantDev,
              stockAnterior: stockAnt,
              stockNuevo: stockNvo,
              motivo: `Devolución ${venta.numero}: ${motivoLimpio}`,
              usuario: user.name || user.email,
              fecha: ahora
            });
          }
        }

        detalleDevolucion.push({
          lineId: lineaDisp.lineId || null,
          lineKey: lineaDisp.lineKey,
          esTemporal,
          productoId: lineaDisp.productoId || null,
          codigo: esTemporal ? "" : (lineaDisp.codigo || ""),
          nombre: lineaDisp.nombre,
          cantidad: cantDev,
          unidad: lineaDisp.unidad ?? "",
          dimensiones: lineaDisp.dimensiones || null,
          precioUnitario: roundCOP(lineaDisp.precioUnitario),
          importe: importeLinea,
          condicionProducto,
          reintegradoInventario: reintegraEsteItem
        });
      }

      // Política financiera validada:
      // 1) Si hay saldo pendiente en cartera, descontar primero del saldo pendiente.
      // 2) Solo el excedente (tope = pagado neto no reembolsado previamente) es reembolsable o queda como saldo a favor.
      const saldoActual = roundCOP(venta.saldoPendiente || 0);
      const importePagado = roundCOP(
        venta.importePagado !== undefined && venta.importePagado !== null
          ? venta.importePagado
          : Math.max(0, roundCOP(venta.total) - saldoActual)
      );
      const totalYaReembolsado = devsVenta.reduce(
        (acc, d) => acc + roundCOP(d.montoReembolsado ?? (d.reembolsoEfectivo ? d.totalDevuelto : 0)),
        0
      );
      const pagadoDisponibleParaReembolso = Math.max(0, roundCOP(importePagado - totalYaReembolsado));

      const reduccionCartera = Math.min(saldoActual, totalDevuelto);
      const excedenteBruto = roundCOP(totalDevuelto - reduccionCartera);
      const excedenteReembolsable = Math.min(excedenteBruto, pagadoDisponibleParaReembolso);
      const nuevoSaldo = roundCOP(saldoActual - reduccionCartera);

      let tipoReembolsoFinal = tipoReembolso;
      if (!tipoReembolsoFinal) {
        if (excedenteReembolsable <= 0) {
          tipoReembolsoFinal = "Ajuste de cartera";
        } else if (reembolsoEfectivo === false) {
          tipoReembolsoFinal = "Saldo a favor";
        } else {
          tipoReembolsoFinal = "Efectivo";
        }
      }

      const cajaAbierta = tx.getAll(COLLECTIONS.CAJAS).find((c) => c.estado === ESTADOS_CAJA.ABIERTA);
      let montoReembolsado = 0;
      let saldoAFavorGenerado = 0;
      let esReembolsoEfectivo = false;

      if (excedenteReembolsable > 0) {
        if (tipoReembolsoFinal === "Efectivo") {
          if (!cajaAbierta || cajaAbierta.estado !== ESTADOS_CAJA.ABIERTA) {
            throw new Error("Debes abrir una caja para realizar un reembolso en efectivo.");
          }
          montoReembolsado = excedenteReembolsable;
          esReembolsoEfectivo = true;
        } else if (tipoReembolsoFinal === "Transferencia") {
          montoReembolsado = excedenteReembolsable;
          esReembolsoEfectivo = false;
        } else {
          tipoReembolsoFinal = "Saldo a favor";
          saldoAFavorGenerado = excedenteReembolsable;
          montoReembolsado = 0;
          esReembolsoEfectivo = false;
        }
      } else {
        tipoReembolsoFinal = "Ajuste de cartera";
      }

      // Verificar si la venta quedó devuelta al 100%
      const devMapSolicitada = new Map(detalleDevolucion.map((d) => [d.lineKey, d.cantidad]));
      const esDevolucionTotal = disponibilidad.every(
        (l) => roundQty(l.disponible - (devMapSolicitada.get(l.lineKey) || 0)) <= 0
      );

      const totalDevueltoAcumulado = roundCOP(
        devsVenta.reduce((acc, d) => acc + roundCOP(d.totalDevuelto), 0) + totalDevuelto
      );

      tx.update(COLLECTIONS.VENTAS, venta.id, {
        estado: esDevolucionTotal ? ESTADOS_VENTA.DEVUELTA : ESTADOS_VENTA.COMPLETADA,
        saldoPendiente: nuevoSaldo,
        estadoCuenta: nuevoSaldo > 0 ? "Pendiente" : "Pagada",
        totalDevueltoAcumulado,
        ultimaDevolucionEn: ahora
      });

      const devDoc = tx.insert(COLLECTIONS.DEVOLUCIONES, {
        ...(opDocId ? { id: `dev-${opDocId}` } : {}),
        ventaId: venta.id,
        numeroVenta: venta.numero,
        cliente: venta.cliente || { id: "cli-consumidor", nombre: "Consumidor Final", documento: "222222222222" },
        cajaId: cajaAbierta ? cajaAbierta.id : null,
        items: detalleDevolucion,
        totalDevuelto: roundCOP(totalDevuelto),
        reduccionCartera,
        excedenteReembolsable,
        tipoReembolso: tipoReembolsoFinal,
        montoReembolsado,
        saldoAFavorGenerado,
        reembolsoEfectivo: esReembolsoEfectivo,
        referenciaReembolso: String(referenciaReembolso || "").trim(),
        esDevolucionTotal,
        motivo: motivoLimpio,
        idempotencyKey: idempotencyKey || null,
        usuario: user.name || user.email,
        fecha: ahora
      });

      tx.insert(COLLECTIONS.MOV_CONTABLES, {
        ...(opDocId ? { id: `mc-${opDocId}` } : {}),
        tipo: TIPOS_CONTABLE.DEVOLUCION,
        categoria: "Devolución de venta",
        concepto: `Devolución sobre ${venta.numero} (${tipoReembolsoFinal}) · ${motivoLimpio}`,
        monto: roundCOP(totalDevuelto),
        valor: roundCOP(totalDevuelto),
        montoReembolsado,
        reduccionCartera,
        saldoAFavorGenerado,
        metodoPago: esReembolsoEfectivo
          ? "Efectivo"
          : tipoReembolsoFinal === "Transferencia"
            ? "Transferencia"
            : "Ajuste / Nota crédito",
        afectaCajaFisica: esReembolsoEfectivo,
        cajaId: esReembolsoEfectivo && cajaAbierta ? cajaAbierta.id : null,
        origen: "Devolución POS",
        referenciaId: devDoc.id,
        ventaId: venta.id,
        numeroVenta: venta.numero,
        clienteRelacionado: venta.cliente?.nombre || "Consumidor Final",
        estado: "Confirmado",
        usuario: user.name || user.email,
        fechaEfectiva: ahora.slice(0, 10),
        fechaRegistro: ahora,
        fecha: ahora
      });

      tx.insert(COLLECTIONS.AUDITORIA, {
        ...(opDocId ? { id: `aud-${opDocId}` } : {}),
        accion: esDevolucionTotal ? "VENTA_DEVOLUCION_TOTAL" : "VENTA_DEVOLUCION_PARCIAL",
        ventaId: venta.id,
        numeroVenta: venta.numero,
        devolucionId: devDoc.id,
        totalDevuelto: roundCOP(totalDevuelto),
        reduccionCartera,
        montoReembolsado,
        tipoReembolso: tipoReembolsoFinal,
        motivo: motivoLimpio,
        usuario: user.name || user.email,
        fecha: ahora
      });

      if (opDocId) {
        tx.upsert(COLLECTIONS.OPERACIONES, opDocId, {
          tipo: "DEVOLUCION",
          idempotencyKey,
          ventaId: venta.id,
          devolucionId: devDoc.id,
          usuario: user.name || user.email,
          fecha: ahora
        });
      }

      return devDoc;
    },
    {
      lockKey: `devolucion_${ventaId}`,
      readDocs: readDocsDev
    }
  );
  } catch (err) {
    if (idempotencyKey) processedIdempotencyKeys.delete(idempotencyKey);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 5. ARQUEO Y CIERRE DE CAJA (Sección 12)
// ---------------------------------------------------------------------------
// Efectivo esperado = monto inicial + entradas de efectivo − salidas de efectivo.
// Los pagos por transferencia o tarjeta NO se suman como efectivo físico.
export function calcularArqueoCaja(caja, ventasAll = getCollection(COLLECTIONS.VENTAS), devolucionesAll = getCollection(COLLECTIONS.DEVOLUCIONES)) {
  if (!caja) return null;

  const ventasTurno = ventasAll.filter((v) => v.cajaId === caja.id);
  const ventasActivas = ventasTurno.filter((v) => v.estado !== ESTADOS_VENTA.ANULADA);
  const ventasAnuladas = ventasTurno.filter((v) => v.estado === ESTADOS_VENTA.ANULADA);

  const porMetodo = {
    Efectivo: 0,
    Transferencia: 0,
    "Tarjeta débito": 0,
    "Tarjeta crédito": 0
  };

  let totalVendido = 0;
  let entradasEfectivoVentas = 0;

  for (const v of ventasActivas) {
    totalVendido += roundCOP(v.total);
    let sumaEfectivoRecibidoVenta = 0;
    if (Array.isArray(v.pagos)) {
      for (const p of v.pagos) {
        if (p.tipoPago === "Abono") continue;
        if (p.metodo === "Efectivo") {
          sumaEfectivoRecibidoVenta += roundCOP(p.importe);
        } else {
          porMetodo[p.metodo] = (porMetodo[p.metodo] || 0) + roundCOP(p.importe);
        }
      }
    }
    const efectivoNetoVenta =
      v.efectivoNetoCaja !== undefined && v.efectivoNetoCaja !== null
        ? roundCOP(v.efectivoNetoCaja)
        : Math.max(0, roundCOP(sumaEfectivoRecibidoVenta - roundCOP(v.cambio || 0)));
    porMetodo.Efectivo += efectivoNetoVenta;
    entradasEfectivoVentas += efectivoNetoVenta;
  }

  // Abonos posteriores recaudados durante este turno de caja (sin contarlos como nueva venta)
  let entradasEfectivoAbonos = 0;
  for (const v of ventasAll) {
    if (v.estado === ESTADOS_VENTA.ANULADA || !Array.isArray(v.pagos)) continue;
    for (const p of v.pagos) {
      if (p.tipoPago !== "Abono" || p.estado === "Anulado") continue;
      if (p.cajaId !== caja.id) continue;
      const imp = roundCOP(p.importe);
      if (p.metodo === "Efectivo") {
        entradasEfectivoAbonos += imp;
        porMetodo.Efectivo += imp;
      } else {
        porMetodo[p.metodo] = (porMetodo[p.metodo] || 0) + imp;
      }
    }
  }

  // Entradas y salidas manuales de efectivo físico en esa caja
  const movsExtra = Array.isArray(caja.movimientosEfectivoExtra) ? caja.movimientosEfectivoExtra : [];
  let entradasEfectivoManual = 0;
  let salidasEfectivoManual = 0;
  for (const m of movsExtra) {
    if (m.tipo === "Entrada") entradasEfectivoManual += roundCOP(m.monto);
    if (m.tipo === "Salida") salidasEfectivoManual += roundCOP(m.monto);
  }

  // Devoluciones con reembolso real en efectivo aplicadas durante el turno
  const devsTurno = devolucionesAll.filter((d) => d.cajaId === caja.id && d.reembolsoEfectivo);
  const salidasPorDevoluciones = devsTurno.reduce(
    (acc, d) => acc + roundCOP(d.montoReembolsado ?? d.totalDevuelto),
    0
  );

  // Anulaciones de ventas en efectivo de otra caja aplicadas sobre esta caja abierta
  const anulacionesExternasEnEstaCaja = ventasAll.filter(
    (v) =>
      v.estado === ESTADOS_VENTA.ANULADA &&
      v.cajaId !== caja.id &&
      v.anulacion?.cajaAjusteId === caja.id
  );
  const salidasPorAnulaciones = anulacionesExternasEnEstaCaja.reduce(
    (acc, v) => acc + roundCOP(v.efectivoNetoCaja || 0),
    0
  );

  const montoInicial = roundCOP(caja.montoInicial);
  const totalEntradasEfectivo = roundCOP(entradasEfectivoVentas + entradasEfectivoAbonos + entradasEfectivoManual);
  const totalSalidasEfectivo = roundCOP(salidasEfectivoManual + salidasPorDevoluciones + salidasPorAnulaciones);
  const efectivoEsperado = roundCOP(montoInicial + totalEntradasEfectivo - totalSalidasEfectivo);

  return {
    cajaId: caja.id,
    usuarioApertura: caja.usuarioApertura,
    fechaApertura: caja.fechaApertura,
    montoInicial,
    numeroVentas: ventasActivas.length,
    numeroAnuladas: ventasAnuladas.length,
    numeroDevoluciones: devsTurno.length,
    totalVendido: roundCOP(totalVendido),
    pagosPorMetodo: porMetodo,
    entradasEfectivoVentas: roundCOP(entradasEfectivoVentas),
    entradasEfectivoAbonos: roundCOP(entradasEfectivoAbonos),
    entradasEfectivoManual: roundCOP(entradasEfectivoManual),
    salidasEfectivoManual: roundCOP(salidasEfectivoManual),
    salidasPorDevoluciones: roundCOP(salidasPorDevoluciones + salidasPorAnulaciones),
    totalEntradasEfectivo,
    totalSalidasEfectivo,
    efectivoEsperado
  };
}

export async function cerrarCaja(
  { cajaId, efectivoContado, observaciones = "" },
  user = getCurrentUser()
) {
  assertPermission("caja.cerrar", user);

  const contadoNum = Number(efectivoContado);
  if (!Number.isFinite(contadoNum) || contadoNum < 0 || String(efectivoContado).trim() === "") {
    throw new Error("Debe ingresar el efectivo contado (valor numérico igual o mayor que cero).");
  }

  return runAtomicTransaction(
    async (tx) => {
      const caja = tx.get(COLLECTIONS.CAJAS, cajaId);
      if (!caja) throw new Error("Caja no encontrada.");
      if (caja.estado !== ESTADOS_CAJA.ABIERTA) {
        throw new Error("La caja ya está cerrada.");
      }

      const ventasAll = tx.getAll(COLLECTIONS.VENTAS);
      const devsAll = tx.getAll(COLLECTIONS.DEVOLUCIONES);
      const arqueo = calcularArqueoCaja(caja, ventasAll, devsAll);

      const contado = roundCOP(contadoNum);
      const diferencia = roundCOP(contado - arqueo.efectivoEsperado);
      const obsLimpia = String(observaciones || "").trim();

      if (diferencia !== 0 && !obsLimpia) {
        throw new Error(
          `Existe una diferencia de caja de $ ${diferencia.toLocaleString("es-CO")}. Debe registrar una observación explicando la diferencia.`
        );
      }

      const ahora = new Date().toISOString();
      const resumenCierre = {
        ...arqueo,
        efectivoContado: contado,
        diferencia,
        observaciones: obsLimpia,
        usuarioCierre: user.name || user.email,
        fechaCierre: ahora
      };

      const cajaCerrada = tx.update(COLLECTIONS.CAJAS, caja.id, {
        estado: ESTADOS_CAJA.CERRADA,
        fechaCierre: ahora,
        usuarioCierre: user.name || user.email,
        efectivoEsperado: arqueo.efectivoEsperado,
        efectivoContado: contado,
        diferencia,
        observacionesCierre: obsLimpia,
        resumenCierre
      });

      tx.upsert(COLLECTIONS.CONTROL, "caja_activa", {
        activa: false,
        cajaId: null,
        ultimaCajaCerradaId: caja.id,
        fechaCierre: ahora,
        usuarioCierre: user.name || user.email
      });

      tx.insert(COLLECTIONS.AUDITORIA, {
        accion: "CAJA_CIERRE",
        cajaId: caja.id,
        efectivoEsperado: arqueo.efectivoEsperado,
        efectivoContado: contado,
        diferencia,
        usuario: user.name || user.email,
        fecha: ahora
      });

      return cajaCerrada;
    },
    {
      lockKey: "caja_activa",
      readDocs: [
        { collection: COLLECTIONS.CAJAS, id: cajaId },
        { collection: COLLECTIONS.CONTROL, id: "caja_activa" }
      ]
    }
  );
}

// ---------------------------------------------------------------------------
// 6. FILTRO E HISTORIAL DE VENTAS (Sección 13)
// ---------------------------------------------------------------------------
export function filtrarHistorialVentas(
  ventas = listarVentas(),
  { busqueda = "", desde = "", hasta = "", metodoPago = "Todos", estado = "Todos" } = {}
) {
  const q = String(busqueda || "").trim().toLowerCase();
  const desdeTs = desde ? new Date(`${desde}T00:00:00`).getTime() : null;
  const hastaTs = hasta ? new Date(`${hasta}T23:59:59.999`).getTime() : null;

  return ventas.filter((v) => {
    const fechaTs = v.fecha ? new Date(v.fecha).getTime() : 0;
    if (desdeTs && fechaTs < desdeTs) return false;
    if (hastaTs && fechaTs > hastaTs) return false;
    if (metodoPago && metodoPago !== "Todos" && !String(v.metodoPago || "").includes(metodoPago)) {
      return false;
    }
    if (estado && estado !== "Todos" && v.estado !== estado) {
      return false;
    }
    if (q) {
      const matchNum = String(v.numero || "").toLowerCase().includes(q);
      const matchCli = String(v.cliente?.nombre || "").toLowerCase().includes(q) || String(v.cliente?.documento || "").toLowerCase().includes(q);
      const matchUsr = String(v.vendedor || "").toLowerCase().includes(q);
      if (!matchNum && !matchCli && !matchUsr) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// 4B. REGISTRO DE ABONOS A VENTAS A CRÉDITO (FASE 3)
// ---------------------------------------------------------------------------
export async function registrarAbonoVenta(
  {
    ventaId,
    importe,
    metodoPago = "Efectivo",
    referencia = "",
    cajaId = null,
    idempotencyKey = null
  },
  user = getCurrentUser()
) {
  assertPermission("ventas.abonar", user);

  if (idempotencyKey) {
    if (processedIdempotencyKeys.has(idempotencyKey)) {
      throw new Error("Este abono ya fue procesado (solicitud duplicada bloqueada).");
    }
    processedIdempotencyKeys.add(idempotencyKey);
  }

  const opDocId = idempotencyKey ? normalizarIdOperacion("abono", idempotencyKey) : null;
  const readDocsAbono = [
    { collection: COLLECTIONS.VENTAS, id: ventaId },
    { collection: COLLECTIONS.CONTROL, id: "caja_activa" }
  ];
  if (opDocId) readDocsAbono.push({ collection: COLLECTIONS.OPERACIONES, id: opDocId });
  if (cajaId) readDocsAbono.push({ collection: COLLECTIONS.CAJAS, id: cajaId });

  try {
    return await runAtomicTransaction(
      async (tx) => {
        if (!ventaId) {
          throw new Error("Debe indicar la venta a la cual se aplica el abono.");
        }
        const venta = tx.get(COLLECTIONS.VENTAS, ventaId);
        if (!venta) {
          throw new Error("La venta seleccionada no existe.");
        }
        if (venta.estado === ESTADOS_VENTA.ANULADA) {
          throw new Error("No se puede registrar un abono sobre una venta anulada.");
        }
        if (!venta.cliente?.id || venta.cliente.id === "cli-consumidor") {
          throw new Error("Solo se permiten abonos sobre ventas asociadas a un cliente identificado.");
        }

        if (opDocId && tx.get(COLLECTIONS.OPERACIONES, opDocId)) {
          throw new Error("Este abono ya fue registrado anteriormente.");
        }

      const saldoActual = roundCOP(
        venta.saldoPendiente !== undefined && venta.saldoPendiente !== null
          ? venta.saldoPendiente
          : Math.max(0, roundCOP(venta.total) - roundCOP(venta.importePagado ?? venta.total))
      );
      if (!(saldoActual > 0)) {
        throw new Error("Esta venta no tiene saldo pendiente por cobrar.");
      }

      if (!METODOS_PAGO.includes(metodoPago)) {
        throw new Error(`Método de pago no válido para abono: ${metodoPago}`);
      }

      const monto = roundCOP(importe);
      if (!Number.isFinite(Number(importe)) || !(monto > 0)) {
        throw new Error("El importe del abono debe ser mayor que cero.");
      }
      if (monto > saldoActual) {
        throw new Error(
          `El abono ($ ${monto.toLocaleString("es-CO")}) supera el saldo pendiente ($ ${saldoActual.toLocaleString("es-CO")}).`
        );
      }

      const pagosPrevios = Array.isArray(venta.pagos) ? venta.pagos : [];
      if (idempotencyKey && pagosPrevios.some((p) => p.idempotencyKey === idempotencyKey)) {
        throw new Error("Este abono ya fue registrado anteriormente.");
      }

      const cajaAbierta = cajaId
        ? tx.get(COLLECTIONS.CAJAS, cajaId)
        : tx.getAll(COLLECTIONS.CAJAS).find((c) => c.estado === ESTADOS_CAJA.ABIERTA);

      if (metodoPago === "Efectivo") {
        if (!cajaAbierta || cajaAbierta.estado !== ESTADOS_CAJA.ABIERTA) {
          throw new Error("Debes abrir una caja antes de registrar un abono en efectivo.");
        }
      }

      const ahora = new Date().toISOString();
      const abonoId = opDocId
        ? `abn-${opDocId}`
        : `abn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const cajaAsociadaId = cajaAbierta && cajaAbierta.estado === ESTADOS_CAJA.ABIERTA ? cajaAbierta.id : null;

      const abonoRecord = {
        id: abonoId,
        tipoPago: "Abono",
        metodo: metodoPago,
        importe: monto,
        referencia: String(referencia || "").trim(),
        fecha: ahora,
        usuario: user.name || user.email,
        usuarioUid: user.uid || user.email,
        cajaId: cajaAsociadaId,
        estado: "Confirmado",
        estadoConfirmacion: "Confirmado",
        idempotencyKey: idempotencyKey || null
      };

      const nuevoSaldo = roundCOP(saldoActual - monto);
      const pagadoPrevio = roundCOP(
        venta.importePagado !== undefined && venta.importePagado !== null
          ? venta.importePagado
          : Math.max(0, roundCOP(venta.total) - saldoActual)
      );
      const nuevoPagado = roundCOP(pagadoPrevio + monto);
      const estadoCuenta = nuevoSaldo === 0 ? "Pagada" : "Pendiente";

      const ventaActualizada = tx.update(COLLECTIONS.VENTAS, venta.id, {
        saldoPendiente: nuevoSaldo,
        importePagado: nuevoPagado,
        estadoCuenta,
        pagos: [...pagosPrevios, abonoRecord],
        ultimaActualizacionPago: ahora
      });

      tx.insert(COLLECTIONS.MOV_CONTABLES, {
        ...(opDocId ? { id: `mc-${opDocId}` } : {}),
        tipo: TIPOS_CONTABLE.INGRESO,
        categoria: "Abonos de cartera",
        concepto: `Abono ${venta.numero} · ${venta.cliente.nombre} (${metodoPago})`,
        monto,
        valor: monto,
        metodoPago,
        afectaCajaFisica: metodoPago === "Efectivo",
        cajaId: metodoPago === "Efectivo" ? cajaAsociadaId : null,
        origen: "Abono venta",
        referenciaId: venta.id,
        abonoId,
        referencia: String(referencia || "").trim() || venta.numero,
        numeroVenta: venta.numero,
        clienteId: venta.cliente.id,
        clienteRelacionado: venta.cliente.nombre,
        estado: "Confirmado",
        idempotencyKey: idempotencyKey || null,
        usuario: user.name || user.email,
        fechaEfectiva: ahora.slice(0, 10),
        fechaRegistro: ahora,
        fecha: ahora
      });

      tx.insert(COLLECTIONS.AUDITORIA, {
        ...(opDocId ? { id: `aud-${opDocId}` } : {}),
        accion: "VENTA_ABONO",
        ventaId: venta.id,
        numeroVenta: venta.numero,
        abonoId,
        clienteId: venta.cliente.id,
        clienteNombre: venta.cliente.nombre,
        importe: monto,
        metodoPago,
        saldoAnterior: saldoActual,
        saldoNuevo: nuevoSaldo,
        usuario: user.name || user.email,
        fecha: ahora
      });

      if (opDocId) {
        tx.upsert(COLLECTIONS.OPERACIONES, opDocId, {
          tipo: "ABONO",
          idempotencyKey,
          ventaId: venta.id,
          abonoId,
          importe: monto,
          usuario: user.name || user.email,
          fecha: ahora
        });
      }

      return { venta: ventaActualizada, abono: abonoRecord };
    },
    {
      lockKey: `abono_${ventaId}`,
      readDocs: readDocsAbono
    }
  );
  } catch (err) {
    if (idempotencyKey) processedIdempotencyKeys.delete(idempotencyKey);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 7. GENERACIÓN DE COMPROBANTE INTERNO DE VENTA (Sección 10)
// ---------------------------------------------------------------------------
export function generarDatosComprobante(venta, devolucionesVenta = null) {
  if (!venta) throw new Error("Venta no encontrada para generar comprobante.");
  const devs = Array.isArray(devolucionesVenta)
    ? devolucionesVenta
    : getCollection(COLLECTIONS.DEVOLUCIONES).filter((d) => d.ventaId === venta.id);
  const totalDevueltoAcumulado = roundCOP(
    venta.totalDevueltoAcumulado ?? devs.reduce((acc, d) => acc + roundCOP(d.totalDevuelto), 0)
  );
  const saldoPendiente = roundCOP(venta.saldoPendiente || 0);
  const anticipoAplicado = roundCOP(venta.anticipoAplicado || 0);
  const importePagado = roundCOP(
    venta.importePagado !== undefined && venta.importePagado !== null
      ? venta.importePagado
      : Math.max(0, roundCOP(venta.total) - saldoPendiente)
  );
  return {
    establecimiento: "Vidrios y Aluminios El Carmen",
    tipoDocumento: "Comprobante interno de venta",
    leyendaLegal: "Documento equivalente de control interno. No constituye factura electrónica de venta validada ante la DIAN.",
    numero: venta.numero,
    fecha: venta.fecha,
    estado: venta.estado,
    estadoCuenta: venta.estadoCuenta || (saldoPendiente > 0 ? "Pendiente" : "Pagada"),
    vendedor: venta.vendedor,
    cliente: venta.cliente || { nombre: "Consumidor Final", documento: "222222222222" },
    ordenReferencia: venta.ordenReferencia || "",
    items: (venta.items || []).map((i) => ({
      ...i,
      esTemporal: Boolean(i.esTemporal),
      codigo: i.codigo || "",
      unidad: i.unidad || "",
      observacion: i.observacion || ""
    })),
    subtotal: venta.subtotal,
    descuento: venta.descuento || 0,
    impuesto: venta.impuesto || 0,
    total: venta.total,
    anticipoAplicado,
    importePagado,
    pagos: venta.pagos || [{ metodo: venta.metodoPago, importe: venta.valorRecibido }],
    valorRecibido: venta.valorRecibido,
    cambio: venta.cambio || 0,
    saldoPendiente,
    devoluciones: devs,
    totalDevueltoAcumulado
  };
}

