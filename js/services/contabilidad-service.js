// Servicio de Contabilidad Básica — Vidrios y Aluminios El Carmen (Secciones 1 a 16).
// Gestiona:
// - Los 4 indicadores financieros superiores (Ingresos, Gastos, Resultado del período, Efectivo en caja y Bancos).
// - Registro de ingresos (Ventas de mostrador, Anticipos de clientes, Abonos de instalaciones, Otros ingresos).
// - Registro de gastos (Servicios públicos, Arriendo, Transporte, Nómina, Mantenimiento, Gastos administrativos, Publicidad, Otros gastos).
// - Traslados internos entre caja y bancos sin distorsionar el resultado del período.
// - Control de anticipos y saldos pendientes de pedidos/instalaciones sin duplicar ingresos.
// - Procedimiento de reversión/ajuste autorizado sin eliminar registros históricos.
// - Informes financieros por período (Hoy, Esta semana, Este mes, Este año, Personalizado) y exportación CSV.

import {
  COLLECTIONS,
  getCollection,
  getDocById,
  subscribeCollection,
  runAtomicTransaction
} from "./store.js";
import { getCurrentUser, assertPermission } from "../auth.js";
import { roundCOP, ordenarMasRecientesPrimero } from "./inventario-service.js";
import { calcularSaldoPendienteVenta } from "./clientes-service.js";

export const TIPOS_CONTABLE = {
  INGRESO: "Ingreso",
  GASTO: "Gasto",
  TRASLADO: "Traslado interno",
  REVERSION: "Reversión",
  DEVOLUCION: "Devolución",
  BILLETERA_REDENCION: "Aplicación saldo a favor"
};

export const CATEGORIAS_INGRESO = [
  "Ventas de mostrador",
  "Anticipos de clientes",
  "Abonos de instalaciones",
  "Abonos de cartera",
  "Otros ingresos"
];

export const CATEGORIAS_GASTO = [
  "Servicios públicos",
  "Arriendo",
  "Transporte",
  "Nómina",
  "Mantenimiento",
  "Gastos administrativos",
  "Publicidad",
  "Otros gastos"
];

export const METODOS_PAGO_CONTABLE = [
  "Efectivo",
  "Transferencia",
  "Nequi",
  "Daviplata"
];

export function listarMovimientosContables() {
  return ordenarMasRecientesPrimero(
    getCollection(COLLECTIONS.MOV_CONTABLES),
    ["fechaRegistro", "fecha"]
  );
}

export function watchMovimientosContables(callback) {
  return subscribeCollection(COLLECTIONS.MOV_CONTABLES, (items) => {
    const sorted = ordenarMasRecientesPrimero(items, ["fechaRegistro", "fecha"]);
    callback(sorted);
  });
}

// Calcula el rango { desde, hasta } en formato YYYY-MM-DD para los períodos predefinidos (Sección 10)
export function obtenerRangoPeriodo(periodo = "todos", { desdeCustom = "", hastaCustom = "" } = {}) {
  const ahora = new Date();
  const hoyIso = ahora.toISOString().slice(0, 10);

  if (periodo === "hoy") {
    return { desde: hoyIso, hasta: hoyIso };
  }
  if (periodo === "semana") {
    const diaSemana = ahora.getDay(); // 0 domingo ... 6 sábado
    const diffLunes = diaSemana === 0 ? -6 : 1 - diaSemana;
    const lunes = new Date(ahora);
    lunes.setDate(ahora.getDate() + diffLunes);
    return { desde: lunes.toISOString().slice(0, 10), hasta: hoyIso };
  }
  if (periodo === "mes") {
    const inicioMes = `${hoyIso.slice(0, 7)}-01`;
    return { desde: inicioMes, hasta: hoyIso };
  }
  if (periodo === "anio") {
    const inicioAnio = `${hoyIso.slice(0, 4)}-01-01`;
    return { desde: inicioAnio, hasta: hoyIso };
  }
  if (periodo === "personalizado") {
    return { desde: desdeCustom || "", hasta: hastaCustom || "" };
  }
  return { desde: "", hasta: "" };
}

export function fechaEnRango(mov, { desde = "", hasta = "" } = {}) {
  const rawFecha = mov.fechaEfectiva || String(mov.fecha || "").slice(0, 10);
  if (!rawFecha) return true;
  const f = rawFecha.slice(0, 10);
  if (desde && f < desde) return false;
  if (hasta && f > hasta) return false;
  return true;
}

// Filtra movimientos contables según todos los criterios de la Sección 9
export function filtrarMovimientosContables(
  movimientosOrFiltros = listarMovimientosContables(),
  filtrosArg = {}
) {
  const esLista = Array.isArray(movimientosOrFiltros);
  const movimientos = esLista ? movimientosOrFiltros : listarMovimientosContables();
  const {
    tipo = "Todos",
    metodoPago = "Todos",
    categoria = "Todas",
    usuario = "Todos",
    estado = "Todos",
    desde = "",
    hasta = "",
    fechaDesde = "",
    fechaHasta = "",
    busqueda = ""
  } = esLista ? filtrosArg : movimientosOrFiltros || {};

  const fDesde = desde || fechaDesde || "";
  const fHasta = hasta || fechaHasta || "";
  const q = String(busqueda || "").trim().toLowerCase();
  const usrFiltro = String(usuario || "Todos").trim().toLowerCase();

  return movimientos.filter((m) => {
    if (tipo === "Ingresos" || tipo === TIPOS_CONTABLE.INGRESO) {
      if (m.tipo !== TIPOS_CONTABLE.INGRESO) return false;
    } else if (tipo === "Gastos" || tipo === TIPOS_CONTABLE.GASTO) {
      if (m.tipo !== TIPOS_CONTABLE.GASTO) return false;
    } else if (tipo === TIPOS_CONTABLE.TRASLADO) {
      if (m.tipo !== TIPOS_CONTABLE.TRASLADO) return false;
    }

    if (metodoPago !== "Todos") {
      const mMetodo = m.metodoPago || "Efectivo";
      const esFiltroTransf = ["Transferencia", "Transferencia bancaria", "Transferencias"].includes(metodoPago);
      const esMovTransf = ["Transferencia", "Transferencia bancaria"].includes(mMetodo);
      const esFiltroTdc = ["Tarjeta crédito", "Tarjeta de crédito"].includes(metodoPago);
      const esMovTdc = ["Tarjeta crédito", "Tarjeta de crédito"].includes(mMetodo);
      if (esFiltroTransf) {
        if (!esMovTransf) return false;
      } else if (esFiltroTdc) {
        if (!esMovTdc) return false;
      } else if (mMetodo !== metodoPago) {
        return false;
      }
    }

    if (categoria !== "Todas" && categoria !== "Todos") {
      const mCat = m.categoria || "";
      const equivalencias = [
        ["Venta", "Ventas de mostrador"],
        ["Anticipo de cliente", "Anticipos de clientes"],
        ["Abono de instalación", "Abonos de instalaciones"]
      ];
      const grupo = equivalencias.find((par) => par.includes(categoria));
      if (grupo) {
        if (!grupo.includes(mCat)) return false;
      } else if (mCat !== categoria) {
        return false;
      }
    }

    if (usrFiltro !== "todos" && usrFiltro !== "") {
      if (!String(m.usuario || m.responsable || "").toLowerCase().includes(usrFiltro)) {
        return false;
      }
    }

    const estadoActual = m.anulado || m.estado === "Revertido" ? "Revertido" : m.estado || "Confirmado";
    if (estado !== "Todos" && estadoActual !== estado) {
      return false;
    }

    if (!fechaEnRango(m, { desde: fDesde, hasta: fHasta })) {
      return false;
    }

    if (q) {
      const texto = [
        m.concepto,
        m.categoria,
        m.referencia,
        m.soporteReferencia,
        m.numeroVenta,
        m.clienteRelacionado,
        m.proveedor,
        m.pedidoRelacionado,
        m.id
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!texto.includes(q)) return false;
    }

    return true;
  });
}

