// Servicio de Clientes: gestión de clientes y venta por defecto a Consumidor Final.

import {
  COLLECTIONS,
  getCollection,
  subscribeCollection,
  runAtomicTransaction
} from "./store.js";
import { getCurrentUser, assertPermission } from "../auth.js";

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

  return {
    clienteId,
    ventas: ventasFiltradas,
    totalHistorico,
    totalPagado,
    saldoPendienteTotal,
    operacionesPendientes,
    ultimoMovimiento
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
