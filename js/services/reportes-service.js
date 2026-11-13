// Servicio centralizado de Consultas, Indicadores de Dashboard y los 11 Reportes (Secciones 5 y 9).
// Garantiza que Dashboard y Reportes utilicen exactamente las mismas reglas de negocio:
// - Excluye ventas anuladas de los totales de ventas efectivas, conservando su trazabilidad.
// - No duplica pagos ni movimientos.
// - Soporta filtros combinados por fecha inicial, fecha final, producto, categoría, usuario,
//   método de pago y estado de venta, así como exportación real a CSV.

import { COLLECTIONS, getCollection } from "./store.js";
import { roundCOP, roundQty, getEstadoStock } from "./inventario-service.js";
import { calcularResumenContable } from "./contabilidad-service.js";

export function estaEnRangoFechas(isoDate, { desde = "", hasta = "" } = {}) {
  if (!isoDate) return true;
  const ts = new Date(isoDate).getTime();
  if (Number.isNaN(ts)) return true;

  if (desde) {
    const dTs = new Date(`${desde}T00:00:00`).getTime();
    if (!Number.isNaN(dTs) && ts < dTs) return false;
  }
  if (hasta) {
    const hTs = new Date(`${hasta}T23:59:59.999`).getTime();
    if (!Number.isNaN(hTs) && ts > hTs) return false;
  }
  return true;
}