export function normalizarCuentaContable(cuenta) {
  const c = String(cuenta || "").trim();
  if (!c || c === "Efectivo" || c === "Caja física") return "Caja física";
  if (c === "Nequi") return "Nequi";
  if (c === "Daviplata") return "Daviplata";
  if (
    c === "Cuenta bancaria" ||
    c === "Transferencia" ||
    c === "Transferencia bancaria" ||
    c.startsWith("Tarjeta")
  ) {
    return "Transferencia bancaria";
  }
  return "Transferencia bancaria";
}

export const SALDOS_INICIALES_DOC_ID = "saldos_iniciales_cuentas";

export function obtenerSaldosInicialesCuentas() {
  const doc = getDocById(COLLECTIONS.CONTROL, SALDOS_INICIALES_DOC_ID);
  return {
    transferencia: roundCOP(doc?.transferencia || 0),
    nequi: roundCOP(doc?.nequi || 0),
    daviplata: roundCOP(doc?.daviplata || 0),
    caja: roundCOP(doc?.caja || 0),
    actualizadoEn: doc?.actualizadoEn || null,
    actualizadoPor: doc?.actualizadoPor || null
  };
}

export function watchSaldosInicialesCuentas(callback) {
  return subscribeCollection(COLLECTIONS.CONTROL, () => {
    callback(obtenerSaldosInicialesCuentas());
  });
}

export async function guardarSaldosInicialesCuentas(
  { transferencia = 0, nequi = 0, daviplata = 0, caja = 0 } = {},
  user = getCurrentUser()
) {
  assertPermission("contabilidad.gestionar", user);
  const t = roundCOP(transferencia || 0);
  const n = roundCOP(nequi || 0);
  const d = roundCOP(daviplata || 0);
  const c = roundCOP(caja || 0);
  if (t < 0 || n < 0 || d < 0 || c < 0) {
    throw new Error("Los saldos iniciales de las cuentas no pueden ser negativos.");
  }

  return runAtomicTransaction(
    async (tx) => {
      const ahora = new Date().toISOString();
      const actualizado = tx.upsert(COLLECTIONS.CONTROL, SALDOS_INICIALES_DOC_ID, {
        transferencia: t,
        nequi: n,
        daviplata: d,
        caja: c,
        actualizadoEn: ahora,
        actualizadoPor: user.name || user.email
      });

      tx.insert(COLLECTIONS.AUDITORIA, {
        accion: "CONTABLE_SALDOS_INICIALES",
        transferencia: t,
        nequi: n,
        daviplata: d,
        caja: c,
        usuario: user.name || user.email,
        fecha: ahora
      });

      return actualizado;
    },
    { readDocs: [{ collection: COLLECTIONS.CONTROL, id: SALDOS_INICIALES_DOC_ID }] }
  );
}

