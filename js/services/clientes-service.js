// Servicio de Clientes: gestión de clientes y venta por defecto a Consumidor Final.

import {
  COLLECTIONS,
  getCollection,
  getDocById,
  subscribeCollection,
  runAtomicTransaction
} from "./store.js";
import { getCurrentUser, assertPermission } from "../auth.js";

export function listarMovimientosBilletera() {
  const list = getCollection(COLLECTIONS.MOV_BILLETERA);
  return [...list].sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")));
}

export function watchMovimientosBilletera(callback) {
  return subscribeCollection(COLLECTIONS.MOV_BILLETERA, (items) => {
    const sorted = [...items].sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")));
    callback(sorted);
  });
}

export function obtenerResumenBilleteraCliente(
  clienteId,
  { clientes = null, movimientosBilletera = null } = {}
) {
  if (!clienteId || clienteId === "cli-consumidor") {
    return {
      clienteId: clienteId || "cli-consumidor",
      saldoDisponible: 0,
      totalGenerado: 0,
      totalUtilizado: 0,
      ultimoMovimiento: null,
      movimientos: []
    };
  }
  const cliente = Array.isArray(clientes)
    ? clientes.find((c) => c.id === clienteId)
    : getDocById(COLLECTIONS.CLIENTES, clienteId);
  const movsAll = Array.isArray(movimientosBilletera)
    ? movimientosBilletera
    : listarMovimientosBilletera();
  const movimientos = movsAll
    .filter((m) => m.clienteId === clienteId)
    .sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")));

  const saldoCalculado = movimientos.reduce((acc, m) => {
    const monto = Math.max(0, Math.round(Number(m.monto) || 0));
    if (m.tipo === "GENERACION" || m.tipo === "AJUSTE_COMPENSATORIO") return acc + monto;
    if (m.tipo === "REDENCION") return Math.max(0, acc - monto);
    return acc;
  }, 0);

  const totalGenerado = movimientos
    .filter((m) => m.tipo === "GENERACION")
    .reduce((acc, m) => acc + Math.max(0, Math.round(Number(m.monto) || 0)), 0);
  const totalUtilizado = Math.max(
    0,
    movimientos
      .filter((m) => m.tipo === "REDENCION")
      .reduce((acc, m) => acc + Math.max(0, Math.round(Number(m.monto) || 0)), 0) -
      movimientos
        .filter((m) => m.tipo === "AJUSTE_COMPENSATORIO")
        .reduce((acc, m) => acc + Math.max(0, Math.round(Number(m.monto) || 0)), 0)
  );

  const saldoDisponible =
    cliente && cliente.saldoAFavorDisponible !== undefined && cliente.saldoAFavorDisponible !== null
      ? Math.max(0, Math.round(Number(cliente.saldoAFavorDisponible) || 0))
      : saldoCalculado;

  return {
    clienteId,
    saldoDisponible,
    totalGenerado: cliente?.saldoAFavorGeneradoTotal ?? totalGenerado,
    totalUtilizado: cliente?.saldoAFavorUtilizadoTotal ?? totalUtilizado,
    ultimoMovimiento: cliente?.ultimoMovimientoBilletera || movimientos[0]?.fecha || null,
    movimientos
  };
}

export function listarClientes() {
  return getCollection(COLLECTIONS.CLIENTES);
}

export function watchClientes(callback) {
  return subscribeCollection(COLLECTIONS.CLIENTES, callback);
}

export function buscarClientes(termino = "", lista = null) {
  const q = String(termino || "").trim().toLowerCase();
  const todos = Array.isArray(lista) ? lista : listarClientes();
  if (!q) return todos;
  return todos.filter(
    (c) =>
      String(c.nombre || "").toLowerCase().includes(q) ||
      String(c.documento || "").toLowerCase().includes(q) ||
      String(c.telefono || "").toLowerCase().includes(q)
  );
}

export async function crearCliente(
  { nombre, documento, telefono = "", tipoDocumento = "" },
  user = getCurrentUser()
) {
  assertPermission("clientes.crear", user);
  const nom = String(nombre || "").trim();
  const docId = String(documento || "").trim();
  if (!nom || !docId) {
    throw new Error("El nombre y el documento del cliente son obligatorios.");
  }

  return runAtomicTransaction(async (tx) => {
    const actuales = tx.getAll(COLLECTIONS.CLIENTES);
    if (actuales.some((c) => String(c.documento || "").trim().toLowerCase() === docId.toLowerCase())) {
      throw new Error(`Ya existe un cliente registrado con el documento ${docId}.`);
    }
    return tx.insert(COLLECTIONS.CLIENTES, {
      nombre: nom,
      documento: docId,
      tipoDocumento: String(tipoDocumento || "").trim(),
      telefono: String(telefono || "").trim(),
      esConsumidorFinal: false,
      saldoAFavorDisponible: 0,
      saldoAFavorGeneradoTotal: 0,
      saldoAFavorUtilizadoTotal: 0,
      ultimoMovimientoBilletera: null,
      ultimoMovimientoBilleteraId: null,
      creadoPor: user.name || user.email,
      creadoEn: new Date().toISOString()
    });
  });
}