export function generarReportesConsolidados(
  filtros = {},
  datos = null
) {
  const {
    desde = "",
    hasta = "",
    productoId = "Todos",
    categoria = "Todas",
    usuario = "Todos",
    metodoPago = "Todos",
    estadoVenta = "Todos"
  } = filtros;

  const productos = datos?.productos || getCollection(COLLECTIONS.PRODUCTOS);
  const ventas = datos?.ventas || getCollection(COLLECTIONS.VENTAS);
  const cajas = datos?.cajas || getCollection(COLLECTIONS.CAJAS);
  const movsInventario = datos?.movsInventario || getCollection(COLLECTIONS.MOV_INVENTARIO);
  const movsContables = datos?.movsContables || getCollection(COLLECTIONS.MOV_CONTABLES);
  const devoluciones = datos?.devoluciones || getCollection(COLLECTIONS.DEVOLUCIONES);
  const clientes = datos?.clientes || getCollection(COLLECTIONS.CLIENTES);
  const movimientosBilletera = datos?.movimientosBilletera || getCollection(COLLECTIONS.MOV_BILLETERA);

  const prodMap = new Map(productos.map((p) => [p.id, p]));

  // Filtrar ventas según criterios seleccionados
  const ventasFiltradas = ventas.filter((v) => {
    if (!estaEnRangoFechas(v.fecha, { desde, hasta })) return false;
    if (estadoVenta !== "Todos" && v.estado !== estadoVenta) return false;
    if (usuario !== "Todos" && String(v.vendedor || "").toLowerCase() !== String(usuario).toLowerCase()) {
      return false;
    }
    if (metodoPago !== "Todos") {
      const coincideMetodo =
        v.metodoPago === metodoPago ||
        (Array.isArray(v.pagos) && v.pagos.some((p) => p.metodo === metodoPago));
      if (!coincideMetodo) return false;
    }
    if (productoId !== "Todos") {
      const tieneProd = Array.isArray(v.items) && v.items.some((i) => i.productoId === productoId);
      if (!tieneProd) return false;
    }
    if (categoria !== "Todas" && categoria !== "Todos") {
      const tieneCat =
        Array.isArray(v.items) &&
        v.items.some((i) => {
          const p = prodMap.get(i.productoId);
          return (i.categoria || p?.categoria) === categoria;
        });
      if (!tieneCat) return false;
    }
    return true;
  });

  // Ventas efectivas (excluye Anuladas de los totales comerciales)
  const ventasEfectivas = ventasFiltradas.filter((v) => v.estado !== "Anulada");

  // 1. Reporte de ventas por período (agrupadas por día)
  const mapaPorDia = new Map();
  for (const v of ventasEfectivas) {
    const dia = String(v.fecha || "").slice(0, 10) || "Sin fecha";
    const actual = mapaPorDia.get(dia) || {
      fecha: dia,
      cantidadVentas: 0,
      subtotal: 0,
      descuentos: 0,
      totalVendido: 0
    };
    actual.cantidadVentas += 1;
    actual.subtotal = roundCOP(actual.subtotal + roundCOP(v.subtotal || v.total));
    actual.descuentos = roundCOP(actual.descuentos + roundCOP(v.descuento || 0));
    actual.totalVendido = roundCOP(actual.totalVendido + roundCOP(v.total));
    mapaPorDia.set(dia, actual);
  }
  const ventasPorPeriodo = [...mapaPorDia.values()].sort((a, b) =>
    b.fecha.localeCompare(a.fecha)
  );

  // 2. Detalle de ventas (línea por línea)
  const detalleVentas = [];
  for (const v of ventasFiltradas) {
    for (const item of v.items || []) {
      const esTemporal = Boolean(item.esTemporal || !item.productoId);
      const prod = !esTemporal && item.productoId ? prodMap.get(item.productoId) : null;
      const catItem = esTemporal ? "Concepto temporal" : (item.categoria || prod?.categoria || "General");
      if (productoId !== "Todos" && item.productoId !== productoId) continue;
      if (categoria !== "Todas" && categoria !== "Todos" && catItem !== categoria) continue;

      detalleVentas.push({
        ventaId: v.id,
        numero: v.numero,
        fecha: v.fecha,
        cliente: v.cliente?.nombre || "Consumidor Final",
        vendedor: v.vendedor,
        metodoPago: v.metodoPago,
        estado: v.estado,
        esTemporal,
        productoId: item.productoId || null,
        codigo: esTemporal ? "" : (item.codigo || prod?.codigo || ""),
        nombre: item.nombre,
        observacion: item.observacion || "",
        categoria: catItem,
        unidad: item.unidad ?? "",
        cantidad: item.cantidad,
        dimensiones: item.dimensiones || null,
        precioUnitario: roundCOP(item.precioUnitario),
        costosAdicionales: roundCOP(item.costosAdicionales || 0),
        subtotal: roundCOP(item.subtotal)
      });
    }
  }

  // 3. Productos más vendidos (solo productos inventariables de ventas efectivas no anuladas)
  const mapaMasVendidos = new Map();
  for (const v of ventasEfectivas) {
    for (const item of v.items || []) {
      if (item.esTemporal || !item.productoId) continue;
      const prod = prodMap.get(item.productoId);
      const catItem = item.categoria || prod?.categoria || "General";
      if (productoId !== "Todos" && item.productoId !== productoId) continue;
      if (categoria !== "Todas" && categoria !== "Todos" && catItem !== categoria) continue;

      const prev = mapaMasVendidos.get(item.productoId) || {
        productoId: item.productoId,
        codigo: item.codigo || prod?.codigo || "",
        nombre: item.nombre || prod?.nombre || "Producto",
        categoria: catItem,
        unidad: item.unidad ?? prod?.unidad ?? "",
        cantidadVendida: 0,
        numeroVentas: 0,
        totalIngresos: 0
      };
      prev.cantidadVendida = roundQty(prev.cantidadVendida + Number(item.cantidad || 0));
      prev.numeroVentas += 1;
      prev.totalIngresos = roundCOP(prev.totalIngresos + roundCOP(item.subtotal));
      mapaMasVendidos.set(item.productoId, prev);
    }
  }
  const productosMasVendidos = [...mapaMasVendidos.values()].sort(
    (a, b) => b.totalIngresos - a.totalIngresos
  );

  // 4. Inventario actual
  const inventarioActual = productos
    .filter((p) => {
      if (productoId !== "Todos" && p.id !== productoId) return false;
      if (categoria !== "Todas" && categoria !== "Todos" && p.categoria !== categoria) return false;
      return true;
    })
    .map((p) => {
      const est = getEstadoStock(p);
      const costoUnitario = roundCOP(p.precioCompra || 0);
      const precioVenta = roundCOP(p.precio || 0);
      const stock = roundQty(p.stock || 0);
      return {
        ...p,
        estadoCodigo: est.codigo,
        estadoEtiqueta: est.etiqueta,
        claseBadge: est.claseBadge,
        valorCostoTotal: roundCOP(costoUnitario * stock),
        valorVentaTotal: roundCOP(precioVenta * stock)
      };
    });

  // 5. Productos con stock bajo y agotados
  const productosStockBajo = inventarioActual.filter(
    (p) => p.activo !== false && (p.estadoCodigo === "agotado" || p.estadoCodigo === "bajo")
  );

  // 6. Movimientos de inventario (Kardex)
  const movimientosInventario = movsInventario.filter((m) => {
    if (!estaEnRangoFechas(m.fecha, { desde, hasta })) return false;
    if (productoId !== "Todos" && m.productoId !== productoId) return false;
    if (usuario !== "Todos" && String(m.usuario || "").toLowerCase() !== String(usuario).toLowerCase()) {
      return false;
    }
    if (categoria !== "Todas" && categoria !== "Todos") {
      const p = prodMap.get(m.productoId);
      if (p && p.categoria !== categoria) return false;
    }
    return true;
  });

  // 7. Ingresos y gastos (Contabilidad)
  const movsContablesFiltrados = movsContables.filter((m) => {
    if (m.anulado) return false;
    if (!estaEnRangoFechas(m.fecha, { desde, hasta })) return false;
    if (usuario !== "Todos" && String(m.usuario || "").toLowerCase() !== String(usuario).toLowerCase()) {
      return false;
    }
    if (metodoPago !== "Todos" && (m.metodoPago || "Efectivo") !== metodoPago) {
      return false;
    }
    return true;
  });
  const resumenContable = calcularResumenContable(movsContablesFiltrados);

  const gruposCategoriasContables = new Map();
  for (const m of movsContablesFiltrados) {
    const key = `${m.tipo}|${m.categoria}`;
    const prev = gruposCategoriasContables.get(key) || {
      tipo: m.tipo,
      categoria: m.categoria,
      movimientos: 0,
      total: 0
    };
    prev.movimientos += 1;
    prev.total = roundCOP(prev.total + roundCOP(m.monto));
    gruposCategoriasContables.set(key, prev);
  }
  const ingresosYGastosPorCategoria = [...gruposCategoriasContables.values()].sort(
    (a, b) => b.total - a.total
  );

  // 8. Métodos de pago (a partir de los pagos reales de ventas efectivas)
  const mapaMetodos = new Map([
    ["Efectivo", { metodo: "Efectivo", operaciones: 0, total: 0 }],
    ["Transferencia", { metodo: "Transferencia", operaciones: 0, total: 0 }],
    ["Tarjeta débito", { metodo: "Tarjeta débito", operaciones: 0, total: 0 }],
    ["Tarjeta crédito", { metodo: "Tarjeta crédito", operaciones: 0, total: 0 }]
  ]);

  let sumaTotalPagos = 0;
  for (const v of ventasEfectivas) {
    const listaPagos = Array.isArray(v.pagos)
      ? v.pagos
      : roundCOP(v.saldoPendiente || 0) > 0
        ? []
        : [{ metodo: v.metodoPago || "Efectivo", importeNeto: v.total }];
    for (const p of listaPagos) {
      const m = p.metodo || "Efectivo";
      if (m === "Saldo a favor") continue;
      if (metodoPago !== "Todos" && m !== metodoPago) continue;
      const neto = roundCOP(
        p.importeNeto !== undefined
          ? p.importeNeto
          : m === "Efectivo"
            ? v.efectivoNetoCaja ?? v.total
            : p.importe ?? v.total
      );
      const item = mapaMetodos.get(m) || { metodo: m, operaciones: 0, total: 0 };
      item.operaciones += 1;
      item.total = roundCOP(item.total + neto);
      mapaMetodos.set(m, item);
      sumaTotalPagos = roundCOP(sumaTotalPagos + neto);
    }
  }
  const metodosDePago = [...mapaMetodos.values()].map((m) => ({
    ...m,
    porcentaje: sumaTotalPagos > 0 ? Math.round((m.total / sumaTotalPagos) * 100) : 0
  }));

  // 9. Cierres de caja
  const cierresDeCaja = cajas
    .filter((c) => {
      if (c.estado !== "Cerrada") return false;
      if (!estaEnRangoFechas(c.fechaCierre || c.fechaApertura, { desde, hasta })) return false;
      if (
        usuario !== "Todos" &&
        String(c.usuarioCierre || c.usuarioApertura || "").toLowerCase() !== String(usuario).toLowerCase()
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => (b.fechaCierre || "").localeCompare(a.fechaCierre || ""));

  // 10. Diferencias de efectivo en cierres de caja
  const diferenciasEfectivo = cierresDeCaja.filter((c) => roundCOP(c.diferencia || 0) !== 0);

  // 11. Anulaciones y devoluciones
  const ventasAnuladas = ventas
    .filter((v) => v.estado === "Anulada" && estaEnRangoFechas(v.anuladaEn || v.fecha, { desde, hasta }))
    .map((v) => ({
      tipo: "Anulación",
      referencia: v.numero,
      fecha: v.anuladaEn || v.fecha,
      monto: roundCOP(v.total),
      motivo: v.motivoAnulacion || "Sin motivo",
      usuario: v.anuladaPor || v.vendedor
    }));

  const devolucionesFiltradas = devoluciones
    .filter((d) => estaEnRangoFechas(d.fecha, { desde, hasta }))
    .map((d) => ({
      tipo: "Devolución",
      referencia: d.ventaNumero,
      fecha: d.fecha,
      monto: roundCOP(d.totalDevuelto),
      motivo: d.motivo || "Devolución de cliente",
      usuario: d.usuario
    }));

  const anulacionesYDevoluciones = [...ventasAnuladas, ...devolucionesFiltradas].sort((a, b) =>
    (b.fecha || "").localeCompare(a.fecha || "")
  );

  // Resumen general de KPIs del período
  const totalVentasPeriodo = ventasEfectivas.reduce((acc, v) => acc + roundCOP(v.total), 0);
  const valorBodegaVenta = inventarioActual
    .filter((p) => p.activo !== false)
    .reduce((acc, p) => acc + p.valorVentaTotal, 0);
  const valorBodegaCosto = inventarioActual
    .filter((p) => p.activo !== false)
    .reduce((acc, p) => acc + p.valorCostoTotal, 0);

  // 12. Resumen de cartera, crédito, devoluciones y recaudos por abonos (sin duplicar ventas del período)
  const ventasPagadas = ventasEfectivas.filter((v) => roundCOP(v.saldoPendiente || 0) === 0);
  const ventasConSaldo = ventasEfectivas.filter((v) => roundCOP(v.saldoPendiente || 0) > 0);
  const recaudosAbonosMovs = (movsContables || []).filter(
    (m) =>
      !m.anulado &&
      m.estado !== "Revertido" &&
      (m.categoria === "Abonos de cartera" || m.origen === "Abono venta") &&
      estaEnRangoFechas(m.fecha, { desde, hasta }) &&
      (metodoPago === "Todos" || m.metodoPago === metodoPago)
  );
  const recaudosPorAbonos = recaudosAbonosMovs.reduce((acc, m) => acc + roundCOP(m.monto ?? m.valor ?? 0), 0);
  const saldoPorCobrarVigente = ventas
    .filter((v) => v.estado !== "Anulada" && roundCOP(v.saldoPendiente || 0) > 0)
    .reduce((acc, v) => acc + roundCOP(v.saldoPendiente || 0), 0);

  const devsPeriodo = devoluciones.filter((d) => estaEnRangoFechas(d.fecha, { desde, hasta }));
  const totalDevoluciones = devsPeriodo.reduce((acc, d) => acc + roundCOP(d.totalDevuelto), 0);
  const reembolsosRealizados = devsPeriodo.reduce(
    (acc, d) => acc + roundCOP(d.montoReembolsado ?? (d.reembolsoEfectivo ? d.totalDevuelto : 0)),
    0
  );
  const ajustesCarteraDevoluciones = devsPeriodo.reduce(
    (acc, d) => acc + roundCOP(d.reduccionCartera || 0),
    0
  );
  const ventasBrutas = roundCOP(totalVentasPeriodo);
  const ventasNetas = Math.max(0, roundCOP(ventasBrutas - totalDevoluciones));

  const resumenCartera = {
    ventasBrutas,
    totalDevoluciones: roundCOP(totalDevoluciones),
    ventasNetas,
    reembolsosRealizados: roundCOP(reembolsosRealizados),
    ajustesCarteraDevoluciones: roundCOP(ajustesCarteraDevoluciones),
    ventasTotales: ventasBrutas,
    ventasPagadasCount: ventasPagadas.length,
    ventasPagadasTotal: roundCOP(ventasPagadas.reduce((acc, v) => acc + roundCOP(v.total), 0)),
    ventasConSaldoCount: ventasConSaldo.length,
    ventasConSaldoTotal: roundCOP(ventasConSaldo.reduce((acc, v) => acc + roundCOP(v.total), 0)),
    saldoPorCobrarVigente: roundCOP(saldoPorCobrarVigente),
    recaudosPorAbonos: roundCOP(recaudosPorAbonos),
    cantidadAbonos: recaudosAbonosMovs.length
  };

  // 13. Billetera de saldos a favor por cliente
  const movsBilleteraPeriodo = movimientosBilletera
    .filter((m) => {
      if (!estaEnRangoFechas(m.fecha, { desde, hasta })) return false;
      if (usuario !== "Todos" && String(m.usuario || "").toLowerCase() !== String(usuario).toLowerCase()) {
        return false;
      }
      return true;
    })
    .sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")));

  const totalGeneradoPeriodo = movsBilleteraPeriodo
    .filter((m) => m.tipo === "GENERACION")
    .reduce((acc, m) => acc + roundCOP(m.monto), 0);
  const totalRedimidoPeriodo = movsBilleteraPeriodo
    .filter((m) => m.tipo === "REDENCION")
    .reduce((acc, m) => acc + roundCOP(m.monto), 0);
  const totalRestituidoPeriodo = movsBilleteraPeriodo
    .filter((m) => m.tipo === "AJUSTE_COMPENSATORIO")
    .reduce((acc, m) => acc + roundCOP(m.monto), 0);

  const saldosPorCliente = clientes
    .filter((c) => !c.esConsumidorFinal && c.id !== "cli-consumidor" && roundCOP(c.saldoAFavorDisponible || 0) > 0)
    .map((c) => ({
      clienteId: c.id,
      nombre: c.nombre,
      documento: c.documento,
      saldoDisponible: roundCOP(c.saldoAFavorDisponible || 0),
      totalGenerado: roundCOP(c.saldoAFavorGeneradoTotal || 0),
      totalUtilizado: roundCOP(c.saldoAFavorUtilizadoTotal || 0),
      ultimoMovimiento: c.ultimoMovimientoBilletera || null
    }))
    .sort((a, b) => b.saldoDisponible - a.saldoDisponible);

  const saldoPendienteTotalClientes = saldosPorCliente.reduce((acc, c) => acc + c.saldoDisponible, 0);
  const aplicacionesEnVentas = ventasEfectivas
    .filter((v) => roundCOP(v.saldoAFavorAplicado || 0) > 0)
    .map((v) => ({
      ventaId: v.id,
      numero: v.numero,
      fecha: v.fecha,
      cliente: v.cliente?.nombre || "Cliente",
      montoAplicado: roundCOP(v.saldoAFavorAplicado || 0),
      totalVenta: roundCOP(v.total)
    }));

  const resumenBilletera = {
    saldoPendienteTotalClientes: roundCOP(saldoPendienteTotalClientes),
    totalGeneradoPeriodo: roundCOP(totalGeneradoPeriodo),
    totalRedimidoPeriodo: roundCOP(totalRedimidoPeriodo),
    totalRestituidoPeriodo: roundCOP(totalRestituidoPeriodo),
    saldosPorCliente,
    movimientosBilletera: movsBilleteraPeriodo,
    aplicacionesEnVentas
  };

  return {
    kpis: {
      totalVentasPeriodo: roundCOP(totalVentasPeriodo),
      cantidadVentasPeriodo: ventasEfectivas.length,
      ingresosPeriodo: resumenContable.ingresos,
      countIngresosPeriodo: resumenContable.countIngresos,
      gastosPeriodo: resumenContable.gastos,
      countGastosPeriodo: resumenContable.countGastos,
      resultadoPeriodo: resumenContable.balance,
      valorBodegaVenta: roundCOP(valorBodegaVenta),
      valorBodegaCosto: roundCOP(valorBodegaCosto),
      totalProductosActivos: inventarioActual.filter((p) => p.activo !== false).length,
      totalCriticos: productosStockBajo.length
    },
    ventasPorPeriodo,
    detalleVentas,
    productosMasVendidos,
    inventarioActual,
    productosStockBajo,
    movimientosInventario,
    ingresosYGastos: movsContablesFiltrados,
    ingresosYGastosPorCategoria,
    metodosDePago,
    cierresDeCaja,
    diferenciasEfectivo,
    anulacionesYDevoluciones,
    resumenCartera,
    resumenBilletera
  };
}

// Genera contenido CSV real para descargar cualquiera de los 11 reportes
export function generarCSVReporte(tipoReporte, reporteConsolidado) {
  const escapeCSV = (val) => {
    const s = String(val ?? "").replace(/"/g, '""');
    return `"${s}"`;
  };
  const buildCSV = (headers, rows) =>
    [headers.map(escapeCSV).join(","), ...rows.map((r) => r.map(escapeCSV).join(","))].join("\r\n");

  switch (tipoReporte) {
    case "ventas_periodo":
      return buildCSV(
        ["Fecha", "Cantidad Ventas", "Subtotal COP", "Descuentos COP", "Total Vendido COP"],
        reporteConsolidado.ventasPorPeriodo.map((r) => [
          r.fecha,
          r.cantidadVentas,
          r.subtotal,
          r.descuentos,
          r.totalVendido
        ])
      );
    case "detalle_ventas":
      return buildCSV(
        ["Venta", "Fecha", "Cliente", "Vendedor", "Producto", "Unidad", "Cantidad", "Subtotal COP", "Estado"],
        reporteConsolidado.detalleVentas.map((d) => [
          d.numero,
          d.fecha,
          d.cliente,
          d.vendedor,
          `${d.nombre} (${d.codigo})`,
          d.unidad,
          d.cantidad,
          d.subtotal,
          d.estado
        ])
      );
    case "mas_vendidos":
      return buildCSV(
        ["Código", "Producto", "Categoría", "Unidad", "Cantidad Vendida", "Operaciones", "Total Ingresos COP"],
        reporteConsolidado.productosMasVendidos.map((p) => [
          p.codigo,
          p.nombre,
          p.categoria,
          p.unidad,
          p.cantidadVendida,
          p.numeroVentas,
          p.totalIngresos
        ])
      );
    case "inventario_actual":
    case "stock_bajo": {
      const lista =
        tipoReporte === "stock_bajo"
          ? reporteConsolidado.productosStockBajo
          : reporteConsolidado.inventarioActual;
      return buildCSV(
        ["Código", "Producto", "Categoría", "Unidad", "Precio Compra COP", "Precio Venta COP", "Stock", "Mínimo", "Estado", "Valorizado Venta COP"],
        lista.map((p) => [
          p.codigo,
          p.nombre,
          p.categoria,
          p.unidad,
          p.precioCompra || 0,
          p.precio,
          p.stock,
          p.stockMinimo,
          p.estadoEtiqueta,
          p.valorVentaTotal
        ])
      );
    }
    case "movimientos_inventario":
      return buildCSV(
        ["Fecha", "Código", "Producto", "Tipo", "Origen", "Cantidad", "Stock Anterior", "Stock Nuevo", "Motivo", "Responsable"],
        reporteConsolidado.movimientosInventario.map((m) => [
          m.fecha,
          m.codigo,
          m.productoNombre,
          m.tipo,
          m.origen,
          `${m.cantidad} ${m.unidad || ""}`.trim(),
          m.stockAnterior,
          m.stockNuevo,
          m.motivo,
          m.usuario
        ])
      );
    case "ingresos_gastos":
      return buildCSV(
        ["Fecha", "Tipo", "Categoría", "Concepto", "Método Pago", "Monto COP", "Responsable"],
        reporteConsolidado.ingresosYGastos.map((m) => [
          m.fecha,
          m.tipo,
          m.categoria,
          m.concepto,
          m.metodoPago || "Efectivo",
          m.monto,
          m.usuario
        ])
      );
    case "metodos_pago":
      return buildCSV(
        ["Método de Pago", "Operaciones", "Total Recibido COP", "Porcentaje %"],
        reporteConsolidado.metodosDePago.map((m) => [
          m.metodo,
          m.operaciones,
          m.total,
          `${m.porcentaje}%`
        ])
      );
    case "cierres_caja":
    case "diferencias_efectivo": {
      const lista =
        tipoReporte === "diferencias_efectivo"
          ? reporteConsolidado.diferenciasEfectivo
          : reporteConsolidado.cierresDeCaja;
      return buildCSV(
        ["Fecha Cierre", "Responsable", "Monto Inicial COP", "Efectivo Esperado COP", "Efectivo Contado COP", "Diferencia COP", "Observaciones"],
        lista.map((c) => [
          c.fechaCierre,
          c.usuarioCierre || c.usuarioApertura,
          c.montoInicial,
          c.efectivoEsperado,
          c.efectivoContado,
          c.diferencia,
          c.observacionesCierre || ""
        ])
      );
    }
    case "anulaciones_devoluciones":
      return buildCSV(
        ["Tipo", "Referencia Venta", "Fecha", "Monto COP", "Motivo", "Autorizado Por"],
        reporteConsolidado.anulacionesYDevoluciones.map((a) => [
          a.tipo,
          a.referencia,
          a.fecha,
          a.monto,
          a.motivo,
          a.usuario
        ])
      );
    default:
      return "";
  }
}