// Calcula los 4 indicadores financieros principales y los saldos de efectivo, bancos y cuentas por cobrar (Sección 3 y 11)
export function calcularResumenContable(
  movimientos = listarMovimientosContables(),
  { cajas = null, ventas = null, ventasDelPeriodo = null, productos = null, saldosIniciales = null } = {}
) {
  let recaudos = 0;
  let gastos = 0;
  let totalDevoluciones = 0;
  let totalReembolsos = 0;
  let saldoAFavorGenerado = 0;
  let saldoAFavorRedimido = 0;
  let gastosOperativos = 0;
  let comprasInventario = 0;
  let ingresosEfectivo = 0;
  let ingresosBancos = 0;
  let gastosEfectivo = 0;
  let gastosBancos = 0;
  let devolucionesEfectivo = 0;
  let devolucionesBancos = 0;
  let trasladosACaja = 0;
  let trasladosDesdeCaja = 0;
  let trasladosABancos = 0;
  let trasladosDesdeBancos = 0;
  let porPagar = 0;
  let countIngresos = 0;
  let countGastos = 0;
  let countPorPagar = 0;
  let movimientosBancariosCount = 0;
  let ultimoIngreso = null;
  let ultimoGasto = null;

  const saldosPorCuenta = {
    "Caja física": 0,
    "Transferencia bancaria": 0,
    Nequi: 0,
    Daviplata: 0
  };

  const listaVentas = ventas || getCollection(COLLECTIONS.VENTAS);
  const ventasById = new Map();
  const ventasByNumero = new Map();
  for (const v of listaVentas) {
    if (v.id) ventasById.set(v.id, v);
    if (v.numero) ventasByNumero.set(String(v.numero).toUpperCase(), v);
  }

  const ordenados = ordenarMasRecientesPrimero(movimientos, ["fechaRegistro", "fecha"]);

  for (const m of ordenados) {
    if (m.anulado || m.estado === "Revertido" || m.tipo === TIPOS_CONTABLE.REVERSION) {
      continue;
    }

    let monto = roundCOP(m.valor ?? m.monto);
    // Saneamiento automático de registros históricos Venta POS que guardaron el billete sin restar el cambio
    if (m.origen === "Venta POS" && m.tipo === TIPOS_CONTABLE.INGRESO) {
      const vAsoc =
        (m.referenciaId && ventasById.get(m.referenciaId)) ||
        (m.numeroVenta && ventasByNumero.get(String(m.numeroVenta).toUpperCase()));
      if (vAsoc && monto > roundCOP(vAsoc.total || 0)) {
        const netoRealVenta = Math.max(0, roundCOP(vAsoc.total || 0) - calcularSaldoPendienteVenta(vAsoc));
        monto = Math.min(monto, netoRealVenta);
      }
    }

    const metodo = m.metodoPago || "Efectivo";
    const esEfectivo = metodo === "Efectivo";
    const cuenta = normalizarCuentaContable(metodo);

    if (m.tipo === TIPOS_CONTABLE.TRASLADO) {
      // Un traslado interno entre cuentas propias NO es ingreso ni gasto (Sección 6)
      movimientosBancariosCount++;
      const cOrigen = normalizarCuentaContable(m.cuentaOrigen || "Caja física");
      const cDestino = normalizarCuentaContable(m.cuentaDestino || "Transferencia bancaria");
      if (cOrigen in saldosPorCuenta) saldosPorCuenta[cOrigen] = roundCOP(saldosPorCuenta[cOrigen] - monto);
      if (cDestino in saldosPorCuenta) saldosPorCuenta[cDestino] = roundCOP(saldosPorCuenta[cDestino] + monto);

      if (cOrigen === "Caja física") trasladosDesdeCaja += monto;
      else trasladosDesdeBancos += monto;

      if (cDestino === "Caja física") trasladosACaja += monto;
      else trasladosABancos += monto;
      continue;
    }

    if (m.tipo === TIPOS_CONTABLE.DEVOLUCION) {
      const montoDev = roundCOP(m.valor ?? m.monto);
      const reembolsoReal = roundCOP(m.montoReembolsado ?? 0);
      totalDevoluciones += montoDev;
      totalReembolsos += reembolsoReal;
      saldoAFavorGenerado += roundCOP(m.saldoAFavorGenerado ?? 0);
      if (reembolsoReal > 0 && metodo !== "Saldo a favor" && metodo !== "Ajuste / Nota crédito") {
        gastos = roundCOP(gastos + reembolsoReal);
        if (esEfectivo || m.afectaCajaFisica) {
          devolucionesEfectivo = roundCOP(devolucionesEfectivo + reembolsoReal);
          saldosPorCuenta["Caja física"] = roundCOP(saldosPorCuenta["Caja física"] - reembolsoReal);
        } else {
          devolucionesBancos = roundCOP(devolucionesBancos + reembolsoReal);
          if (cuenta in saldosPorCuenta) {
            saldosPorCuenta[cuenta] = roundCOP(saldosPorCuenta[cuenta] - reembolsoReal);
          }
          movimientosBancariosCount++;
        }
      }
      continue;
    }

    if (m.tipo === TIPOS_CONTABLE.BILLETERA_REDENCION || metodo === "Saldo a favor") {
      // Redención de saldo a favor: aplica obligación existente sin crear ingreso de efectivo ni bancos
      saldoAFavorRedimido += monto;
      continue;
    }

    if (m.tipo === TIPOS_CONTABLE.INGRESO) {
      recaudos += monto;
      if (esEfectivo) {
        ingresosEfectivo += monto;
        saldosPorCuenta["Caja física"] = roundCOP(saldosPorCuenta["Caja física"] + monto);
      } else {
        ingresosBancos += monto;
        if (cuenta in saldosPorCuenta) {
          saldosPorCuenta[cuenta] = roundCOP(saldosPorCuenta[cuenta] + monto);
        }
        movimientosBancariosCount++;
      }
      countIngresos++;
      if (!ultimoIngreso) ultimoIngreso = m;
    } else if (m.tipo === TIPOS_CONTABLE.GASTO) {
      const esPendienteOParcial =
        m.estadoPago === "Pendiente" || m.estadoPago === "Parcial" || m.estado === "Por pagar";
      if (esPendienteOParcial) {
        const saldoPend = roundCOP(
          m.saldoPendiente ?? Math.max(0, roundCOP(monto - (m.montoPagado || 0)))
        );
        porPagar = roundCOP(porPagar + saldoPend);
        countPorPagar++;
        continue;
      }
      // Si el gasto nació como obligación por pagar y ya fue liquidado con abonos independientes,
      // evitar duplicar el monto porque cada abono ya es un movimiento propio en MOV_CONTABLES.
      const fueLiquidadaConAbonos =
        Boolean(m.esObligacionPorPagar) ||
        (Array.isArray(m.pagos) && m.pagos.length > 0 && m.origen !== "Abono cuenta por pagar");
      if (fueLiquidadaConAbonos) {
        continue;
      }
      gastos += monto;
      if (m.categoria === "Compra de mercancía" || m.origen === "Compra de inventario") {
        comprasInventario += monto;
      } else {
        gastosOperativos += monto;
      }
      if (esEfectivo) {
        gastosEfectivo += monto;
        saldosPorCuenta["Caja física"] = roundCOP(saldosPorCuenta["Caja física"] - monto);
      } else {
        gastosBancos += monto;
        if (cuenta in saldosPorCuenta) {
          saldosPorCuenta[cuenta] = roundCOP(saldosPorCuenta[cuenta] - monto);
        }
        movimientosBancariosCount++;
      }
      countGastos++;
      if (!ultimoGasto) ultimoGasto = m;
    }
  }

  const saldosInit = saldosIniciales || obtenerSaldosInicialesCuentas();
  const listaCajas = cajas !== null ? cajas : getCollection(COLLECTIONS.CAJAS);
  const cajaAbierta = (listaCajas || []).find((c) => c.estado === "Abierta");
  const baseCaja = cajaAbierta
    ? roundCOP(cajaAbierta.montoInicial ?? cajaAbierta.baseInicial ?? 0)
    : roundCOP(saldosInit.caja || 0);
  saldosPorCuenta["Caja física"] = roundCOP(baseCaja + saldosPorCuenta["Caja física"]);
  saldosPorCuenta["Transferencia bancaria"] = roundCOP(
    roundCOP(saldosInit.transferencia || 0) + saldosPorCuenta["Transferencia bancaria"]
  );
  saldosPorCuenta.Nequi = roundCOP(roundCOP(saldosInit.nequi || 0) + saldosPorCuenta.Nequi);
  saldosPorCuenta.Daviplata = roundCOP(
    roundCOP(saldosInit.daviplata || 0) + saldosPorCuenta.Daviplata
  );

  const disponibleCaja = roundCOP(saldosPorCuenta["Caja física"]);
  const disponibleBancos = roundCOP(
    saldosPorCuenta["Transferencia bancaria"] + saldosPorCuenta.Nequi + saldosPorCuenta.Daviplata
  );
  const disponibleTotal = roundCOP(disponibleCaja + disponibleBancos);
  const saldoBancos = disponibleBancos;
  const tieneDatosBancarios =
    movimientosBancariosCount > 0 ||
    roundCOP(saldosInit.transferencia || 0) > 0 ||
    roundCOP(saldosInit.nequi || 0) > 0 ||
    roundCOP(saldosInit.daviplata || 0) > 0;

  // Calcular cuentas por cobrar (ventas activas con saldo pendiente + pedidos con anticipo pendiente)
  const saldoVentasCredito = listaVentas
    .filter((v) => v.estado !== "Anulada" && calcularSaldoPendienteVenta(v) > 0)
    .reduce((acc, v) => acc + calcularSaldoPendienteVenta(v), 0);

  // Pedidos con anticipo cuyo saldo pendiente aún no se ha facturado en una venta
  const pedidosMap = new Map();
  for (const m of ordenados) {
    if (
      !m.anulado &&
      m.estado !== "Revertido" &&
      m.tipo === TIPOS_CONTABLE.INGRESO &&
      m.pedidoRelacionado &&
      !m.aplicadoEnVentaId &&
      roundCOP(m.totalPedido || 0) > 0
    ) {
      const key = String(m.pedidoRelacionado).trim().toLowerCase();
      const prev = pedidosMap.get(key) || { totalPedido: roundCOP(m.totalPedido), abonado: 0 };
      prev.totalPedido = Math.max(prev.totalPedido, roundCOP(m.totalPedido));
      prev.abonado = roundCOP(prev.abonado + roundCOP(m.valor ?? m.monto));
      pedidosMap.set(key, prev);
    }
  }
  let saldoPedidosPendientes = 0;
  for (const p of pedidosMap.values()) {
    saldoPedidosPendientes += Math.max(0, roundCOP(p.totalPedido - p.abonado));
  }

  const porCobrar = roundCOP(saldoVentasCredito + saldoPedidosPendientes);

  // Separar Ventas Netas, Costo de Ventas Estimado, Flujo Neto de Efectivo y Utilidad Operativa Estimada
  const listaProductos = productos || getCollection(COLLECTIONS.PRODUCTOS);
  const productosById = new Map();
  for (const p of listaProductos) {
    if (p.id) productosById.set(p.id, p);
  }
  const ventasAnalizadas = Array.isArray(ventasDelPeriodo) ? ventasDelPeriodo : listaVentas;
  const ventasActivas = ventasAnalizadas.filter((v) => v.estado !== "Anulada");
  let ventasNetas = 0;
  let costoVentasEstimado = 0;
  for (const v of ventasActivas) {
    const totV = roundCOP(v.total || 0);
    const devV = roundCOP(v.totalDevueltoAcumulado || 0);
    const netaV = Math.max(0, roundCOP(totV - devV));
    ventasNetas = roundCOP(ventasNetas + netaV);
    const factorV = totV > 0 ? netaV / totV : 0;
    let costoVentaItems = 0;
    for (const item of v.items || []) {
      if (item.esTemporal || !item.productoId) continue;
      const prod = productosById.get(item.productoId);
      const costoUnit = roundCOP(item.precioCompra ?? prod?.precioCompra ?? 0);
      costoVentaItems = roundCOP(costoVentaItems + roundCOP(costoUnit * (Number(item.cantidad) || 0)));
    }
    costoVentasEstimado = roundCOP(costoVentasEstimado + roundCOP(costoVentaItems * factorV));
  }

  const flujoNetoEfectivo = roundCOP(recaudos - gastos);
  const utilidadOperativaEstimada = roundCOP(ventasNetas - costoVentasEstimado - gastosOperativos);

  return {
    ingresos: roundCOP(recaudos),
    recaudos: roundCOP(recaudos),
    ventasNetas: roundCOP(ventasNetas),
    costoVentasEstimado: roundCOP(costoVentasEstimado),
    flujoNetoEfectivo,
    utilidadOperativaEstimada,
    gastos: roundCOP(gastos),
    totalDevoluciones: roundCOP(totalDevoluciones),
    totalReembolsos: roundCOP(totalReembolsos),
    gastosOperativos: roundCOP(gastosOperativos),
    comprasInventario: roundCOP(comprasInventario),
    balance: flujoNetoEfectivo,
    resultadoPeriodo: flujoNetoEfectivo,
    ingresosEfectivo: roundCOP(ingresosEfectivo),
    ingresosBancos: roundCOP(ingresosBancos),
    gastosEfectivo: roundCOP(gastosEfectivo),
    gastosBancos: roundCOP(gastosBancos),
    devolucionesEfectivo: roundCOP(devolucionesEfectivo),
    devolucionesBancos: roundCOP(devolucionesBancos),
    trasladosACaja: roundCOP(trasladosACaja),
    trasladosABancos: roundCOP(trasladosABancos),
    disponibleTotal,
    disponibleCaja,
    disponibleBancos,
    saldosPorCuenta,
    saldoBancos,
    tieneDatosBancarios,
    movimientosBancariosCount,
    porCobrar,
    cuentasPorCobrar: porCobrar,
    porPagar: roundCOP(porPagar),
    countPorPagar,
    countIngresos,
    countGastos,
    totalMovimientos: countIngresos + countGastos,
    saldoAFavorGenerado: roundCOP(saldoAFavorGenerado),
    saldoAFavorRedimido: roundCOP(saldoAFavorRedimido),
    ultimoIngreso,
    ultimoGasto
  };
}