export function calcularSaldoPendienteVenta(venta) {
  if (!venta || venta.estado === "Anulada") return 0;
  if (venta.saldoPendiente !== undefined && venta.saldoPendiente !== null) {
    return Math.max(0, Math.round(Number(venta.saldoPendiente) || 0));
  }
  const total = Math.round(Number(venta.total) || 0);
  const pagado = Math.round(Number(venta.importePagado ?? total) || 0);
  return Math.max(0, total - pagado);
}

export function obtenerHistorialCliente(
  clienteId,
  { desde = "", hasta = "", ventas = null } = {}
) {
  const todasVentas = Array.isArray(ventas) ? ventas : getCollection(COLLECTIONS.VENTAS);
  const desdeTs = desde ? new Date(`${desde}T00:00:00`).getTime() : null;
  const hastaTs = hasta ? new Date(`${hasta}T23:59:59.999`).getTime() : null;

  const ventasClienteAll = todasVentas
    .filter((v) => v.cliente?.id === clienteId)
    .sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")));

  const ventasFiltradas = ventasClienteAll.filter((v) => {
    const ts = new Date(v.fecha || 0).getTime();
    if (desdeTs && ts < desdeTs) return false;
    if (hastaTs && ts > hastaTs) return false;
    return true;
  });

  let totalHistorico = 0;
  let totalPagado = 0;
  let saldoPendienteTotal = 0;
  let operacionesPendientes = 0;
  let ultimoMovimiento = null;

  for (const v of ventasClienteAll) {
    if (!ultimoMovimiento || String(v.fecha || "") > String(ultimoMovimiento)) {
      ultimoMovimiento = v.fecha;
    }
    if (v.ultimaActualizacionPago && String(v.ultimaActualizacionPago) > String(ultimoMovimiento || "")) {
      ultimoMovimiento = v.ultimaActualizacionPago;
    }
    if (v.estado === "Anulada") continue;

    const total = Math.round(Number(v.total) || 0);
    const saldo = calcularSaldoPendienteVenta(v);
    const pagado = Math.max(0, total - saldo);
    totalHistorico += total;
    totalPagado += pagado;
    saldoPendienteTotal += saldo;
    if (saldo > 0) operacionesPendientes += 1;
  }

  const billetera = obtenerResumenBilleteraCliente(clienteId);

  return {
    clienteId,
    ventas: ventasFiltradas,
    totalHistorico,
    totalPagado,
    saldoPendienteTotal,
    operacionesPendientes,
    ultimoMovimiento,
    saldoAFavorDisponible: billetera.saldoDisponible,
    billetera
  };
}

export function listarCarteraClientes(
  clientesList = null,
  ventasList = null,
  busqueda = ""
) {
  const clientes = Array.isArray(clientesList) ? clientesList : listarClientes();
  const ventas = Array.isArray(ventasList) ? ventasList : getCollection(COLLECTIONS.VENTAS);
  const q = String(busqueda || "").trim().toLowerCase();

  const resumenes = [];
  for (const c of clientes) {
    if (c.esConsumidorFinal || c.id === "cli-consumidor") continue;
    const hist = obtenerHistorialCliente(c.id, { ventas });
    if (hist.saldoPendienteTotal <= 0) continue;
    if (
      q &&
      !String(c.nombre || "").toLowerCase().includes(q) &&
      !String(c.documento || "").toLowerCase().includes(q) &&
      !String(c.telefono || "").toLowerCase().includes(q)
    ) {
      continue;
    }
    resumenes.push({
      cliente: c,
      totalPendiente: hist.saldoPendienteTotal,
      operacionesPendientes: hist.operacionesPendientes,
      ultimoMovimiento: hist.ultimoMovimiento,
      ventasPendientes: hist.ventas.filter((v) => calcularSaldoPendienteVenta(v) > 0)
    });
  }

  return resumenes.sort((a, b) => b.totalPendiente - a.totalPendiente);
}