// Genera el informe financiero detallado para la Sección 10 (por período seleccionado)
export function generarInformeFinancieroContable(
  movimientosOrOpts = listarMovimientosContables(),
  optsArg = {}
) {
  const esLista = Array.isArray(movimientosOrOpts);
  const movimientos = esLista ? movimientosOrOpts : listarMovimientosContables();
  const {
    periodo = "todos",
    desde = "",
    hasta = "",
    ventas = null,
    cajas = null,
    productos = null
  } = esLista ? optsArg : movimientosOrOpts || {};

  const rango =
    periodo === "personalizado"
      ? { desde, hasta }
      : obtenerRangoPeriodo(periodo, { desdeCustom: desde, hastaCustom: hasta });

  const movsPeriodo = filtrarMovimientosContables(movimientos, {
    desde: rango.desde,
    hasta: rango.hasta
  }).filter((m) => !m.anulado && m.estado !== "Revertido" && m.tipo !== TIPOS_CONTABLE.REVERSION);

  const listaVentas = ventas || getCollection(COLLECTIONS.VENTAS);
  const ventasPeriodo = listaVentas.filter((v) =>
    fechaEnRango({ fecha: v.fecha }, { desde: rango.desde, hasta: rango.hasta })
  );

  const resumenPeriodo = calcularResumenContable(movsPeriodo, {
    cajas,
    ventas: listaVentas,
    ventasDelPeriodo: ventasPeriodo,
    productos
  });

  // Los saldos disponibles acumulados deben calcularse con el historial hasta la fecha de corte (rango.hasta)
  const movsHastaCorte = filtrarMovimientosContables(movimientos, {
    hasta: rango.hasta
  }).filter((m) => !m.anulado && m.estado !== "Revertido" && m.tipo !== TIPOS_CONTABLE.REVERSION);
  const resumenAcumulado = calcularResumenContable(movsHastaCorte, {
    cajas,
    ventas: listaVentas,
    productos
  });

  const resumen = {
    ...resumenPeriodo,
    disponibleTotal: resumenAcumulado.disponibleTotal,
    disponibleCaja: resumenAcumulado.disponibleCaja,
    disponibleBancos: resumenAcumulado.disponibleBancos,
    saldosPorCuenta: resumenAcumulado.saldosPorCuenta,
    saldoBancos: resumenAcumulado.saldoBancos,
    porCobrar: resumenAcumulado.porCobrar,
    cuentasPorCobrar: resumenAcumulado.cuentasPorCobrar,
    porPagar: resumenAcumulado.porPagar
  };

  const agrupar = (lista, campoClave) => {
    const mapa = new Map();
    const totalBase = lista.reduce((s, x) => s + roundCOP(x.valor ?? x.monto), 0);
    for (const item of lista) {
      const k = item[campoClave] || "Sin clasificar";
      const prev = mapa.get(k) || { nombre: k, movimientos: 0, total: 0, porcentaje: 0 };
      prev.movimientos += 1;
      prev.total = roundCOP(prev.total + roundCOP(item.valor ?? item.monto));
      mapa.set(k, prev);
    }
    return [...mapa.values()]
      .map((g) => ({
        ...g,
        porcentaje: totalBase > 0 ? Math.round((g.total / totalBase) * 100) : 0
      }))
      .sort((a, b) => b.total - a.total);
  };

  const listaIngresos = movsPeriodo.filter((m) => m.tipo === TIPOS_CONTABLE.INGRESO);
  const listaGastos = movsPeriodo.filter((m) => m.tipo === TIPOS_CONTABLE.GASTO);

  const coincideMetodo = (mMetodo, metodoObjetivo) => {
    const actual = mMetodo || "Efectivo";
    if (metodoObjetivo === "Transferencia" || metodoObjetivo === "Transferencia bancaria") {
      return actual === "Transferencia" || actual === "Transferencia bancaria";
    }
    if (metodoObjetivo === "Tarjeta crédito" || metodoObjetivo === "Tarjeta de crédito") {
      return actual === "Tarjeta crédito" || actual === "Tarjeta de crédito";
    }
    return actual === metodoObjetivo;
  };

  const porMetodoPago = METODOS_PAGO_CONTABLE.map((metodo) => {
    const ing = listaIngresos
      .filter((m) => coincideMetodo(m.metodoPago, metodo))
      .reduce((acc, m) => acc + roundCOP(m.valor ?? m.monto), 0);
    const gas = listaGastos
      .filter((m) => coincideMetodo(m.metodoPago, metodo))
      .reduce((acc, m) => acc + roundCOP(m.valor ?? m.monto), 0);
    return {
      metodo,
      ingresos: roundCOP(ing),
      gastos: roundCOP(gas),
      neto: roundCOP(ing - gas)
    };
  });

  // Evolución diaria de ingresos y gastos
  const mapaDias = new Map();
  for (const m of movsPeriodo) {
    if (m.tipo !== TIPOS_CONTABLE.INGRESO && m.tipo !== TIPOS_CONTABLE.GASTO) continue;
    const dia = m.fechaEfectiva || String(m.fecha || "").slice(0, 10) || "Sin fecha";
    const prev = mapaDias.get(dia) || { fecha: dia, ingresos: 0, gastos: 0, resultado: 0 };
    const val = roundCOP(m.valor ?? m.monto);
    if (m.tipo === TIPOS_CONTABLE.INGRESO) prev.ingresos = roundCOP(prev.ingresos + val);
    else prev.gastos = roundCOP(prev.gastos + val);
    prev.resultado = roundCOP(prev.ingresos - prev.gastos);
    mapaDias.set(dia, prev);
  }
  const evolucionDiaria = [...mapaDias.values()].sort((a, b) => b.fecha.localeCompare(a.fecha));

  return {
    rango,
    resumen,
    ingresosPorCategoria: agrupar(listaIngresos, "categoria"),
    gastosPorCategoria: agrupar(listaGastos, "categoria"),
    ingresosPorMetodo: agrupar(listaIngresos, "metodoPago"),
    gastosPorMetodo: agrupar(listaGastos, "metodoPago"),
    porMetodoPago,
    evolucionDiaria,
    movimientos: movsPeriodo
  };
}

// Registra un ingreso o un gasto validando todas las reglas de las Secciones 4, 5, 6, 7, 8, 11 y 12
export async function registrarMovimientoContable(
  {
    tipo,
    categoria,
    concepto,
    monto,
    valor,
    fecha,
    fechaEfectiva,
    metodoPago = "Efectivo",
    clienteRelacionado = "",
    pedidoRelacionado = "",
    totalPedido = 0,
    proveedor = "",
    referencia = "",
    soporteReferencia = "",
    nota = "",
    observaciones = "",
    afectaCajaFisica = false,
    cajaId = null,
    estadoPago = "Pagado",
    fechaVencimiento = "",
    idempotencyKey = null
  },
  user = getCurrentUser()
) {
  assertPermission("contabilidad.gestionar", user);

  if (![TIPOS_CONTABLE.INGRESO, TIPOS_CONTABLE.GASTO].includes(tipo)) {
    throw new Error("El tipo de movimiento debe ser Ingreso o Gasto.");
  }

  const importeRaw = valor !== undefined && valor !== "" ? valor : monto;
  const importe = roundCOP(importeRaw);
  if (!Number.isFinite(Number(importeRaw)) || !(importe > 0)) {
    throw new Error("El valor del movimiento debe ser numérico y mayor que cero.");
  }

  const conc = String(concepto || "").trim();
  if (!conc) {
    throw new Error("El concepto del movimiento es obligatorio.");
  }

  const refLimpia = String(referencia || soporteReferencia || "").trim();
  const obsLimpia = String(observaciones || nota || "").trim();
  const clienteLimpio = String(clienteRelacionado || "").trim();
  const pedidoLimpio = String(pedidoRelacionado || "").trim();
  const proveedorLimpio = String(proveedor || "").trim();
  const totalPedidoNum = roundCOP(totalPedido || 0);

  return runAtomicTransaction(async (tx) => {
    const existentes = tx.getAll(COLLECTIONS.MOV_CONTABLES);
    const ventasExistentes = tx.getAll(COLLECTIONS.VENTAS);

    // 1. Prevenir duplicidad por idempotencyKey
    if (idempotencyKey && existentes.some((m) => m.idempotencyKey === idempotencyKey)) {
      throw new Error("Este movimiento financiero ya fue registrado.");
    }

    // 2. No permitir registrar manualmente una segunda vez una venta que ya se registró en Caja y Ventas (Sección 4 y 7)
    if (tipo === TIPOS_CONTABLE.INGRESO && refLimpia) {
      const ventaYaRegistrada = ventasExistentes.find(
        (v) =>
          v.estado !== "Anulada" &&
          (String(v.numero || "").toUpperCase() === refLimpia.toUpperCase() || v.id === refLimpia)
      );
      if (ventaYaRegistrada) {
        throw new Error(
          `La venta ${ventaYaRegistrada.numero} ya fue registrada automáticamente desde Caja y Ventas. No se permite duplicar su ingreso en Contabilidad.`
        );
      }
    }

    // 3. Evitar duplicar exactamente un mismo movimiento con la misma referencia no vacía, tipo y monto
    if (refLimpia) {
      const duplicadoRef = existentes.find(
        (m) =>
          !m.anulado &&
          m.estado !== "Revertido" &&
          m.tipo === tipo &&
          String(m.referencia || m.soporteReferencia || "").toLowerCase() === refLimpia.toLowerCase() &&
          roundCOP(m.valor ?? m.monto) === importe
      );
      if (duplicadoRef) {
        throw new Error(
          `Ya existe un ${tipo.toLowerCase()} confirmado con la referencia "${refLimpia}" por el mismo valor (registro duplicado).`
        );
      }
    }

    // 4. Control de anticipos y abonos de pedidos/instalaciones (Sección 4 y 7)
    let saldoPendientePedido = 0;
    if (
      tipo === TIPOS_CONTABLE.INGRESO &&
      pedidoLimpio &&
      (categoria === "Anticipo de cliente" ||
        categoria === "Anticipos de clientes" ||
        categoria === "Abono de instalación" ||
        categoria === "Abonos de instalaciones" ||
        totalPedidoNum > 0)
    ) {
      const abonosPrevios = existentes.filter(
        (m) =>
          !m.anulado &&
          m.estado !== "Revertido" &&
          m.tipo === TIPOS_CONTABLE.INGRESO &&
          String(m.pedidoRelacionado || "").trim().toLowerCase() === pedidoLimpio.toLowerCase()
      );
      const sumaPrevios = abonosPrevios.reduce((acc, m) => acc + roundCOP(m.valor ?? m.monto), 0);
      const maxTotalPedido = Math.max(
        totalPedidoNum,
        ...abonosPrevios.map((m) => roundCOP(m.totalPedido || 0))
      );

      if (maxTotalPedido > 0) {
        if (sumaPrevios + importe > maxTotalPedido) {
          throw new Error(
            `El abono ($ ${importe.toLocaleString("es-CO")}) supera el saldo pendiente del pedido "${pedidoLimpio}" ($ ${(maxTotalPedido - sumaPrevios).toLocaleString("es-CO")}).`
          );
        }
        saldoPendientePedido = roundCOP(maxTotalPedido - (sumaPrevios + importe));
      }
    }

    const ahora = new Date().toISOString();
    const fechaMovRaw = String(fechaEfectiva || fecha || ahora.slice(0, 10)).trim();
    const fechaEfectivaStr = fechaMovRaw.slice(0, 10);
    const fechaIso =
      fechaMovRaw.length === 10 ? `${fechaEfectivaStr}T${ahora.slice(11)}` : new Date(fechaMovRaw).toISOString();

    // 5. Regla estricta Efectivo vs. Transferencia/Tarjeta (Sección 5, 6 y 11):
    // Las transferencias y tarjetas NUNCA modifican el efectivo físico de la caja.
    // Los gastos marcados como "Pendiente" (Cuenta por pagar) tampoco salen de caja/banco hasta ser pagados.
    const esPorPagar = tipo === TIPOS_CONTABLE.GASTO && estadoPago === "Pendiente";
    const esEfectivo = metodoPago === "Efectivo";
    const debeAfectarCaja = Boolean(!esPorPagar && afectaCajaFisica && esEfectivo);
    let cajaAsociadaId = null;

    if (debeAfectarCaja) {
      const cajas = tx.getAll(COLLECTIONS.CAJAS);
      const abierta = cajaId
        ? cajas.find((c) => c.id === cajaId)
        : cajas.find((c) => c.estado === "Abierta");

      if (!abierta || abierta.estado !== "Abierta") {
        throw new Error(
          "No se puede afectar el efectivo físico porque no hay una caja abierta (o la caja indicada está cerrada)."
        );
      }

      cajaAsociadaId = abierta.id;
      const movCaja = {
        id: `mc-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        tipo: tipo === TIPOS_CONTABLE.INGRESO ? "Entrada" : "Salida",
        monto: importe,
        concepto: `${categoria || tipo}: ${conc}`,
        usuario: user.name || user.email,
        fecha: fechaIso
      };
      const lista = Array.isArray(abierta.movimientosEfectivoExtra)
        ? [...abierta.movimientosEfectivoExtra, movCaja]
        : [movCaja];
      tx.update(COLLECTIONS.CAJAS, abierta.id, { movimientosEfectivoExtra: lista });
    }

    const catFinal =
      categoria ||
      (tipo === TIPOS_CONTABLE.INGRESO ? "Otros ingresos" : "Otros gastos");

    const nuevo = tx.insert(COLLECTIONS.MOV_CONTABLES, {
      tipo,
      categoria: catFinal,
      concepto: conc,
      monto: importe,
      valor: importe,
      fechaEfectiva: fechaEfectivaStr,
      fechaRegistro: ahora,
      fecha: fechaIso,
      metodoPago,
      cuentaOrigen:
        tipo === TIPOS_CONTABLE.GASTO
          ? esEfectivo
            ? "Caja física"
            : "Cuenta bancaria"
          : clienteLimpio || "Externo",
      cuentaDestino:
        tipo === TIPOS_CONTABLE.INGRESO
          ? esEfectivo
            ? "Caja física"
            : "Cuenta bancaria"
          : proveedorLimpio || "Externo",
      afectaCajaFisica: Boolean(debeAfectarCaja && cajaAsociadaId),
      cajaId: cajaAsociadaId,
      clienteRelacionado: clienteLimpio,
      pedidoRelacionado: pedidoLimpio,
      totalPedido: totalPedidoNum,
      saldoPendientePedido,
      proveedor: proveedorLimpio,
      referencia: refLimpia,
      soporteReferencia: refLimpia,
      origen: "Manual",
      referenciaId: null,
      nota: obsLimpia,
      observaciones: obsLimpia,
      responsable: user.name || user.email,
      usuario: user.name || user.email,
      estadoPago: esPorPagar ? "Pendiente" : "Pagado",
      estado: esPorPagar ? "Por pagar" : "Confirmado",
      ...(esPorPagar
        ? {
            esObligacionPorPagar: true,
            fechaVencimiento: String(fechaVencimiento || "").trim().slice(0, 10),
            montoPagado: 0,
            saldoPendiente: importe,
            pagos: []
          }
        : {}),
      anulado: false,
      idempotencyKey
    });

    tx.insert(COLLECTIONS.AUDITORIA, {
      accion: `CONTABLE_${tipo.toUpperCase()}`,
      movimientoId: nuevo.id,
      categoria: nuevo.categoria,
      concepto: nuevo.concepto,
      monto: nuevo.monto,
      metodoPago: nuevo.metodoPago,
      afectaCajaFisica: nuevo.afectaCajaFisica,
      usuario: user.name || user.email,
      fecha: ahora
    });

    return nuevo;
  });
}

// Registra un traslado interno entre Caja física y Cuenta bancaria sin contarlo como ingreso ni gasto (Sección 6)
export async function registrarTrasladoInterno(
  {
    cuentaOrigen = "Caja física",
    cuentaDestino = "Cuenta bancaria",
    monto,
    fecha,
    referencia = "",
    observaciones = "",
    afectaCajaFisica = true
  },
  user = getCurrentUser()
) {
  assertPermission("contabilidad.gestionar", user);
  const importe = roundCOP(monto);
  if (!(importe > 0)) {
    throw new Error("El valor del traslado interno debe ser mayor que cero.");
  }
  if (cuentaOrigen === cuentaDestino) {
    throw new Error("La cuenta de origen y la cuenta de destino deben ser diferentes.");
  }

  return runAtomicTransaction(async (tx) => {
    const ahora = new Date().toISOString();
    const fechaEfectivaStr = String(fecha || ahora.slice(0, 10)).slice(0, 10);
    let cajaAsociadaId = null;

    if (afectaCajaFisica && (cuentaOrigen === "Caja física" || cuentaDestino === "Caja física")) {
      const abierta = tx.getAll(COLLECTIONS.CAJAS).find((c) => c.estado === "Abierta");
      if (!abierta) {
        throw new Error("Debes tener una caja abierta para trasladar efectivo físico desde o hacia la caja.");
      }
      cajaAsociadaId = abierta.id;
      const movCaja = {
        id: `mc-tr-${Date.now()}`,
        tipo: cuentaOrigen === "Caja física" ? "Salida" : "Entrada",
        monto: importe,
        concepto: `Traslado interno: ${cuentaOrigen} → ${cuentaDestino}`,
        usuario: user.name || user.email,
        fecha: ahora
      };
      const lista = Array.isArray(abierta.movimientosEfectivoExtra)
        ? [...abierta.movimientosEfectivoExtra, movCaja]
        : [movCaja];
      tx.update(COLLECTIONS.CAJAS, abierta.id, { movimientosEfectivoExtra: lista });
    }

    const traslado = tx.insert(COLLECTIONS.MOV_CONTABLES, {
      tipo: TIPOS_CONTABLE.TRASLADO,
      categoria: "Traslado entre cuentas propias",
      concepto: `Traslado ${cuentaOrigen} → ${cuentaDestino}`,
      monto: importe,
      valor: importe,
      fechaEfectiva: fechaEfectivaStr,
      fechaRegistro: ahora,
      fecha: ahora,
      metodoPago: cuentaOrigen === "Caja física" ? "Efectivo" : "Transferencia",
      cuentaOrigen,
      cuentaDestino,
      afectaCajaFisica: Boolean(cajaAsociadaId),
      cajaId: cajaAsociadaId,
      referencia: String(referencia || "").trim(),
      soporteReferencia: String(referencia || "").trim(),
      observaciones: String(observaciones || "").trim(),
      nota: String(observaciones || "").trim(),
      responsable: user.name || user.email,
      usuario: user.name || user.email,
      estado: "Confirmado",
      anulado: false
    });

    tx.insert(COLLECTIONS.AUDITORIA, {
      accion: "CONTABLE_TRASLADO_INTERNO",
      movimientoId: traslado.id,
      cuentaOrigen,
      cuentaDestino,
      monto: importe,
      usuario: user.name || user.email,
      fecha: ahora
    });

    return traslado;
  });
}

// Registra un abono parcial o pago total sobre una cuenta por pagar pendiente
export async function pagarCuentaPorPagar(
  {
    movimientoId,
    montoPago = null,
    metodoPago = "Efectivo",
    fecha,
    referencia = "",
    observaciones = ""
  },
  user = getCurrentUser()
) {
  assertPermission("contabilidad.gestionar", user);
  if (!movimientoId) throw new Error("Debe indicar la cuenta por pagar a liquidar.");

  return runAtomicTransaction(async (tx) => {
    const mov = tx.get(COLLECTIONS.MOV_CONTABLES, movimientoId);
    if (!mov) throw new Error("Cuenta por pagar no encontrada.");
    if (mov.anulado || mov.estado === "Revertido") {
      throw new Error("Este movimiento fue revertido y no puede pagarse.");
    }
    const esPendiente =
      mov.estadoPago === "Pendiente" || mov.estadoPago === "Parcial" || mov.estado === "Por pagar";
    if (!esPendiente) {
      throw new Error("Esta cuenta ya figura como pagada.");
    }

    const totalDeuda = roundCOP(mov.valor ?? mov.monto);
    const pagadoPrevio = roundCOP(mov.montoPagado || 0);
    const saldoActual = roundCOP(mov.saldoPendiente ?? Math.max(0, totalDeuda - pagadoPrevio));
    if (!(saldoActual > 0)) {
      throw new Error("Esta cuenta ya no tiene saldo pendiente por pagar.");
    }

    const importePago =
      montoPago === null || montoPago === undefined || montoPago === ""
        ? saldoActual
        : roundCOP(montoPago);
    if (!Number.isFinite(importePago) || !(importePago > 0)) {
      throw new Error("El valor a pagar / abonar debe ser mayor que cero.");
    }
    if (importePago > saldoActual) {
      throw new Error(
        `El abono ($ ${importePago.toLocaleString("es-CO")}) supera el saldo pendiente de la deuda ($ ${saldoActual.toLocaleString("es-CO")}).`
      );
    }

    const nuevoPagado = roundCOP(pagadoPrevio + importePago);
    const nuevoSaldo = roundCOP(saldoActual - importePago);
    const ahora = new Date().toISOString();
    const fechaPago = String(fecha || ahora.slice(0, 10)).slice(0, 10);
    const fechaIso = `${fechaPago}T${ahora.slice(11)}`;
    const esEfectivo = metodoPago === "Efectivo";
    let cajaAsociadaId = null;

    if (esEfectivo) {
      const abierta = tx.getAll(COLLECTIONS.CAJAS).find((c) => c.estado === "Abierta");
      if (!abierta) {
        throw new Error("Debe haber una caja abierta para registrar el pago en efectivo a proveedor.");
      }
      cajaAsociadaId = abierta.id;
      const movCaja = {
        id: `mc-cxp-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        tipo: "Salida",
        monto: importePago,
        concepto: `Abono CXP: ${mov.concepto}${mov.proveedor ? ` (${mov.proveedor})` : ""}`,
        usuario: user.name || user.email,
        fecha: fechaIso
      };
      const lista = Array.isArray(abierta.movimientosEfectivoExtra)
        ? [...abierta.movimientosEfectivoExtra, movCaja]
        : [movCaja];
      tx.update(COLLECTIONS.CAJAS, abierta.id, { movimientosEfectivoExtra: lista });
    }

    const refFinal = String(referencia || "").trim();
    const obsLimpia = String(observaciones || "").trim();
    const etiquetaOp = nuevoSaldo === 0 && pagadoPrevio === 0 ? "Pago CXP" : "Abono CXP";

    const abonoMov = tx.insert(COLLECTIONS.MOV_CONTABLES, {
      tipo: TIPOS_CONTABLE.GASTO,
      categoria: mov.categoria || "Otros gastos",
      concepto: `${etiquetaOp}: ${mov.concepto}${mov.proveedor ? ` (${mov.proveedor})` : ""}`,
      monto: importePago,
      valor: importePago,
      fechaEfectiva: fechaPago,
      fechaRegistro: ahora,
      fecha: fechaIso,
      metodoPago,
      cuentaOrigen: normalizarCuentaContable(metodoPago),
      cuentaDestino: mov.proveedor || "Proveedor",
      afectaCajaFisica: esEfectivo,
      cajaId: cajaAsociadaId,
      proveedor: mov.proveedor || "",
      referencia: refFinal || mov.referencia || "",
      soporteReferencia: refFinal || mov.soporteReferencia || "",
      origen: "Abono cuenta por pagar",
      obligacionId: mov.id,
      referenciaId: mov.id,
      observaciones: obsLimpia,
      nota: obsLimpia,
      responsable: user.name || user.email,
      usuario: user.name || user.email,
      estadoPago: "Pagado",
      estado: "Confirmado",
      anulado: false
    });

    const pagosPrevios = Array.isArray(mov.pagos) ? mov.pagos : [];
    const registroPago = {
      id: abonoMov.id,
      monto: importePago,
      metodoPago,
      fecha: fechaPago,
      fechaRegistro: ahora,
      referencia: refFinal,
      observaciones: obsLimpia,
      usuario: user.name || user.email
    };

    const obligacionActualizada = tx.update(COLLECTIONS.MOV_CONTABLES, mov.id, {
      esObligacionPorPagar: true,
      montoPagado: nuevoPagado,
      saldoPendiente: nuevoSaldo,
      pagos: [...pagosPrevios, registroPago],
      estadoPago: nuevoSaldo === 0 ? "Pagado" : "Parcial",
      estado: nuevoSaldo === 0 ? "Confirmado" : "Por pagar",
      fechaUltimoPago: fechaPago,
      pagadoPor: user.name || user.email
    });

    tx.insert(COLLECTIONS.AUDITORIA, {
      accion: nuevoSaldo === 0 ? "CONTABLE_PAGO_PROVEEDOR" : "CONTABLE_ABONO_PROVEEDOR",
      movimientoId: mov.id,
      abonoMovimientoId: abonoMov.id,
      monto: importePago,
      saldoPendiente: nuevoSaldo,
      metodoPago,
      usuario: user.name || user.email,
      fecha: ahora
    });

    return {
      obligacion: obligacionActualizada,
      abonoMovimiento: abonoMov,
      montoPagado: importePago,
      saldoPendiente: nuevoSaldo,
      estadoPago: obligacionActualizada.estadoPago
    };
  });
}

// Procedimiento de reversión o ajuste autorizado (Sección 9 y 13):
// Los registros históricos nunca se eliminan; se marcan como Revertidos con motivo, responsable y fecha.
export async function revertirMovimientoContable(
  { movimientoId, motivo },
  user = getCurrentUser()
) {
  assertPermission("contabilidad.revertir", user);
  const motivoLimpio = String(motivo || "").trim();
  if (!motivoLimpio || motivoLimpio.length < 4) {
    throw new Error("Debes indicar un motivo válido para la reversión o ajuste contable.");
  }

  return runAtomicTransaction(
    async (tx) => {
      const mov = tx.get(COLLECTIONS.MOV_CONTABLES, movimientoId);
    if (!mov) {
      throw new Error("El movimiento contable no existe.");
    }
    if (mov.anulado || mov.estado === "Revertido") {
      throw new Error("Este movimiento ya fue revertido anteriormente.");
    }
    if (mov.origen === "Venta POS") {
      throw new Error(
        "Los ingresos generados automáticamente por una venta deben anularse desde el módulo Caja y Ventas para ajustar también el inventario."
      );
    }

    const ahora = new Date().toISOString();

    // Si el movimiento afectó el efectivo de la caja que sigue abierta, revertir su efecto en caja
    if (mov.afectaCajaFisica && mov.cajaId) {
      const caja = tx.get(COLLECTIONS.CAJAS, mov.cajaId);
      if (caja && caja.estado === "Abierta") {
        const tipoInverso = mov.tipo === TIPOS_CONTABLE.INGRESO ? "Salida" : "Entrada";
        const movCajaInverso = {
          id: `mc-rev-${Date.now()}`,
          tipo: tipoInverso,
          monto: roundCOP(mov.valor ?? mov.monto),
          concepto: `Reversión contable (${mov.concepto}): ${motivoLimpio}`,
          usuario: user.name || user.email,
          fecha: ahora
        };
        const lista = Array.isArray(caja.movimientosEfectivoExtra)
          ? [...caja.movimientosEfectivoExtra, movCajaInverso]
          : [movCajaInverso];
        tx.update(COLLECTIONS.CAJAS, caja.id, { movimientosEfectivoExtra: lista });
      }
    }

    const actualizado = tx.update(COLLECTIONS.MOV_CONTABLES, mov.id, {
      anulado: true,
      estado: "Revertido",
      motivoReversion: motivoLimpio,
      revertidoPor: user.name || user.email,
      fechaReversion: ahora
    });

    tx.insert(COLLECTIONS.AUDITORIA, {
      accion: "CONTABLE_REVERSION",
      movimientoId: mov.id,
      conceptoOriginal: mov.concepto,
      monto: roundCOP(mov.valor ?? mov.monto),
      motivo: motivoLimpio,
      usuario: user.name || user.email,
      fecha: ahora
    });

      return actualizado;
    },
    {
      lockKey: `rev_mc_${movimientoId}`,
      readDocs: [{ collection: COLLECTIONS.MOV_CONTABLES, id: movimientoId }],
      resolveReadDocs: (snapshot) => {
        const m = (snapshot[COLLECTIONS.MOV_CONTABLES] || []).find((x) => x.id === movimientoId);
        return m?.cajaId ? [{ collection: COLLECTIONS.CAJAS, id: m.cajaId }] : [];
      }
    }
  );
}

// Exporta a CSV los movimientos e informes financieros de Contabilidad (Sección 10)
export function exportarContabilidadCSV(movimientosOrFiltros = null) {
  const movimientos = Array.isArray(movimientosOrFiltros)
    ? movimientosOrFiltros
    : filtrarMovimientosContables(listarMovimientosContables(), movimientosOrFiltros || {});
  const esc = (v) => {
    const s = String(v ?? "");
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = [
    "Fecha Efectiva",
    "Fecha Registro",
    "Tipo",
    "Categoría",
    "Concepto",
    "Método de Pago",
    "Referencia / Soporte",
    "Cliente / Proveedor",
    "Pedido Relacionado",
    "Valor COP",
    "Responsable",
    "Estado",
    "Observaciones"
  ];
  const rows = movimientos.map((m) => [
    m.fechaEfectiva || String(m.fecha || "").slice(0, 10),
    m.fechaRegistro || m.fecha || "",
    m.tipo,
    m.categoria,
    m.concepto,
    m.metodoPago || "Efectivo",
    m.referencia || m.soporteReferencia || m.numeroVenta || "",
    m.clienteRelacionado || m.proveedor || "",
    m.pedidoRelacionado || "",
    roundCOP(m.valor ?? m.monto),
    m.responsable || m.usuario || "",
    m.anulado || m.estado === "Revertido" ? "Revertido" : m.estado || "Confirmado",
    m.observaciones || m.nota || ""
  ]);

  return [headers.map(esc).join(";"), ...rows.map((r) => r.map(esc).join(";"))].join("\r\n");
}
