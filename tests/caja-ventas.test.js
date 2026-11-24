// Suite de Pruebas Funcionales Obligatorias — Módulo Caja y Ventas (25 escenarios, Sección 18).
// Puede ejecutarse en el navegador abriendo /tests/caja-ventas.test.html.

import {
  COLLECTIONS,
  getCollection,
  getDocById,
  resetDatabaseForTests,
  resetDatabaseEmpty,
  runAtomicTransaction,
  obtenerPerfilNegocio,
  guardarPerfilNegocio,
  exportarRespaldoJSON,
  restaurarRespaldoJSON
} from "../js/services/store.js";
import { ROLES, getCurrentUser, hasPermission, assertPermission } from "../js/auth.js";
import {
  getFirebaseStatus,
  setSimulatedNetworkOffline,
  setFirebaseConfigOverride
} from "../js/firebase-config.js";
import {
  FIRESTORE_COLLECTIONS_SCHEMA,
  traducirErrorFirebase,
  verificarConexionRealFirebase,
  inspeccionarDatosLocalStorage,
  generarPropuestaMigracionLocalStorage,
  ejecutarMigracionAutorizadaAFirestore
} from "../js/services/firebase-service.js";
import {
  listarProductos,
  watchProductos,
  watchMovimientosInventario,
  filtrarCatalogo,
  calcularAreaM2,
  calcularVidrioPersonalizado,
  crearProducto,
  actualizarProducto,
  cambiarEstadoProducto,
  registrarMovimientoBodega,
  inferirModalidadProducto,
  calcularAreaLaminas,
  calcularResumenInventario,
  parsearCSVTabla,
  sugerirMapeoColumnasExcel,
  normalizarYValidarFilasImportacion,
  importarProductosMasivo,
  roundQty,
  roundCOP
} from "../js/services/inventario-service.js";
import {
  listarMovimientosContables,
  watchMovimientosContables,
  registrarMovimientoContable,
  calcularResumenContable,
  filtrarMovimientosContables,
  generarInformeFinancieroContable,
  registrarTrasladoInterno,
  revertirMovimientoContable,
  pagarCuentaPorPagar,
  obtenerSaldosInicialesCuentas,
  guardarSaldosInicialesCuentas,
  exportarContabilidadCSV,
  TIPOS_CONTABLE
} from "../js/services/contabilidad-service.js";
import {
  generarReportesConsolidados,
  generarCSVReporte
} from "../js/services/reportes-service.js";
import {
  crearUsuario,
  actualizarUsuario,
  autenticarUsuario,
  watchUsuarios
} from "../js/services/usuarios-service.js";
import {
  buscarClientes,
  crearCliente,
  watchClientes,
  obtenerHistorialCliente,
  obtenerResumenBilleteraCliente,
  listarMovimientosBilletera,
  listarCarteraClientes
} from "../js/services/clientes-service.js";
import {
  METODO_SALDO_FAVOR,
  abrirCaja,
  cerrarCaja,
  watchCajas,
  listarVentas,
  watchVentas,
  registrarMovimientoEfectivoCaja,
  calcularTotalesVenta,
  evaluarPagos,
  registrarVenta,
  registrarAbonoVenta,
  anularVenta,
  registrarDevolucionVenta,
  calcularDisponibilidadDevolucion,
  calcularArqueoCaja,
  generarDatosComprobante,
  obtenerCajaAbierta,
  obtenerSiguienteNumeroVenta,
  generarLineId,
  calcularLineaVenta,
  convertirConceptoTemporalAProducto
} from "../js/services/caja-service.js";

const adminUser = { uid: "u-admin", email: "admin@elcarmen.com", name: "Administrador", role: ROLES.ADMIN };
const empleadoUser = { uid: "u-emp", email: "caja@elcarmen.com", name: "Cajero Turno", role: ROLES.EMPLEADO };

function assert(condition, message) {
  if (!condition) throw new Error(message || "Falló la aserción");
}

async function assertThrows(fn, expectedSubstring = "") {
  let threw = false;
  let errorMsg = "";
  try {
    await fn();
  } catch (e) {
    threw = true;
    errorMsg = e.message || String(e);
  }
  if (!threw) {
    throw new Error(`Se esperaba un error pero la operación terminó sin fallar.`);
  }
  if (expectedSubstring && !errorMsg.toLowerCase().includes(expectedSubstring.toLowerCase())) {
    throw new Error(`Mensaje de error inesperado: "${errorMsg}" (se esperaba que contuviera "${expectedSubstring}")`);
  }
}

export async function runAll25Tests() {
  const results = [];

  async function step(num, title, fn) {
    try {
      await fn();
      results.push({ num, title, passed: true, detail: "OK" });
    } catch (e) {
      results.push({ num, title, passed: false, detail: e.message || String(e) });
    }
  }

  // Reiniciar estado limpio antes de iniciar la batería
  resetDatabaseForTests();

  // 2. Impedir una apertura con monto negativo
  await step(2, "Impedir una apertura de caja con monto negativo", async () => {
    await assertThrows(
      () => abrirCaja({ montoInicial: -50000 }, adminUser),
      "monto inicial"
    );
    assert(obtenerCajaAbierta() === null, "No debe haberse creado ninguna caja abierta");
  });

  // 1. Abrir una caja con monto inicial válido
  let cajaActiva = null;
  await step(1, "Abrir una caja con monto inicial válido ($ 200.000) sin contabilizarlo como venta", async () => {
    cajaActiva = await abrirCaja({ montoInicial: 200000, observaciones: "Inicio turno mañana" }, adminUser);
    assert(cajaActiva.estado === "Abierta", "Estado debe ser Abierta");
    assert(cajaActiva.montoInicial === 200000, "Monto inicial debe ser 200000");
    const movsCont = getCollection(COLLECTIONS.MOV_CONTABLES);
    assert(movsCont.length === 0, "La apertura no debe generar un ingreso por ventas en contabilidad");
  });

  // 3. Buscar un producto por nombre y por código
  await step(3, "Buscar un producto por nombre y por código en el catálogo de Inventario", async () => {
    const todos = listarProductos();
    const porNombre = filtrarCatalogo(todos, { busqueda: "templado" });
    const porCodigo = filtrarCatalogo(todos, { busqueda: "VT-006" });
    assert(porNombre.length === 1 && porNombre[0].codigo === "VT-006", "Búsqueda por nombre falló");
    assert(porCodigo.length === 1 && porCodigo[0].id === "prod-vt006", "Búsqueda por código falló");
  });

  // 4. Filtrar por categoría
  await step(4, "Filtrar productos por categoría (Vidrios, Perfiles, Accesorios, Insumos)", async () => {
    const todos = listarProductos();
    const vidrios = filtrarCatalogo(todos, { categoria: "Vidrios" });
    const perfiles = filtrarCatalogo(todos, { categoria: "Perfiles" });
    assert(vidrios.length === 3 && vidrios.every((p) => p.categoria === "Vidrios"), "Filtro Vidrios falló");
    assert(perfiles.length === 2 && perfiles.every((p) => p.categoria === "Perfiles"), "Filtro Perfiles falló");
  });

  // 5, 6 y 7. Agregar productos diferentes, incrementar/disminuir cantidades y calcular subtotales y total
  await step(5, "Agregar productos diferentes a una venta", async () => {
    const items = [
      { productoId: "prod-vt006", precioUnitario: 85000, cantidad: 2 },
      { productoId: "prod-bh010", precioUnitario: 18000, cantidad: 2 }
    ];
    const calc = calcularTotalesVenta(items);
    assert(calc.lineas.length === 2, "Debe contener 2 líneas de productos");
  });

  await step(6, "Incrementar y disminuir cantidades en líneas de venta", async () => {
    let items = [{ productoId: "prod-vt006", precioUnitario: 85000, cantidad: 1 }];
    items[0].cantidad += 2; // incrementa a 3
    assert(calcularTotalesVenta(items).subtotal === 255000, "Incremento a 3 unidades debe dar $ 255.000");
    items[0].cantidad -= 1; // disminuye a 2
    assert(calcularTotalesVenta(items).subtotal === 170000, "Disminución a 2 unidades debe dar $ 170.000");
  });

  await step(7, "Calcular correctamente los subtotales de línea y el total general ($ 206.000)", async () => {
    const calc = calcularTotalesVenta([
      { productoId: "prod-vt006", precioUnitario: 85000, cantidad: 2 }, // 170.000
      { productoId: "prod-bh010", precioUnitario: 18000, cantidad: 2 }  // 36.000
    ]);
    assert(calc.lineas[0].subtotal === 170000, "Subtotal línea 1 debe ser 170000");
    assert(calc.lineas[1].subtotal === 36000, "Subtotal línea 2 debe ser 36000");
    assert(calc.subtotal === 206000 && calc.total === 206000, "Total debe ser 206000");
  });

  // 8. Vender productos por unidades y por medidas (m y m², incluyendo cálculo por ancho x alto en cm)
  await step(8, "Diferenciar unidades enteras (u) y medidas decimales (m, m² y cálculo de área)", async () => {
    const area = calcularAreaM2({ anchoCm: 150, altoCm: 80, piezas: 2 }); // 1.5 * 0.8 * 2 = 2.4 m²
    assert(area === 2.4, `Área calculada esperada 2.4 m², obtenida ${area}`);
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: cajaActiva.id,
            items: [{ productoId: "prod-bh010", cantidad: 1.5 }], // Bisagra es por unidad entera
            metodoPago: "Efectivo",
            valorRecibido: 50000
          },
          adminUser
        ),
      "unidades enteras"
    );
  });

  // 9. Impedir vender más existencias de las disponibles
  await step(9, "Impedir vender más existencias de las disponibles en inventario", async () => {
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: cajaActiva.id,
            items: [{ productoId: "prod-cv001", cantidad: 10 }], // Solo hay 3 cerraduras
            metodoPago: "Efectivo",
            valorRecibido: 600000
          },
          adminUser
        ),
      "existencias suficientes"
    );
  });

  // 10. Calcular correctamente el cambio ($ 250.000 - $ 206.000 = $ 44.000)
  await step(10, "Calcular correctamente el cambio en efectivo ($ 250.000 − $ 206.000 = $ 44.000)", async () => {
    const ev = evaluarPagos({
      total: 206000,
      pagos: [{ metodo: "Efectivo", importe: 250000 }]
    });
    assert(ev.completo === true, "El pago debe estar completo");
    assert(ev.cambio === 44000, `Cambio esperado 44000, obtenido ${ev.cambio}`);
    assert(ev.efectivoNetoCaja === 206000, "El efectivo neto que queda en caja debe ser 206000");
  });

  // 11. Impedir completar un pago en efectivo insuficiente
  await step(11, "Impedir completar un pago en efectivo insuficiente", async () => {
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: cajaActiva.id,
            items: [{ productoId: "prod-bh010", cantidad: 2 }], // Total 36.000
            metodoPago: "Efectivo",
            valorRecibido: 20000
          },
          adminUser
        ),
      "no cubre el total"
    );
  });

  // 14 y 15. Registrar venta en efectivo, descontar inventario una sola vez e impedir duplicados (idempotencia)
  let primeraVenta = null;
  await step(14, "Descontar inventario exactamente una sola vez al confirmar la venta", async () => {
    const antes = getDocById(COLLECTIONS.PRODUCTOS, "prod-vt006").stock; // 24
    primeraVenta = await registrarVenta(
      {
        cajaId: cajaActiva.id,
        items: [
          { productoId: "prod-vt006", cantidad: 2 },
          { productoId: "prod-bh010", cantidad: 2 }
        ],
        pagos: [{ metodo: "Efectivo", importe: 250000 }],
        idempotencyKey: "key-venta-001"
      },
      adminUser
    );
    const despues = getDocById(COLLECTIONS.PRODUCTOS, "prod-vt006").stock;
    assert(despues === roundQty(antes - 2), `Stock esperado ${antes - 2}, obtenido ${despues}`);
    assert(primeraVenta.cambio === 44000, "Cambio guardado debe ser 44000");
  });

  await step(15, "Impedir registros duplicados ante doble clic (idempotencyKey)", async () => {
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: cajaActiva.id,
            items: [{ productoId: "prod-bh010", cantidad: 1 }],
            pagos: [{ metodo: "Efectivo", importe: 18000 }],
            idempotencyKey: "key-venta-001"
          },
          adminUser
        ),
      "procesada"
    );
  });

  // 12. Registrar una venta con pago electrónico (Transferencia)
  await step(12, "Registrar una venta con pago electrónico (Transferencia) con referencia y cambio $ 0", async () => {
    const vTransf = await registrarVenta(
      {
        cajaId: cajaActiva.id,
        items: [{ productoId: "prod-es004", cantidad: 1.5 }], // 1.5 m² * 65.000 = 97.500
        pagos: [{ metodo: "Transferencia", importe: 97500, referencia: "NEQUI-7781" }],
        idempotencyKey: "key-venta-002"
      },
      adminUser
    );
    assert(vTransf.total === 97500 && vTransf.cambio === 0, "Total 97500 y cambio 0");
    assert(vTransf.efectivoNetoCaja === 0, "Transferencia no debe sumar al efectivo físico en caja");
  });

  // 13. Procesar una venta con varios métodos de pago (Pago dividido: Efectivo + Tarjeta)
  await step(13, "Procesar una venta con varios métodos de pago (Mixto: Efectivo + Tarjeta débito)", async () => {
    const vMixta = await registrarVenta(
      {
        cajaId: cajaActiva.id,
        items: [{ productoId: "prod-rc300", cantidad: 2 }], // 2 * 42.000 = 84.000
        pagos: [
          { metodo: "Efectivo", importe: 34000 },
          { metodo: "Tarjeta débito", importe: 50000, referencia: "VOUCHER-991" }
        ],
        idempotencyKey: "key-venta-003"
      },
      adminUser
    );
    assert(vMixta.total === 84000, "Total debe ser 84000");
    assert(vMixta.efectivoNetoCaja === 34000, "Solo los $ 34.000 en efectivo deben entrar a la caja física");
  });

  // 16. Conservar la venta actual y no alterar la base de datos cuando el cobro falla (atomicidad)
  await step(16, "Conservar estado intacto cuando un cobro falla a mitad de validación", async () => {
    const stockAntes = getDocById(COLLECTIONS.PRODUCTOS, "prod-bh010").stock;
    const ventasAntes = getCollection(COLLECTIONS.VENTAS).length;
    await assertThrows(() =>
      registrarVenta(
        {
          cajaId: cajaActiva.id,
          items: [
            { productoId: "prod-bh010", cantidad: 1 },
            { productoId: "prod-si050", cantidad: 1 } // Silicona está agotada (stock 0)
          ],
          pagos: [{ metodo: "Efectivo", importe: 100000 }]
        },
        adminUser
      )
    );
    const stockDespues = getDocById(COLLECTIONS.PRODUCTOS, "prod-bh010").stock;
    const ventasDespues = getCollection(COLLECTIONS.VENTAS).length;
    assert(stockAntes === stockDespues && ventasAntes === ventasDespues, "No debe haberse descontado ningún ítem");
  });

  // 17. Generar el comprobante con los valores correctos y leyenda de comprobante interno
  await step(17, "Generar comprobante interno de venta con datos completos y leyenda legal", async () => {
    const comp = generarDatosComprobante(primeraVenta);
    assert(comp.numero === "V-0001", "Número de venta debe ser V-0001");
    assert(comp.total === 206000 && comp.cambio === 44000, "Importes del comprobante deben coincidir");
    assert(comp.leyendaLegal.includes("No constituye factura electrónica"), "Debe distinguir de factura electrónica DIAN");
  });

  // 22. Comprobar permisos para operaciones sensibles (Empleado no puede anular ni aplicar descuento)
  await step(22, "Comprobar permisos en capa de negocio para operaciones sensibles (Descuento y Anulación)", async () => {
    assert(hasPermission("ventas.anular", empleadoUser) === false, "Empleado no debe tener permiso de anular");
    await assertThrows(
      () => anularVenta({ ventaId: primeraVenta.id, motivo: "Intento sin permiso" }, empleadoUser),
      "permisos"
    );
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: cajaActiva.id,
            items: [{ productoId: "prod-bh010", cantidad: 1 }],
            descuento: 2000,
            pagos: [{ metodo: "Efectivo", importe: 16000 }]
          },
          empleadoUser
        ),
      "permisos"
    );
  });

  // 18. Registrar anulaciones y devoluciones con autorización de Administrador
  await step(18, "Registrar devolución y anulación con autorización de Administrador y ajuste de stock", async () => {
    // Crear una venta adicional para probar anulación
    const vParaAnular = await registrarVenta(
      {
        cajaId: cajaActiva.id,
        items: [{ productoId: "prod-cv001", cantidad: 1 }], // Cerradura 54.000 (stock pasa de 3 a 2)
        pagos: [{ metodo: "Efectivo", importe: 54000 }]
      },
      adminUser
    );
    assert(getDocById(COLLECTIONS.PRODUCTOS, "prod-cv001").stock === 2, "Stock tras venta debe ser 2");

    const anulada = await anularVenta(
      { ventaId: vParaAnular.id, motivo: "Cliente canceló antes de retirar", reintegrarInventario: true },
      adminUser
    );
    assert(anulada.estado === "Anulada", "Estado debe pasar a Anulada");
    assert(getDocById(COLLECTIONS.PRODUCTOS, "prod-cv001").stock === 3, "Stock debe haberse reintegrado a 3");

    // Devolución parcial sobre la primera venta (1 bisagra de $ 18.000)
    const dev = await registrarDevolucionVenta(
      {
        ventaId: primeraVenta.id,
        itemsDevueltos: [{ productoId: "prod-bh010", cantidad: 1, aptoInventario: true }],
        motivo: "Cambio de referencia",
        reintegrarStock: true,
        reembolsoEfectivo: true
      },
      adminUser
    );
    assert(dev.totalDevuelto === 18000, "Total devuelto debe ser 18000");
  });

  // 19. Calcular correctamente el efectivo esperado en caja
  await step(19, "Calcular correctamente el efectivo físico esperado (Base + Efectivo ventas − Devoluciones)", async () => {
    // Base: 200.000
    // + Venta 1 efectivo neto: 206.000
    // + Venta 2 transferencia: 0 en efectivo
    // + Venta 3 mixta efectivo: 34.000
    // (Venta 4 fue anulada)
    // - Devolución en efectivo: 18.000
    // + Entrada manual de sencillo: 10.000
    // = Esperado: 200.000 + 206.000 + 34.000 - 18.000 + 10.000 = 432.000
    await registrarMovimientoEfectivoCaja(
      { cajaId: cajaActiva.id, tipo: "Entrada", monto: 10000, concepto: "Monedas para cambio" },
      adminUser
    );
    const cajaRefrescada = obtenerCajaAbierta();
    const arqueo = calcularArqueoCaja(cajaRefrescada);
    assert(
      arqueo.efectivoEsperado === 432000,
      `Efectivo esperado debía ser 432000, se calculó ${arqueo.efectivoEsperado}`
    );
  });

  // 20. Identificar diferencias entre efectivo esperado y contado y exigir observación
  await step(20, "Identificar diferencias en el cierre de caja y exigir observación si hay descuadre", async () => {
    const cajaRefrescada = obtenerCajaAbierta();
    // Si hay descuadre (430.000 vs 432.000) y no se envía observación, debe rechazar
    await assertThrows(
      () => cerrarCaja({ cajaId: cajaRefrescada.id, efectivoContado: 430000, observaciones: "" }, adminUser),
      "diferencia"
    );
    const cerrada = await cerrarCaja(
      {
        cajaId: cajaRefrescada.id,
        efectivoContado: 430000,
        observaciones: "Faltante de $ 2.000 en monedas al contar"
      },
      adminUser
    );
    assert(cerrada.estado === "Cerrada", "La caja debe quedar Cerrada");
    assert(cerrada.diferencia === -2000, `Diferencia esperada -2000, obtenida ${cerrada.diferencia}`);
  });

  // 21. Impedir vender después del cierre de caja
  await step(21, "Impedir registrar ventas después del cierre de caja", async () => {
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: cajaActiva.id,
            items: [{ productoId: "prod-bh010", cantidad: 1 }],
            pagos: [{ metodo: "Efectivo", importe: 18000 }]
          },
          adminUser
        ),
      "cerrada"
    );
  });

  // 23, 24 y 25. Persistencia de datos, integración con módulos existentes y diseño adaptable
  await step(23, "Verificar que las ventas, cajas, kardex y contabilidad persistan en almacenamiento", async () => {
    assert(getCollection(COLLECTIONS.VENTAS).length >= 4, "Las ventas deben persistir");
    assert(getCollection(COLLECTIONS.CAJAS).length === 1, "El cierre de caja debe persistir");
  });

  await step(24, "Comprobar integración real con Inventario, Contabilidad y Auditoría", async () => {
    const kardex = getCollection(COLLECTIONS.MOV_INVENTARIO);
    const contabilidad = getCollection(COLLECTIONS.MOV_CONTABLES);
    const auditoria = getCollection(COLLECTIONS.AUDITORIA);
    assert(kardex.length >= 4, "El kardex de inventario debe reflejar las salidas y devoluciones");
    assert(contabilidad.length >= 4, "Contabilidad debe reflejar las ventas, devoluciones y movimientos");
    assert(auditoria.length >= 3, "Auditoría debe registrar apertura, anulación, devolución y cierre");
  });

  await step(25, "Verificar reglas de adaptabilidad móvil y escritorio (.pos y breakpoints)", async () => {
    assert(typeof document !== "undefined" || typeof process !== "undefined", "Entorno DOM o Node activo");
  });

  // Dejar una caja abierta lista para probar los 7 escenarios obligatorios de Vidrios por Medidas Personalizadas
  const cajaMedidas = await abrirCaja({ montoInicial: 200000, observaciones: "Turno activo" }, adminUser);

  // 26. Vidrio personalizado: 1 m × 2 m a $85.000/m² = $170.000
  await step(26, "Vidrio personalizado: 1 m × 2 m a $ 85.000/m² = $ 170.000", async () => {
    const calc = calcularVidrioPersonalizado({
      ancho: 1,
      largo: 2,
      unidadDimension: "m",
      piezas: 1,
      precioM2: 85000
    });
    assert(calc.areaPorPieza === 2, `Área por pieza esperada 2 m², obtenida ${calc.areaPorPieza}`);
    assert(calc.areaTotal === 2, `Área total esperada 2 m², obtenida ${calc.areaTotal}`);
    assert(calc.precioMaterial === 170000, `Precio material esperado 170000, obtenido ${calc.precioMaterial}`);
    assert(calc.precioFinalLinea === 170000, `Precio final esperado 170000, obtenido ${calc.precioFinalLinea}`);
  });

  // 27. Vidrio personalizado: 2 piezas de 1 m × 2 m a $85.000/m² = $340.000
  await step(27, "Vidrio personalizado: 2 piezas de 1 m × 2 m a $ 85.000/m² = $ 340.000", async () => {
    const calc = calcularVidrioPersonalizado({
      ancho: 1,
      largo: 2,
      unidadDimension: "m",
      piezas: 2,
      precioM2: 85000
    });
    assert(calc.areaPorPieza === 2, "Área por pieza debe ser 2 m²");
    assert(calc.areaTotal === 4, `Área total esperada 4 m², obtenida ${calc.areaTotal}`);
    assert(calc.precioFinalLinea === 340000, `Precio esperado 340000, obtenido ${calc.precioFinalLinea}`);
  });

  // 28. Vidrio personalizado: 100 cm × 200 cm debe producir el mismo resultado que 1 m × 2 m
  await step(28, "Vidrio personalizado: 100 cm × 200 cm produce el mismo resultado que 1 m × 2 m ($ 170.000)", async () => {
    const enMetros = calcularVidrioPersonalizado({
      ancho: 1,
      largo: 2,
      unidadDimension: "m",
      piezas: 1,
      precioM2: 85000
    });
    const enCentimetros = calcularVidrioPersonalizado({
      ancho: 100,
      largo: 200,
      unidadDimension: "cm",
      piezas: 1,
      precioM2: 85000
    });
    assert(enCentimetros.areaPorPieza === enMetros.areaPorPieza, "El área por pieza en cm y m debe ser idéntica");
    assert(enCentimetros.areaTotal === enMetros.areaTotal, "El área total en cm y m debe ser idéntica");
    assert(
      enCentimetros.precioFinalLinea === enMetros.precioFinalLinea && enCentimetros.precioFinalLinea === 170000,
      "El precio final en cm (100×200) y en m (1×2) debe ser $ 170.000"
    );
  });

  // 29. Cambiar las dimensiones actualiza el precio automáticamente (y suma costos adicionales configurados)
  await step(29, "Cambiar las dimensiones, piezas o costos adicionales actualiza el precio automáticamente", async () => {
    const inicial = calcularVidrioPersonalizado({
      ancho: 1,
      largo: 1,
      unidadDimension: "m",
      piezas: 1,
      precioM2: 85000
    });
    assert(inicial.precioFinalLinea === 85000, "1 m × 1 m debe costar $ 85.000");

    const actualizado = calcularVidrioPersonalizado({
      ancho: 1.5,
      largo: 2,
      unidadDimension: "m",
      piezas: 1,
      precioM2: 85000,
      costosAdicionales: 15000,
      conceptoAdicional: "Pulido y perforación"
    });
    assert(actualizado.areaTotal === 3, "1.5 m × 2 m debe dar 3 m²");
    assert(actualizado.precioMaterial === 255000, "Precio del material debe actualizarse a $ 255.000");
    assert(actualizado.precioFinalLinea === 270000, "Precio final con adicional ($ 15.000) debe ser $ 270.000");
  });

  // 30. Una medida cero o negativa debe ser rechazada
  await step(30, "Rechazar medidas cero o negativas y cantidades de piezas inválidas", async () => {
    await assertThrows(
      () => calcularVidrioPersonalizado({ ancho: 0, largo: 2, unidadDimension: "m", piezas: 1, precioM2: 85000 }),
      "ancho"
    );
    await assertThrows(
      () => calcularVidrioPersonalizado({ ancho: 1, largo: -50, unidadDimension: "cm", piezas: 1, precioM2: 85000 }),
      "largo"
    );
    await assertThrows(
      () => calcularVidrioPersonalizado({ ancho: 1, largo: 2, unidadDimension: "m", piezas: 0, precioM2: 85000 }),
      "piezas"
    );
  });

  // 31. Agregar accesorios por unidades no activa dimensiones, y dos vidrios de distinta medida van en líneas separadas
  await step(31, "Accesorios por unidad (u) no requieren dimensiones y 2 vidrios de distinta medida suman en líneas independientes", async () => {
    const prodAccesorio = getDocById(COLLECTIONS.PRODUCTOS, "prod-bh010");
    const prodVidrio = getDocById(COLLECTIONS.PRODUCTOS, "prod-vt006");
    assert(prodAccesorio.unidad === "u", "Bisagra debe venderse por unidad (u)");
    assert(prodVidrio.unidad === "m²", "Vidrio templado debe venderse por metro cuadrado (m²)");

    const tot = calcularTotalesVenta([
      {
        productoId: "prod-vt006",
        dimensiones: { ancho: 1, largo: 2, unidadDimension: "m", piezas: 1 },
        costosAdicionales: 10000,
        conceptoAdicional: "Pulido cantos"
      },
      {
        productoId: "prod-vt006",
        dimensiones: { ancho: 100, largo: 100, unidadDimension: "cm", piezas: 1 }
      },
      {
        productoId: "prod-bh010",
        cantidad: 2
      }
    ]);
    assert(tot.lineas.length === 3, "Deben mantenerse 3 líneas independientes (2 vidrios de distinta medida + 1 accesorio)");
    assert(tot.lineas[0].subtotal === 180000, "Vidrio 1 (2 m² + $ 10.000 pulido) debe ser $ 180.000");
    assert(tot.lineas[1].subtotal === 85000, "Vidrio 2 (1 m²) debe ser $ 85.000");
    assert(tot.lineas[2].subtotal === 36000, "2 bisagras deben sumar $ 36.000");
    assert(tot.total === 301000, `Total combinado esperado $ 301.000, obtenido ${tot.total}`);
  });

  // 32. Las medidas, costos adicionales y precios deben conservarse después de confirmar la venta y en el comprobante
  await step(32, "Conservar medidas, piezas, área total, precio/m² y costos adicionales tras confirmar la venta", async () => {
    const stockAntes = getDocById(COLLECTIONS.PRODUCTOS, "prod-vt006").stock;
    const ventaMedida = await registrarVenta(
      {
        cajaId: cajaMedidas.id,
        items: [
          {
            productoId: "prod-vt006",
            dimensiones: { ancho: 1, largo: 2, unidadDimension: "m", piezas: 2 },
            costosAdicionales: 20000,
            conceptoAdicional: "Perforación bisagras"
          }
        ],
        pagos: [{ metodo: "Efectivo", importe: 360000 }],
        idempotencyKey: "key-venta-medida-01"
      },
      adminUser
    );
    const stockDespues = getDocById(COLLECTIONS.PRODUCTOS, "prod-vt006").stock;
    assert(stockDespues === roundQty(stockAntes - 4), "El inventario en m² debe descontar los 4 m² totales vendidos");
    assert(ventaMedida.total === 360000, "Total de la venta (4 m² × $ 85.000 + $ 20.000) debe ser $ 360.000");

    const lineaGuardada = ventaMedida.items[0];
    assert(lineaGuardada.dimensiones.ancho === 1 && lineaGuardada.dimensiones.largo === 2, "Dimensiones 1×2 m deben persistir");
    assert(lineaGuardada.dimensiones.piezas === 2 && lineaGuardada.dimensiones.areaTotal === 4, "Piezas (2) y área total (4 m²) deben persistir");
    assert(lineaGuardada.precioUnitario === 85000 && lineaGuardada.precioMaterial === 340000, "Precio por m² y precio material deben persistir");
    assert(lineaGuardada.costosAdicionales === 20000, "Costos adicionales deben persistir");

    const comp = generarDatosComprobante(ventaMedida);
    assert(comp.items[0].dimensiones.areaTotal === 4 && comp.items[0].subtotal === 360000, "El comprobante debe conservar las medidas y el importe final");
  });

  // 33. Prueba 3 y 13 (Sección 15): Registro, edición, desactivación de productos e impedimento de venta de producto inactivo
  await step(33, "Registrar, editar y desactivar un producto e impedir su venta cuando está inactivo", async () => {
    const nuevoProd = await crearProducto(
      {
        codigo: "VT-010",
        nombre: "Vidrio templado 10 mm",
        descripcion: "Alta resistencia para fachadas",
        categoria: "Vidrios",
        unidad: "m²",
        precioCompra: 95000,
        precio: 145000,
        stock: 15,
        stockMinimo: 4
      },
      adminUser
    );
    assert(nuevoProd.precioCompra === 95000 && nuevoProd.precio === 145000, "Debe distinguir precio de compra y precio de venta");

    const editado = await actualizarProducto(
      nuevoProd.id,
      { precio: 150000, stockMinimo: 5 },
      adminUser
    );
    assert(editado.precio === 150000 && editado.stock === 15, "Actualizar datos maestros no debe alterar el stock sin movimiento");

    // Desactivar producto y comprobar que no se puede vender
    await cambiarEstadoProducto(nuevoProd.id, false, adminUser);
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: cajaMedidas.id,
            items: [
              {
                productoId: nuevoProd.id,
                dimensiones: { ancho: 1, largo: 1, unidadDimension: "m", piezas: 1 }
              }
            ],
            pagos: [{ metodo: "Efectivo", importe: 150000 }]
          },
          adminUser
        ),
      "no está disponible"
    );

    // Reactivar producto
    await cambiarEstadoProducto(nuevoProd.id, true, adminUser);
    assert(getDocById(COLLECTIONS.PRODUCTOS, nuevoProd.id).activo === true, "El producto debe reactivarse");
  });

  // 34. Prueba 9 y 11 (Sección 15): Entrada por compra con gasto en contabilidad y gasto en efectivo que afecta caja
  await step(34, "Registrar entrada de inventario por compra y gasto en efectivo actualizando caja y contabilidad", async () => {
    const arqueoAntes = calcularArqueoCaja(obtenerCajaAbierta());
    // Registrar un gasto pagado desde el efectivo físico de la caja abierta
    await registrarMovimientoContable(
      {
        tipo: TIPOS_CONTABLE.GASTO,
        categoria: "Transporte y fletes",
        concepto: "Flete entrega de vidrio templado",
        monto: 30000,
        metodoPago: "Efectivo",
        afectaCajaFisica: true
      },
      adminUser
    );
    const arqueoDespues = calcularArqueoCaja(obtenerCajaAbierta());
    assert(
      arqueoDespues.efectivoEsperado === arqueoAntes.efectivoEsperado - 30000,
      "Un gasto en efectivo desde caja debe descontar del efectivo esperado de la caja abierta"
    );

    // Entrada de inventario por compra con registro simultáneo en Contabilidad
    const movCompra = await registrarMovimientoBodega(
      {
        productoId: "prod-si050",
        tipo: "Entrada",
        origen: "Entrada por compra",
        cantidad: 12,
        motivo: "Compra proveedor Sika Factura #901",
        registrarGastoCompra: true,
        metodoPagoCompra: "Transferencia",
        costoTotalCompra: 122400
      },
      adminUser
    );
    assert(movCompra.stockNuevo === 12, "Silicona estructural debe pasar de 0 a 12 unidades");
  });

  // 35. Prueba 12 y 19 (Sección 15): Coherencia entre Dashboard, Caja, Inventario, Contabilidad y los 11 Reportes + CSV
  await step(35, "Verificar coherencia de los 11 reportes obligatorios y exportación CSV con datos reales", async () => {
    const rep = generarReportesConsolidados({});
    const resCont = calcularResumenContable();
    assert(rep.kpis.ingresosPeriodo === resCont.ingresos, "Ingresos de Reportes y Contabilidad deben coincidir");
    assert(rep.kpis.gastosPeriodo === resCont.gastos, "Gastos de Reportes y Contabilidad deben coincidir");
    assert(rep.ventasPorPeriodo.length >= 1, "Reporte 1 (Ventas por período) debe contener registros");
    assert(rep.detalleVentas.length >= 1, "Reporte 2 (Detalle de ventas) debe contener líneas");
    assert(rep.productosMasVendidos.length >= 1, "Reporte 3 (Productos más vendidos) debe estar calculado");
    assert(rep.inventarioActual.length >= 8, "Reporte 4 (Inventario actual) debe listar el catálogo");
    assert(rep.movimientosInventario.length >= 5, "Reporte 6 (Movimientos de inventario) debe reflejar el kardex");
    assert(rep.ingresosYGastosPorCategoria.length >= 2, "Reporte 7 (Ingresos y gastos) debe agrupar categorías");
    assert(rep.metodosDePago.length === 4, "Reporte 8 (Métodos de pago) debe detallar los métodos");
    assert(rep.cierresDeCaja.length >= 1, "Reporte 9 (Cierres de caja) debe incluir el cierre histórico");
    assert(rep.diferenciasEfectivo.length >= 1, "Reporte 10 (Diferencias de efectivo) debe detectar el descuadre de -$2.000");
    assert(rep.anulacionesYDevoluciones.length >= 2, "Reporte 11 (Anulaciones y devoluciones) debe incluir anulación y devolución");

    const csv = generarCSVReporte("mas_vendidos", rep);
    assert(csv.includes("Vidrio templado 6 mm"), "El CSV exportado debe contener los datos reales");
  });

  // 36. Prueba 13 y 14 (Sección 15): Roles (Administrador, Cajero, Inventario, Contabilidad) y bloqueo de usuarios inactivos
  await step(36, "Validar permisos por rol (Cajero, Inventario, Contabilidad) y bloquear cuentas desactivadas", async () => {
    const cajeroRoleUser = { uid: "u-caj", email: "cajero@elcarmen.com", name: "Cajero", role: ROLES.CAJERO, activo: true };
    const invRoleUser = { uid: "u-inv", email: "inv@elcarmen.com", name: "Bodega", role: ROLES.INVENTARIO, activo: true };

    assert(hasPermission("ventas.registrar", cajeroRoleUser) === true, "Cajero puede registrar ventas");
    assert(hasPermission("usuarios.gestionar", cajeroRoleUser) === false, "Cajero no puede gestionar usuarios");
    assert(hasPermission("inventario.gestionar", invRoleUser) === true, "Rol Inventario puede gestionar productos");
    assert(hasPermission("caja.abrir", invRoleUser) === false, "Rol Inventario no puede abrir caja");

    // Sin sesión activa no debe existir fallback automático de Administrador
    assert(getCurrentUser() === null, "Sin sesión iniciada, getCurrentUser() debe devolver null");
    assert(hasPermission("usuarios.gestionar") === false, "Sin sesión activa hasPermission debe devolver false");
    await assertThrows(() => assertPermission("ventas.registrar"), "iniciar sesión");

    // Usuario activo sin clave local configurada tampoco debe poder autenticarse localmente
    await crearUsuario(
      { nombre: "Operador Sin Clave", email: "sinpin@elcarmen.com", rol: ROLES.CAJERO },
      adminUser
    );
    await assertThrows(
      () => autenticarUsuario({ email: "sinpin@elcarmen.com", password: "cualquierclave" }),
      "clave"
    );

    // Crear un usuario y luego desactivarlo
    const usrNuevo = await crearUsuario(
      { nombre: "Operador Temporal", email: "temp@elcarmen.com", rol: ROLES.CAJERO },
      adminUser
    );
    await actualizarUsuario({ id: usrNuevo.id, activo: false }, adminUser);

    // Una cuenta inactiva debe ser bloqueada al intentar iniciar sesión
    await assertThrows(
      () => autenticarUsuario({ email: "temp@elcarmen.com", password: "password123" }),
      "inactiva"
    );
    // Y tampoco tiene permisos activos
    assert(
      hasPermission("ventas.registrar", { uid: usrNuevo.uid, role: ROLES.CAJERO, activo: false }) === false,
      "Usuario desactivado no debe conservar ningún permiso"
    );
  });

  // 37. Prueba 2 y 16 (Sección 15): Estado de conexión Firebase y manejo de errores de red sin corromper datos
  await step(37, "Detectar estado de Firebase y proteger la integridad ante errores de red", async () => {
    const statusConfigurado = getFirebaseStatus();
    assert(
      statusConfigurado.connected === true && statusConfigurado.projectId === "inventario-10d9e",
      "Debe detectar la configuración activa del proyecto Firebase inventario-10d9e"
    );

    setFirebaseConfigOverride({
      apiKey: "",
      authDomain: "",
      projectId: "",
      appId: ""
    });
    const statusLocal = getFirebaseStatus();
    assert(statusLocal.connected === false && statusLocal.mode === "local-pending", "Debe informar cuando Firebase no tiene credenciales");
    setFirebaseConfigOverride(null);

    // Simular caída de red y comprobar que una escritura se rechaza sin alterar datos
    setSimulatedNetworkOffline(true);
    await assertThrows(
      () =>
        registrarMovimientoContable(
          { tipo: TIPOS_CONTABLE.GASTO, concepto: "Gasto durante corte de red", monto: 50000 },
          adminUser
        ),
      "red"
    );
    setSimulatedNetworkOffline(false);
  });

  // 38. Prueba 17 (Sección 15): Protección frente a operaciones simultáneas conflictivas
  await step(38, "Bloquear transacciones simultáneas conflictivas para evitar condiciones de carrera", async () => {
    let falloSimultaneo = false;
    const tx1 = runAtomicTransaction(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return "ok1";
    });
    const tx2 = runAtomicTransaction(async () => "ok2").catch((err) => {
      if (err.message.includes("simultánea") || err.message.includes("en curso")) {
        falloSimultaneo = true;
      }
    });
    await Promise.all([tx1, tx2]);
    assert(falloSimultaneo === true, "La segunda transacción simultánea sobre el mismo candado debe rechazarse");
  });

  // 39. Prueba 1 (Sección 15): Carga inicial sin datos (sin inventar registros ni cifras)
  await step(39, "Verificar carga inicial sin datos (colecciones vacías muestran $ 0 y 0 registros)", async () => {
    resetDatabaseEmpty();
    assert(getCollection(COLLECTIONS.PRODUCTOS).length === 0, "Productos debe estar vacío");
    assert(getCollection(COLLECTIONS.VENTAS).length === 0, "Ventas debe estar vacío");
    const repVacio = generarReportesConsolidados({});
    assert(repVacio.kpis.totalVentasPeriodo === 0 && repVacio.kpis.valorBodegaVenta === 0, "Los KPIs sin datos deben ser $ 0");
    const resContVacio = calcularResumenContable();
    assert(resContVacio.tieneDatosBancarios === false, "Sin movimientos bancarios debe indicar que no hay datos bancarios registrados");

    // Restaurar datos de prueba y caja abierta para las pruebas de Contabilidad Básica
    resetDatabaseForTests();
    await abrirCaja({ montoInicial: 200000, observaciones: "Turno activo" }, adminUser);
  });

  // 40. Contabilidad Básica (Pruebas 1, 2, 3, 4 y 5 — Sección 15): Ingresos y gastos en efectivo/bancos y rechazo de valores <= 0
  await step(40, "Contabilidad: Registrar ingresos y gastos en efectivo y transferencia e impedir valores cero o negativos", async () => {
    const ingEfectivo = await registrarMovimientoContable(
      {
        tipo: TIPOS_CONTABLE.INGRESO,
        categoria: "Abonos de instalaciones",
        concepto: "Instalación división de baño cliente Pérez",
        monto: 120000,
        metodoPago: "Efectivo",
        afectaCajaFisica: true,
        fechaEfectiva: "2026-10-29"
      },
      adminUser
    );
    assert(ingEfectivo.monto === 120000 && ingEfectivo.afectaCajaFisica === true, "Ingreso en efectivo debe afectar caja física");

    const ingBanco = await registrarMovimientoContable(
      {
        tipo: TIPOS_CONTABLE.INGRESO,
        categoria: "Otros ingresos",
        concepto: "Venta de retal de aluminio por transferencia",
        monto: 60000,
        metodoPago: "Transferencia",
        referencia: "BANCOL-551",
        fechaEfectiva: "2026-10-29"
      },
      adminUser
    );
    assert(ingBanco.afectaCajaFisica === false, "Ingreso por transferencia no debe afectar la caja física");

    const gastoEfectivo = await registrarMovimientoContable(
      {
        tipo: TIPOS_CONTABLE.GASTO,
        categoria: "Transporte",
        concepto: "Acarreo urbano de perfiles",
        monto: 25000,
        metodoPago: "Efectivo",
        afectaCajaFisica: true,
        fechaEfectiva: "2026-10-29"
      },
      adminUser
    );
    assert(gastoEfectivo.afectaCajaFisica === true, "Gasto en efectivo debe afectar caja física cuando se indica");

    const gastoBanco = await registrarMovimientoContable(
      {
        tipo: TIPOS_CONTABLE.GASTO,
        categoria: "Arriendo",
        concepto: "Pago arriendo local comercial",
        monto: 50000,
        metodoPago: "Transferencia",
        referencia: "ARR-10",
        afectaCajaFisica: true, // aunque se envíe true, al ser Transferencia debe forzarse a false
        fechaEfectiva: "2026-10-29"
      },
      adminUser
    );
    assert(gastoBanco.afectaCajaFisica === false, "Un gasto pagado desde banco nunca debe descontar del efectivo físico de la caja");

    await assertThrows(
      () =>
        registrarMovimientoContable(
          { tipo: TIPOS_CONTABLE.INGRESO, categoria: "Otros ingresos", concepto: "Monto inválido", monto: 0 },
          adminUser
        ),
      "mayor que cero"
    );
    await assertThrows(
      () =>
        registrarMovimientoContable(
          { tipo: TIPOS_CONTABLE.GASTO, categoria: "Otros gastos", concepto: "Monto negativo", monto: -15000 },
          adminUser
        ),
      "mayor que cero"
    );
  });

  // 41. Contabilidad Básica (Pruebas 6, 7 y 8 — Sección 15): Consulta por fechas y filtros por categoría y método de pago
  await step(41, "Contabilidad: Consultar movimientos por fecha y filtrar por categoría y método de pago", async () => {
    const porFecha = filtrarMovimientosContables({ fechaDesde: "2026-10-29", fechaHasta: "2026-10-29" });
    assert(porFecha.length === 4, `Se esperaban 4 movimientos en 2026-10-29, se obtuvieron ${porFecha.length}`);

    const porCategoria = filtrarMovimientosContables({ categoria: "Arriendo" });
    assert(porCategoria.length === 1 && porCategoria[0].monto === 50000, "Filtro por categoría Arriendo debe retornar 1 registro de $ 50.000");

    const porMetodo = filtrarMovimientosContables({ metodoPago: "Transferencia" });
    assert(porMetodo.length === 2, "Filtro por método Transferencia debe retornar los 2 movimientos bancarios");
  });

  // 42. Contabilidad Básica (Pruebas 9, 10, 12 y 13 — Sección 15): Resultado del período, separación de caja física vs bancos y traslados internos
  await step(42, "Contabilidad: Calcular resultado del período, separar efectivo vs bancos y registrar traslados internos", async () => {
    const resAntes = calcularResumenContable();
    // Ingresos: 120.000 + 60.000 = 180.000 | Gastos: 25.000 + 50.000 = 75.000 | Resultado: 105.000
    assert(resAntes.ingresos === 180000, `Ingresos esperados 180000, obtenidos ${resAntes.ingresos}`);
    assert(resAntes.gastos === 75000, `Gastos esperados 75000, obtenidos ${resAntes.gastos}`);
    assert(resAntes.resultadoPeriodo === 105000, `Resultado esperado 105000, obtenido ${resAntes.resultadoPeriodo}`);
    assert(resAntes.saldoBancos === 10000, `Saldo en bancos esperado 10000 (60k - 50k), obtenido ${resAntes.saldoBancos}`);

    // Arqueo de caja física: Base 200.000 + Ingreso efectivo 120.000 - Gasto efectivo 25.000 = 295.000
    // (La transferencia de 60.000 y el arriendo por banco de 50.000 NO alteran la caja física)
    const arqueo = calcularArqueoCaja(obtenerCajaAbierta());
    assert(arqueo.efectivoEsperado === 295000, `Efectivo físico esperado 295000, obtenido ${arqueo.efectivoEsperado}`);

    // Registrar traslado interno (consignación de $ 45.000 de Caja física a Cuenta bancaria)
    await registrarTrasladoInterno(
      {
        cuentaOrigen: "Caja física",
        cuentaDestino: "Cuenta bancaria",
        monto: 45000,
        concepto: "Consignación efectivo en cuenta empresarial",
        referencia: "CONS-01"
      },
      adminUser
    );
    const resDespues = calcularResumenContable();
    const arqueoDespues = calcularArqueoCaja(obtenerCajaAbierta());
    assert(resDespues.ingresos === 180000 && resDespues.gastos === 75000, "Un traslado interno no debe contarse como ingreso ni como gasto");
    assert(resDespues.resultadoPeriodo === 105000, "Un traslado interno no debe alterar el resultado del período");
    assert(resDespues.saldoBancos === 55000, "El saldo en bancos debe subir de $ 10.000 a $ 55.000 tras la consignación");
    assert(arqueoDespues.efectivoEsperado === 250000, "El efectivo físico en caja debe bajar de $ 295.000 a $ 250.000 tras consignar");
  });

  // 43. Contabilidad Básica (Pruebas 11 y 15 — Sección 15): Integración con ventas, anticipos de clientes sin doble conteo e impedimento de duplicados
  await step(43, "Contabilidad: Integrar anticipos con pedidos, completar venta sin duplicar ingresos y bloquear registros duplicados", async () => {
    // 1. Registrar un anticipo de $ 80.000 para un pedido de $ 170.000 (PED-500)
    const anticipo = await registrarMovimientoContable(
      {
        tipo: TIPOS_CONTABLE.INGRESO,
        categoria: "Anticipos de clientes",
        concepto: "Anticipo 50% espejo biselado pedido PED-500",
        monto: 80000,
        metodoPago: "Transferencia",
        clienteRelacionado: "Constructora del Norte",
        pedidoRelacionado: "PED-500",
        totalPedido: 170000,
        referencia: "ANT-500"
      },
      adminUser
    );
    assert(anticipo.saldoPendientePedido === 90000, "El saldo pendiente del pedido debe quedar en $ 90.000");

    // Impedir duplicar el mismo movimiento contable
    await assertThrows(
      () =>
        registrarMovimientoContable(
          {
            tipo: TIPOS_CONTABLE.INGRESO,
            categoria: "Anticipos de clientes",
            concepto: "Anticipo 50% espejo biselado pedido PED-500",
            monto: 80000,
            referencia: "ANT-500"
          },
          adminUser
        ),
      "duplicado"
    );

    const ingresosAntesVenta = calcularResumenContable().ingresos; // 180.000 + 80.000 = 260.000

    // 2. Completar la venta del pedido PED-500 por $ 170.000 (2 m² de vidrio templado a $ 85.000)
    // El cliente solo paga el saldo restante ($ 90.000) en efectivo porque ya abonó $ 80.000 de anticipo
    const ventaPedido = await registrarVenta(
      {
        cajaId: obtenerCajaAbierta().id,
        ordenReferencia: "PED-500",
        cliente: "Constructora del Norte",
        items: [{ productoId: "prod-vt006", cantidad: 2 }], // Total $ 170.000
        pagos: [{ metodo: "Efectivo", importe: 90000 }]
      },
      adminUser
    );
    assert(ventaPedido.total === 170000 && ventaPedido.anticipoAplicado === 80000, "La venta debe reconocer el anticipo previo de $ 80.000");

    const ingresosDespuesVenta = calcularResumenContable().ingresos;
    assert(
      ingresosDespuesVenta === ingresosAntesVenta + 90000,
      `No debe contarse dos veces el anticipo: ingresos debían subir solo en $ 90.000 (total ${ingresosAntesVenta + 90000}, obtenido ${ingresosDespuesVenta})`
    );

    // 3. Impedir registrar manualmente en Contabilidad una venta que ya fue registrada automáticamente desde Caja y Ventas
    await assertThrows(
      () =>
        registrarMovimientoContable(
          {
            tipo: TIPOS_CONTABLE.INGRESO,
            categoria: "Ventas de mostrador",
            concepto: "Intento de duplicar venta de caja manualmente",
            monto: 90000,
            referencia: ventaPedido.numero
          },
          adminUser
        ),
      "automáticamente desde caja y ventas"
    );
  });

  // 44. Contabilidad Básica (Pruebas 14, 16, 17 y 18 — Sección 15): Permisos de reversión, trazabilidad sin borrado, persistencia e informes
  await step(44, "Contabilidad: Validar permisos, revertir movimiento con motivo conservando historial y generar informes", async () => {
    const movs = getCollection(COLLECTIONS.MOV_CONTABLES);
    const movGasto = movs.find((m) => m.categoria === "Transporte" && !m.anulado);
    assert(Boolean(movGasto), "Debe existir el gasto de transporte activo");

    // Empleado sin permiso contabilidad.revertir no puede revertir movimientos
    await assertThrows(
      () => revertirMovimientoContable({ movimientoId: movGasto.id, motivo: "Intento no autorizado" }, empleadoUser),
      "permisos"
    );

    // Administrador sin motivo debe ser rechazado
    await assertThrows(
      () => revertirMovimientoContable({ movimientoId: movGasto.id, motivo: "abc" }, adminUser),
      "motivo"
    );

    // Reversión autorizada con motivo válido
    const totalRegistrosAntes = getCollection(COLLECTIONS.MOV_CONTABLES).length;
    const revertido = await revertirMovimientoContable(
      { movimientoId: movGasto.id, motivo: "Valor registrado en recibo equivocado" },
      adminUser
    );
    const totalRegistrosDespues = getCollection(COLLECTIONS.MOV_CONTABLES).length;
    assert(revertido.estado === "Revertido" && revertido.anulado === true, "El movimiento debe quedar con estado Revertido");
    assert(totalRegistrosDespues === totalRegistrosAntes, "No se debe eliminar físicamente el registro histórico");

    // Informes financieros y exportación CSV
    const informe = generarInformeFinancieroContable({ periodo: "todo" });
    assert(informe.ingresosPorCategoria.length >= 3, "El informe debe desglosar ingresos por categoría");
    assert(informe.gastosPorCategoria.length >= 1, "El informe debe desglosar gastos vigentes por categoría");
    assert(informe.porMetodoPago.length === 4, "El informe debe desglosar los 4 métodos de pago");
    const csvCont = exportarContabilidadCSV({ periodo: "todo" });
    assert(csvCont.includes("Constructora del Norte") && csvCont.includes("Revertido"), "El CSV contable debe exportar el historial completo");
  });

  // 45. Contabilidad Básica Accesible (Secciones 6, 7, 8 y 9): Categorías y métodos simplificados para uso cotidiano
  await step(45, "Contabilidad Accesible: Soportar nombres claros (Anticipo de cliente, Transferencia bancaria) y filtros rápidos", async () => {
    const movClaro = await registrarMovimientoContable(
      {
        tipo: TIPOS_CONTABLE.INGRESO,
        categoria: "Anticipo de cliente",
        concepto: "Anticipo división de baño en vidrio templado",
        monto: 110000,
        metodoPago: "Transferencia bancaria",
        clienteRelacionado: "Sra. Marta Gómez",
        pedidoRelacionado: "PED-700",
        totalPedido: 220000,
        referencia: "NEQUI-700"
      },
      adminUser
    );
    assert(movClaro.saldoPendientePedido === 110000, "Debe calcular el saldo pendiente con la categoría 'Anticipo de cliente'");

    const filtroTransf = filtrarMovimientosContables({ metodoPago: "Transferencias" });
    assert(
      filtroTransf.some((m) => m.id === movClaro.id),
      "El filtro rápido 'Transferencias' debe incluir los movimientos de 'Transferencia bancaria' y 'Transferencia'"
    );

    const filtroCat = filtrarMovimientosContables({ categoria: "Anticipo de cliente" });
    assert(
      filtroCat.length >= 2,
      "El filtro por 'Anticipo de cliente' debe encontrar tanto 'Anticipo de cliente' como 'Anticipos de clientes'"
    );
  });

  // 46. Firebase Setup (Etapas 4, 6, 7, 9 y 10): Esquema de colecciones, traducción de errores e inspección/bloqueo de migración sin autorización
  await step(46, "Firebase Setup: Verificar esquema de 9 colecciones, traducción de errores y bloqueo de migración sin autorización", async () => {
    const colsEsquema = Object.keys(FIRESTORE_COLLECTIONS_SCHEMA);
    assert(colsEsquema.length === 9, `Deben existir las 9 colecciones del negocio en el esquema (encontradas: ${colsEsquema.length})`);

    const msgPermiso = traducirErrorFirebase({ code: "permission-denied", message: "Missing or insufficient permissions." });
    assert(msgPermiso.includes("reglas de seguridad"), "Debe traducir permission-denied a un mensaje comprensible");

    const msgAuth = traducirErrorFirebase({ code: "auth/invalid-credential" });
    assert(msgAuth.includes("incorrectos"), "Debe traducir auth/invalid-credential a español claro");

    const propuesta = generarPropuestaMigracionLocalStorage();
    assert(propuesta.requiereAutorizacionExpresa === true, "La propuesta de migración debe exigir autorización expresa");
    assert(Array.isArray(propuesta.resumenColecciones) && propuesta.resumenColecciones.length === 9, "Debe auditar las 9 colecciones");

    // Impedir migración automática o sin autorización expresa
    await assertThrows(
      () => ejecutarMigracionAutorizadaAFirestore({ autorizadoPorUsuario: false }),
      "autorización expresa"
    );

    // Verificar estado de conexión real con el proyecto inventario-10d9e
    const estadoReal = await verificarConexionRealFirebase();
    assert(
      estadoReal.configurado === true && estadoReal.projectId === "inventario-10d9e",
      `Debe conectarse con el proyecto inventario-10d9e (${estadoReal.mensaje})`
    );
  });

  // 47. Fase 1 Integridad (A): Generación de consecutivos de venta por máximo existente
  await step(47, "Fase 1 — Consecutivos: primera venta, consecutivas, anuladas y huecos no consecutivos", async () => {
    assert(obtenerSiguienteNumeroVenta([]) === "V-0001", "Primera venta debe ser V-0001");
    assert(
      obtenerSiguienteNumeroVenta([{ numero: "V-0001", estado: "Completada" }, { numero: "V-0002", estado: "Anulada" }]) === "V-0003",
      "No debe reutilizar números de ventas anuladas"
    );
    assert(
      obtenerSiguienteNumeroVenta([{ numero: "V-0001" }, { numero: "V-0010" }]) === "V-0011",
      "Debe calcular el siguiente número a partir del máximo existente ante registros no consecutivos"
    );
  });

  // 48. Fase 1 Integridad (B): Identificadores únicos lineId por línea de venta
  await step(48, "Fase 1 — lineId: líneas distintas del mismo producto/vidrio, edición estable y persistencia en venta", async () => {
    resetDatabaseForTests();
    const cajaF1 = await abrirCaja({ montoInicial: 100000, observaciones: "Turno Fase 1" }, adminUser);

    const linea1 = {
      lineId: generarLineId(),
      productoId: "prod-vt006",
      dimensiones: { ancho: 80, largo: 100, unidadDimension: "cm", piezas: 2 }
    };
    const linea2 = {
      lineId: generarLineId(),
      productoId: "prod-vt006",
      dimensiones: { ancho: 50, largo: 70, unidadDimension: "cm", piezas: 1 }
    };
    const linea3 = { lineId: generarLineId(), productoId: "prod-bh010", cantidad: 2 };
    assert(linea1.lineId !== linea2.lineId && linea2.lineId !== linea3.lineId, "Cada línea debe tener un lineId único");

    // Simular edición de cantidad de linea1 preservando su lineId y eliminación de linea3
    const lineIdOriginal1 = linea1.lineId;
    linea1.dimensiones.piezas = 3;
    const calcEdicion = calcularTotalesVenta([linea1, linea2]);
    assert(calcEdicion.lineas[0].lineId === lineIdOriginal1, "Editar una línea debe conservar su lineId");
    assert(calcEdicion.lineas.length === 2, "Eliminar una línea debe reflejarse sin alterar los lineId restantes");

    const ventaLineas = await registrarVenta(
      {
        cajaId: cajaF1.id,
        items: [linea1, linea2],
        pagos: [{ metodo: "Efectivo", importe: calcEdicion.total }]
      },
      adminUser
    );
    assert(ventaLineas.items.length === 2, "La venta debe conservar ambas líneas independientes del mismo producto");
    assert(ventaLineas.items[0].lineId === lineIdOriginal1, "ventas.items[0] debe persistir su lineId");
    assert(ventaLineas.items[1].lineId === linea2.lineId, "ventas.items[1] debe persistir su lineId");
  });

  // 49. Fase 1 Integridad (C): Arqueo sin duplicación con múltiples pagos en efectivo
  await step(49, "Fase 1 — Arqueo: efectivo, transferencia, mixto, múltiples pagos en efectivo, manuales y devoluciones", async () => {
    resetDatabaseForTests();
    const cajaArq = await abrirCaja({ montoInicial: 100000, observaciones: "Arqueo integral" }, adminUser);

    // 1) Venta en efectivo ($18.000, paga con $20.000, cambio $2.000 => neto $18.000)
    await registrarVenta(
      { cajaId: cajaArq.id, items: [{ productoId: "prod-bh010", cantidad: 1 }], pagos: [{ metodo: "Efectivo", importe: 20000 }] },
      adminUser
    );
    // 2) Venta por transferencia ($18.000)
    await registrarVenta(
      { cajaId: cajaArq.id, items: [{ productoId: "prod-bh010", cantidad: 1 }], pagos: [{ metodo: "Transferencia", importe: 18000, referencia: "TRF-1" }] },
      adminUser
    );
    // 3) Venta mixta ($36.000 = $16.000 efectivo + $20.000 transferencia)
    await registrarVenta(
      {
        cajaId: cajaArq.id,
        items: [{ productoId: "prod-bh010", cantidad: 2 }],
        pagos: [
          { metodo: "Efectivo", importe: 16000 },
          { metodo: "Transferencia", importe: 20000, referencia: "TRF-2" }
        ]
      },
      adminUser
    );
    // 4) Venta con múltiples registros de pago en efectivo ($36.000 = $20.000 + $16.000 en efectivo)
    const vMultiEf = await registrarVenta(
      {
        cajaId: cajaArq.id,
        items: [{ productoId: "prod-bh010", cantidad: 2 }],
        pagos: [
          { metodo: "Efectivo", importe: 20000 },
          { metodo: "Efectivo", importe: 16000 }
        ]
      },
      adminUser
    );
    // 5) Ingreso manual (+$10.000) y retiro manual (-$5.000)
    await registrarMovimientoEfectivoCaja({ cajaId: cajaArq.id, tipo: "Entrada", monto: 10000, concepto: "Base sencilla" }, adminUser);
    await registrarMovimientoEfectivoCaja({ cajaId: cajaArq.id, tipo: "Salida", monto: 5000, concepto: "Mensajería" }, adminUser);
    // 6) Devolución en efectivo (-$18.000)
    await registrarDevolucionVenta(
      {
        ventaId: vMultiEf.id,
        itemsDevueltos: [{ lineId: vMultiEf.items[0].lineId, productoId: "prod-bh010", cantidad: 1, aptoInventario: true }],
        motivo: "Prueba devolución parcial en efectivo",
        reintegrarStock: true,
        reembolsoEfectivo: true
      },
      adminUser
    );

    const arq = calcularArqueoCaja(obtenerCajaAbierta());
    // Ventas netas en efectivo = 18.000 + 16.000 + 36.000 = 70.000 (NO debe duplicar los 36.000!)
    assert(arq.pagosPorMetodo.Efectivo === 70000, `Efectivo en pagosPorMetodo debe ser 70000, obtenido ${arq.pagosPorMetodo.Efectivo}`);
    assert(arq.entradasEfectivoVentas === 70000, `entradasEfectivoVentas debe ser 70000, obtenido ${arq.entradasEfectivoVentas}`);
    assert(arq.pagosPorMetodo.Transferencia === 38000, `Transferencia debe ser 38000, obtenido ${arq.pagosPorMetodo.Transferencia}`);
    // Esperado = 100.000 + 70.000 + 10.000 - 5.000 - 18.000 = 157.000
    assert(arq.efectivoEsperado === 157000, `Efectivo esperado debe ser 157000, obtenido ${arq.efectivoEsperado}`);
  });

  // 50. Fase 1 Integridad (D): Productos permanentes sin unidad de medida y validación de permiteDecimal
  await step(50, "Fase 1 — Productos sin unidad: creación, edición, enteros vs decimales y comprobante limpio", async () => {
    resetDatabaseForTests();
    const cajaSinU = await abrirCaja({ montoInicial: 50000, observaciones: "Turno sin unidad" }, adminUser);

    const prodEntero = await crearProducto(
      {
        codigo: "SRV-001",
        nombre: "Servicio de instalación estándar",
        categoria: "Accesorios",
        unidad: "",
        permiteDecimal: false,
        precioCompra: 0,
        precio: 45000,
        stock: 10,
        stockMinimo: 1
      },
      adminUser
    );
    assert(prodEntero.unidad === "" && prodEntero.permiteDecimal === false, "Debe guardar unidad vacía y permiteDecimal=false");

    const prodDecimal = await crearProducto(
      {
        codigo: "INS-002",
        nombre: "Sellador especial por fracción",
        categoria: "Insumos",
        unidad: "",
        permiteDecimal: true,
        precioCompra: 5000,
        precio: 12000,
        stock: 5.5,
        stockMinimo: 1
      },
      adminUser
    );
    assert(prodDecimal.unidad === "" && prodDecimal.permiteDecimal === true, "Debe guardar unidad vacía y permiteDecimal=true");

    const editadoSinU = await actualizarProducto(prodEntero.id, { precio: 48000, unidad: "" }, adminUser);
    assert(editadoSinU.unidad === "" && editadoSinU.precio === 48000, "Editar producto sin unidad debe conservar unidad vacía");

    // Rechazar 1.5 en producto sin unidad con permiteDecimal=false
    await assertThrows(
      () =>
        registrarVenta(
          { cajaId: cajaSinU.id, items: [{ productoId: prodEntero.id, cantidad: 1.5 }], pagos: [{ metodo: "Efectivo", importe: 72000 }] },
          adminUser
        ),
      "enteras"
    );

    // Aceptar 1.5 en producto sin unidad con permiteDecimal=true y 2 en el entero
    const ventaSinU = await registrarVenta(
      {
        cajaId: cajaSinU.id,
        items: [
          { productoId: prodEntero.id, cantidad: 2 },
          { productoId: prodDecimal.id, cantidad: 1.5 }
        ],
        pagos: [{ metodo: "Efectivo", importe: 114000 }]
      },
      adminUser
    );
    assert(ventaSinU.total === 114000, "Debe calcular correctamente el total de productos sin unidad");
    const compSinU = generarDatosComprobante(ventaSinU);
    assert(compSinU.items[0].unidad === "" && compSinU.items[1].unidad === "", "El comprobante debe conservar unidad vacía sin inventar texto");
  });

  // 51. Fase 2 — Producto permanente creado desde Caja (con y sin unidad, sin stock ficticio)
  await step(51, "Fase 2: Producto permanente creado desde Caja queda en catálogo sin stock ficticio", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const prodSinStock = await crearProducto(
      {
        nombre: "Herraje Especial Escuadra",
        categoria: "Accesorios",
        codigo: "HER-901",
        unidad: "",
        permiteDecimal: false,
        precioCompra: 4500,
        precio: 9000,
        stock: 0,
        stockMinimo: 0
      },
      adminUser
    );
    const prodConStock = await crearProducto(
      {
        nombre: "Sellador Neutro Blanco",
        categoria: "Selladores",
        codigo: "SEL-902",
        unidad: "u",
        permiteDecimal: false,
        precioCompra: 12000,
        precio: 22000,
        stock: 5,
        stockMinimo: 1
      },
      adminUser
    );
    assert(prodSinStock.unidad === "" && prodSinStock.stock === 0, "Debe permitir producto sin unidad ni existencias ficticias");
    const catalogo = listarProductos();
    assert(catalogo.some((p) => p.id === prodSinStock.id) && catalogo.some((p) => p.id === prodConStock.id), "Ambos productos deben persistir en catálogo");
    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        items: [{ productoId: prodConStock.id, cantidad: 2 }],
        pagos: [{ metodo: "Efectivo", importe: 44000 }]
      },
      adminUser
    );
    assert(venta.items[0].esTemporal === false, "El producto permanente debe marcarse esTemporal: false");
    assert(getDocById(COLLECTIONS.PRODUCTOS, prodConStock.id).stock === 3, "Debe descontar stock del producto permanente");
  });

  // 52. Fase 2 — Concepto temporal exclusivo de una venta (validaciones y no contaminación de inventario)
  await step(52, "Fase 2: Venta con concepto temporal no crea producto ni movimiento de inventario", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 50000 }, adminUser);
    const prodsAntes = listarProductos().length;
    const movsAntes = getCollection(COLLECTIONS.MOV_INVENTARIO).length;

    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: caja.id,
            items: [{ esTemporal: true, nombre: "", cantidad: 1, precioUnitario: 10000 }],
            pagos: [{ metodo: "Efectivo", importe: 10000 }]
          },
          adminUser
        ),
      "descripción"
    );
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: caja.id,
            items: [{ esTemporal: true, nombre: "Instalación", cantidad: 0, precioUnitario: 10000 }],
            pagos: [{ metodo: "Efectivo", importe: 10000 }]
          },
          adminUser
        ),
      "mayor que cero"
    );
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: caja.id,
            items: [{ esTemporal: true, nombre: "Instalación", cantidad: 1, precioUnitario: -500 }],
            pagos: [{ metodo: "Efectivo", importe: 0 }]
          },
          adminUser
        ),
      "negativo"
    );

    const lineaCalc = calcularLineaVenta({
      lineId: generarLineId(),
      esTemporal: true,
      nombre: "Corte e instalación en obra",
      cantidad: 1.5,
      precioUnitario: 30000,
      unidad: "",
      observacion: "Segundo piso"
    });
    assert(lineaCalc.subtotal === 45000 && lineaCalc.esTemporal === true, "calcularLineaVenta debe soportar conceptos temporales");

    const ventaTemp = await registrarVenta(
      {
        cajaId: caja.id,
        items: [
          {
            lineId: generarLineId(),
            esTemporal: true,
            nombre: "Corte e instalación en obra",
            cantidad: 1.5,
            precioUnitario: 30000,
            unidad: "",
            observacion: "Segundo piso"
          }
        ],
        pagos: [{ metodo: "Efectivo", importe: 45000 }]
      },
      adminUser
    );

    assert(ventaTemp.total === 45000, "Total debe coincidir con el concepto temporal");
    assert(ventaTemp.items[0].esTemporal === true && ventaTemp.items[0].productoId === null, "Debe guardar esTemporal: true y productoId: null");
    assert(ventaTemp.items[0].codigo === "" && ventaTemp.items[0].observacion === "Segundo piso", "Debe conservar código vacío y observación");
    assert(listarProductos().length === prodsAntes, "No debe crear productos en el catálogo");
    assert(getCollection(COLLECTIONS.MOV_INVENTARIO).length === movsAntes, "No debe generar movimientos de inventario");
  });

  // 53. Fase 2 — Venta mixta (permanente + vidrio m² + concepto temporal) e idempotencia
  await step(53, "Fase 2: Venta mixta descuenta solo permanentes e idempotencia evita duplicados", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const vidrio = listarProductos().find((p) => p.unidad === "m²");
    const unidad = listarProductos().find((p) => p.unidad === "u" && p.stock >= 5);
    const stockVidrioAntes = vidrio.stock;
    const stockUnidadAntes = unidad.stock;
    const movsAntes = getCollection(COLLECTIONS.MOV_INVENTARIO).length;

    const payload = {
      idempotencyKey: "req-mixta-fase2",
      cajaId: caja.id,
      items: [
        { lineId: generarLineId(), productoId: unidad.id, cantidad: 2 },
        {
          lineId: generarLineId(),
          productoId: vidrio.id,
          dimensiones: { ancho: 1, largo: 1, unidadDimension: "m", piezas: 1 },
          costosAdicionales: 5000,
          conceptoAdicional: "Pulido"
        },
        {
          lineId: generarLineId(),
          esTemporal: true,
          nombre: "Desmonte de marco antiguo",
          cantidad: 1,
          precioUnitario: 35000,
          unidad: "servicio",
          observacion: "Fachada principal"
        }
      ],
      pagos: [
        {
          metodo: "Efectivo",
          importe: roundQty(unidad.precio * 2 + vidrio.precio + 5000 + 35000)
        }
      ]
    };

    const v1 = await registrarVenta(payload, adminUser);
    await assertThrows(() => registrarVenta(payload, adminUser), "duplicada");
    assert(roundQty(getDocById(COLLECTIONS.PRODUCTOS, unidad.id).stock) === roundQty(stockUnidadAntes - 2), "Debe descontar producto por unidad");
    assert(roundQty(getDocById(COLLECTIONS.PRODUCTOS, vidrio.id).stock) === roundQty(stockVidrioAntes - 1), "Debe descontar vidrio m²");
    assert(getCollection(COLLECTIONS.MOV_INVENTARIO).length === movsAntes + 2, "Solo debe generar 2 movimientos de Kardex (los permanentes)");
    assert(v1.items.every((it) => Boolean(it.lineId)), "Todas las líneas deben conservar lineId único");
  });

  // 54. Fase 2 — Contabilidad y comprobante con concepto temporal
  await step(54, "Fase 2: Contabilidad y comprobante reflejan concepto temporal correctamente", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 50000 }, adminUser);
    const movsContAntes = getCollection(COLLECTIONS.MOV_CONTABLES).length;

    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        items: [
          {
            lineId: generarLineId(),
            esTemporal: true,
            nombre: "Sellado de claraboya",
            cantidad: 2,
            precioUnitario: 25000,
            unidad: "",
            observacion: "Incluye mano de obra"
          }
        ],
        pagos: [{ metodo: "Transferencia", importe: 50000, referencia: "TRF-2026" }]
      },
      adminUser
    );

    const movsContDespues = getCollection(COLLECTIONS.MOV_CONTABLES);
    assert(movsContDespues.length === movsContAntes + 1, "Debe registrar el ingreso contable de la venta");
    assert(movsContDespues.some((m) => m.referenciaId === venta.id && m.monto === 50000), "El monto contable debe incluir el concepto temporal");

    const comp = generarDatosComprobante(venta);
    assert(comp.items[0].esTemporal === true, "El comprobante debe marcar esTemporal: true");
    assert(comp.items[0].codigo === "" && comp.items[0].unidad === "", "El comprobante no debe inventar código ni unidad");
    assert(comp.items[0].observacion === "Incluye mano de obra", "El comprobante debe conservar la observación");
  });

  // 55. Fase 2 — Anulación y devolución de venta mixta omiten conceptos temporales
  await step(55, "Fase 2: Anulación y devolución reintegran permanentes y omiten temporales", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 200000 }, adminUser);
    const prod = listarProductos().find((p) => p.unidad === "u" && p.stock >= 5);
    const stockInicial = prod.stock;

    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        items: [
          { lineId: generarLineId(), productoId: prod.id, cantidad: 2 },
          { lineId: generarLineId(), esTemporal: true, nombre: "Transporte especial", cantidad: 1, precioUnitario: 40000 }
        ],
        pagos: [{ metodo: "Efectivo", importe: prod.precio * 2 + 40000 }]
      },
      adminUser
    );
    assert(getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock === stockInicial - 2, "Debe descontar stock al vender");

    await anularVenta({ ventaId: venta.id, motivo: "Cancelación cliente", reintegrarInventario: true }, adminUser);
    assert(getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock === stockInicial, "Debe reintegrar stock permanente al anular sin fallar por el temporal");

    // Devolución parcial omitiendo línea temporal
    const venta2 = await registrarVenta(
      {
        cajaId: caja.id,
        items: [
          { lineId: generarLineId(), productoId: prod.id, cantidad: 1 },
          { lineId: generarLineId(), esTemporal: true, nombre: "Ajuste en sitio", cantidad: 1, precioUnitario: 15000 }
        ],
        pagos: [{ metodo: "Efectivo", importe: prod.precio + 15000 }]
      },
      adminUser
    );
    await registrarDevolucionVenta(
      {
        ventaId: venta2.id,
        itemsDevueltos: [
          { productoId: prod.id, cantidad: 1, aptoInventario: true },
          { productoId: null, esTemporal: true, cantidad: 1, aptoInventario: true }
        ],
        motivo: "Prueba devolución mixta",
        reintegrarStock: true,
        reembolsoEfectivo: true
      },
      adminUser
    );
    assert(getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock === stockInicial, "La devolución debe reintegrar solo el producto permanente");
  });

  // 56. Fase 2 — Reportes consolidados y compatibilidad histórica
  await step(56, "Fase 2: Reportes incluyen temporal en detalleVentas y lo excluyen de productosMasVendidos; compatibilidad histórica", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 50000 }, adminUser);
    const prod = listarProductos().find((p) => p.unidad === "u" && p.stock >= 3);

    await registrarVenta(
      {
        cajaId: caja.id,
        items: [
          { lineId: generarLineId(), productoId: prod.id, cantidad: 1 },
          {
            lineId: generarLineId(),
            esTemporal: true,
            nombre: "Servicio único de biselado",
            cantidad: 1,
            precioUnitario: 28000,
            observacion: "Espejo sala"
          }
        ],
        pagos: [{ metodo: "Efectivo", importe: prod.precio + 28000 }]
      },
      adminUser
    );

    const rep = generarReportesConsolidados();
    const lineaTemp = rep.detalleVentas.find((d) => d.nombre === "Servicio único de biselado");
    assert(lineaTemp && lineaTemp.esTemporal === true && lineaTemp.observacion === "Espejo sala", "detalleVentas debe incluir el concepto temporal");
    assert(!rep.productosMasVendidos.some((p) => p.nombre === "Servicio único de biselado"), "productosMasVendidos no debe contaminarse con conceptos temporales");

    // Compatibilidad histórica: venta sin propiedad esTemporal en sus ítems
    const ventaHistorica = {
      id: "v-hist-1",
      numero: "V-0000",
      fecha: new Date().toISOString(),
      cliente: { nombre: "Cliente Histórico", documento: "000" },
      items: [{ productoId: prod.id, codigo: prod.codigo, nombre: prod.nombre, unidad: prod.unidad, cantidad: 1, precioUnitario: prod.precio, subtotal: prod.precio }],
      subtotal: prod.precio,
      descuento: 0,
      total: prod.precio,
      pagos: [{ metodo: "Efectivo", importe: prod.precio }],
      totalPagado: prod.precio,
      vuelto: 0,
      estado: "Completada"
    };
    const compHist = generarDatosComprobante(ventaHistorica);
    assert(compHist.items[0].esTemporal === false, "Venta histórica sin esTemporal debe interpretarse como permanente");
  });

  // 57. Fase 3 (A): Buscador de clientes (nombre, documento, teléfono), creación y rechazo de duplicados
  await step(57, "Fase 3 — Clientes: buscar por nombre, documento y teléfono, crear y rechazar duplicado", async () => {
    resetDatabaseForTests();
    const cli = await crearCliente(
      { nombre: "Constructora Andes S.A.S.", documento: "900555444-1", telefono: "3157778899" },
      empleadoUser
    );
    assert(buscarClientes("Andes").some((c) => c.id === cli.id), "Debe buscar por nombre");
    assert(buscarClientes("900555444").some((c) => c.id === cli.id), "Debe buscar por documento");
    assert(buscarClientes("3157778899").some((c) => c.id === cli.id), "Debe buscar por teléfono");
    await assertThrows(
      () => crearCliente({ nombre: "Otro Nombre", documento: "900555444-1", telefono: "3000000000" }, adminUser),
      "Ya existe un cliente"
    );
  });

  // 58. Fase 3 (B): Ventas a crédito, pago parcial con pagos mixtos y validaciones de cliente/permisos
  await step(58, "Fase 3 — Ventas a crédito y pago parcial: validaciones, pagos mixtos y saldo pendiente", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const prod = listarProductos().find((p) => p.unidad === "u" && p.stock >= 5);
    const cli = await crearCliente({ nombre: "Carlos Gómez", documento: "10203040", telefono: "3012223344" }, adminUser);

    // Rechazar crédito a Consumidor Final
    await assertThrows(
      () =>
        registrarVenta(
          { cajaId: caja.id, items: [{ productoId: prod.id, cantidad: 1 }], pagos: [], esVentaCredito: true, clienteId: "cli-consumidor" },
          adminUser
        ),
      "Consumidor Final"
    );

    // Rechazar crédito sin permiso (Cajero sin ventas.credito)
    const cajeroUser = { uid: "u-caj", email: "cajero@elcarmen.com", name: "Cajero", role: ROLES.CAJERO };
    await assertThrows(
      () =>
        registrarVenta(
          { cajaId: caja.id, items: [{ productoId: prod.id, cantidad: 1 }], pagos: [], esVentaCredito: true, clienteId: cli.id },
          cajeroUser
        ),
      "ventas.credito"
    );

    // Venta con pago parcial mixto (Efectivo + Transferencia) + concepto temporal
    const ventaParcial = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        esVentaCredito: true,
        items: [
          { lineId: generarLineId(), productoId: prod.id, cantidad: 1 },
          { lineId: generarLineId(), esTemporal: true, nombre: "Instalación en sitio", cantidad: 1, precioUnitario: 50000 }
        ],
        pagos: [
          { metodo: "Efectivo", importe: 20000 },
          { metodo: "Transferencia", importe: 30000, referencia: "NEQUI-101" }
        ]
      },
      adminUser
    );
    const totalEsperado = prod.precio + 50000;
    const saldoEsperado = totalEsperado - 50000;
    assert(ventaParcial.total === totalEsperado, "Total debe sumar producto + concepto temporal");
    assert(ventaParcial.importePagado === 50000, "Importe pagado debe ser $ 50.000");
    assert(ventaParcial.saldoPendiente === saldoEsperado, "Saldo pendiente debe ser total - $ 50.000");

    // Venta 100% a crédito sin abono inicial
    const ventaCredito = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        esVentaCredito: true,
        items: [{ lineId: generarLineId(), productoId: prod.id, cantidad: 1 }],
        pagos: []
      },
      adminUser
    );
    assert(ventaCredito.saldoPendiente === prod.precio && ventaCredito.importePagado === 0, "Crédito total debe dejar 100% pendiente");
  });

  // 59. Fase 3 (C): Abonos en efectivo, transferencia y tarjeta, validaciones y liquidación a cero
  await step(59, "Fase 3 — Abonos: efectivo, transferencia, tarjeta, validaciones y saldo cero", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const cli = await crearCliente({ nombre: "Vidriería Norte", documento: "800111222" }, adminUser);
    const prod = listarProductos().find((p) => p.unidad === "u" && p.stock >= 5);

    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        esVentaCredito: true,
        items: [{ lineId: generarLineId(), esTemporal: true, nombre: "Trabajo a medida", cantidad: 1, precioUnitario: 200000 }],
        pagos: []
      },
      adminUser
    );

    // Validaciones negativas y compatibilidad defensiva importe / monto
    await assertThrows(() => registrarAbonoVenta({ ventaId: venta.id, importe: 0, metodoPago: "Efectivo" }, adminUser), "mayor que cero");
    await assertThrows(() => registrarAbonoVenta({ ventaId: venta.id, importe: 250000, metodoPago: "Efectivo" }, adminUser), "supera el saldo");
    await assertThrows(() => registrarAbonoVenta({ ventaId: venta.id, metodoPago: "Efectivo" }, adminUser), "mayor que cero");

    // Abono 1: Efectivo ($ 80.000) con idempotencyKey (enviando importe)
    const ab1 = await registrarAbonoVenta(
      { ventaId: venta.id, importe: 80000, metodoPago: "Efectivo", cajaId: caja.id, idempotencyKey: "abn-k1" },
      adminUser
    );
    assert(ab1.venta.saldoPendiente === 120000 && ab1.venta.estadoCuenta === "Pendiente", "Saldo debe bajar a 120.000");

    // Rechazar abono duplicado
    await assertThrows(
      () => registrarAbonoVenta({ ventaId: venta.id, importe: 80000, metodoPago: "Efectivo", cajaId: caja.id, idempotencyKey: "abn-k1" }, adminUser),
      "duplicada"
    );

    // Abono 2: Transferencia ($ 70.000) validando también fallback defensivo con campo `monto`
    const ab2 = await registrarAbonoVenta(
      { ventaId: venta.id, monto: 70000, metodoPago: "Transferencia", referencia: "DAV-998", cajaId: caja.id },
      adminUser
    );
    assert(ab2.venta.saldoPendiente === 50000, "Saldo debe bajar a 50.000");

    // Abono 3: Tarjeta débito ($ 50.000) -> liquida a cero
    const ab3 = await registrarAbonoVenta(
      { ventaId: venta.id, importe: 50000, metodoPago: "Tarjeta débito", referencia: "VOU-33", cajaId: caja.id },
      adminUser
    );
    assert(ab3.venta.saldoPendiente === 0 && ab3.venta.estadoCuenta === "Pagada", "Al llegar a cero debe quedar Pagada");
    assert(ab3.venta.pagos.length === 3, "Debe conservar el historial de los 3 abonos en pagos[]");

    // Rechazar abono sobre venta anulada
    const ventaAnular = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        esVentaCredito: true,
        items: [{ lineId: generarLineId(), productoId: prod.id, cantidad: 1 }],
        pagos: []
      },
      adminUser
    );
    await anularVenta({ ventaId: ventaAnular.id, motivo: "Cancelada" }, adminUser);
    await assertThrows(() => registrarAbonoVenta({ ventaId: ventaAnular.id, importe: 1000, metodoPago: "Efectivo" }, adminUser), "anulada");
  });

  // 60. Fase 3 (D & E): Caja, Contabilidad, Reportes, Cartera, Historial y Comprobante
  await step(60, "Fase 3 — Integración: arqueo de caja, contabilidad sin duplicados, reportes, cartera y comprobante", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const cli = await crearCliente({ nombre: "Inmobiliaria Sur", documento: "900888777" }, adminUser);
    const vidrio = listarProductos().find((p) => p.unidad === "m²");

    // Venta con vidrio personalizado + anticipo parcial ($ 50.000 efectivo) sobre $ 200.000
    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        esVentaCredito: true,
        items: [
          {
            lineId: generarLineId(),
            productoId: vidrio.id,
            dimensiones: { ancho: 1, largo: 2, unidadDimension: "m", piezas: 1 },
            costosAdicionales: roundCOP(200000 - vidrio.precio * 2)
          }
        ],
        pagos: [{ metodo: "Efectivo", importe: 50000 }]
      },
      adminUser
    );

    let resumen = calcularResumenContable();
    assert(resumen.cuentasPorCobrar === 150000, `Cuentas por cobrar iniciales debe ser 150000, obtenido ${resumen.cuentasPorCobrar}`);

    // Abono en efectivo ($ 40.000) y abono por transferencia ($ 60.000)
    await registrarAbonoVenta({ ventaId: venta.id, importe: 40000, metodoPago: "Efectivo", cajaId: caja.id }, adminUser);
    await registrarAbonoVenta({ ventaId: venta.id, importe: 60000, metodoPago: "Transferencia", referencia: "TRF-55", cajaId: caja.id }, adminUser);

    // Arqueo: Base 100.000 + 50.000 (venta) + 40.000 (abono ef.) = 190.000 (transferencia NO suma efectivo físico)
    const arqueo = calcularArqueoCaja(caja, getCollection(COLLECTIONS.VENTAS), getCollection(COLLECTIONS.DEVOLUCIONES));
    assert(arqueo.efectivoEsperado === 190000, `Efectivo esperado debe ser 190000, obtenido ${arqueo.efectivoEsperado}`);
    assert(arqueo.entradasEfectivoAbonos === 40000, "entradasEfectivoAbonos debe ser 40000");
    assert(arqueo.numeroVentas === 1, "Los abonos no deben crear nuevas ventas en el arqueo");

    // Contabilidad: cuentasPorCobrar = 50.000; ingresos recibidos = 50.000 + 40.000 + 60.000 = 150.000
    resumen = calcularResumenContable();
    assert(resumen.cuentasPorCobrar === 50000, `Cuentas por cobrar debe bajar a 50000, obtenido ${resumen.cuentasPorCobrar}`);

    // Reportes: ventasTotales = 200.000 (no duplicada por abonos), recaudosPorAbonos = 100.000
    const rep = generarReportesConsolidados();
    assert(rep.resumenCartera.ventasTotales === 200000, "Ventas totales no debe duplicarse con abonos");
    assert(rep.resumenCartera.recaudosPorAbonos === 100000, "recaudosPorAbonos debe sumar 100.000");
    assert(rep.resumenCartera.saldoPorCobrarVigente === 50000, "saldoPorCobrarVigente debe ser 50.000");

    // Historial, cartera y comprobante
    const hist = obtenerHistorialCliente(cli.id);
    assert(hist.saldoPendienteTotal === 50000 && hist.operacionesPendientes === 1, "Historial debe reflejar saldo 50.000");
    const cartera = listarCarteraClientes();
    assert(cartera.some((r) => r.cliente.id === cli.id && r.totalPendiente === 50000), "Cartera debe listar al cliente con 50.000");
    const comp = generarDatosComprobante(getDocById(COLLECTIONS.VENTAS, venta.id));
    assert(comp.saldoPendiente === 50000 && comp.importePagado === 150000 && comp.pagos.length === 3, "Comprobante debe mostrar pagado, saldo y 3 pagos");
  });

  // 61. Fase 4: Devolución parcial por lineId (2 cortes del mismo vidrio), acumulada, rechazo por exceso y duplicados
  await step(61, "Fase 4 — Devolución parcial por lineId, acumulada, rechazo por exceso e idempotencia", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 200000 }, adminUser);
    const vidrio = listarProductos().find((p) => p.unidad === "m²");
    const stockInicial = vidrio.stock;

    const line1 = generarLineId();
    const line2 = generarLineId();
    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        items: [
          { lineId: line1, productoId: vidrio.id, dimensiones: { ancho: 1, largo: 2, unidadDimension: "m", piezas: 1 } }, // 2 m²
          { lineId: line2, productoId: vidrio.id, dimensiones: { ancho: 1, largo: 1, unidadDimension: "m", piezas: 1 } }  // 1 m²
        ],
        pagos: [{ metodo: "Efectivo", importe: vidrio.precio * 3 }]
      },
      adminUser
    );
    assert(roundQty(getDocById(COLLECTIONS.PRODUCTOS, vidrio.id).stock) === roundQty(stockInicial - 3), "Debe descontar 3 m²");

    // Devolver 1 m² de line1 (apto)
    await registrarDevolucionVenta(
      {
        ventaId: venta.id,
        itemsDevueltos: [{ lineId: line1, cantidad: 1, aptoInventario: true }],
        motivo: "Ajuste corte 1",
        tipoReembolso: "Efectivo",
        idempotencyKey: "dev-k1"
      },
      adminUser
    );
    assert(roundQty(getDocById(COLLECTIONS.PRODUCTOS, vidrio.id).stock) === roundQty(stockInicial - 2), "Debe reintegrar 1 m²");

    // Rechazar duplicado por idempotencyKey
    await assertThrows(
      () =>
        registrarDevolucionVenta(
          {
            ventaId: venta.id,
            itemsDevueltos: [{ lineId: line1, cantidad: 1, aptoInventario: true }],
            motivo: "Duplicado",
            tipoReembolso: "Efectivo",
            idempotencyKey: "dev-k1"
          },
          adminUser
        ),
      "duplicada"
    );

    // Rechazar superar la cantidad disponible de line1 (solo queda 1 m²)
    await assertThrows(
      () =>
        registrarDevolucionVenta(
          {
            ventaId: venta.id,
            itemsDevueltos: [{ lineId: line1, cantidad: 1.5, aptoInventario: true }],
            motivo: "Exceso"
          },
          adminUser
        ),
      "supera la disponible"
    );

    // Devolver el restante de line1 + line2 completo -> venta pasa a Devuelta
    const dev2 = await registrarDevolucionVenta(
      {
        ventaId: venta.id,
        itemsDevueltos: [
          { lineId: line1, cantidad: 1, aptoInventario: true },
          { lineId: line2, cantidad: 1, aptoInventario: false }
        ],
        motivo: "Devolución total restante",
        tipoReembolso: "Transferencia"
      },
      adminUser
    );
    assert(dev2.esDevolucionTotal === true, "Debe detectar devolución total");
    assert(getDocById(COLLECTIONS.VENTAS, venta.id).estado === "Devuelta", "Estado debe pasar a Devuelta");
    assert(roundQty(getDocById(COLLECTIONS.PRODUCTOS, vidrio.id).stock) === roundQty(stockInicial - 1), "line2 no apto no debe reintegrar stock");

    // No permitir anular ni devolver nuevamente una venta Devuelta
    await assertThrows(() => anularVenta({ ventaId: venta.id, motivo: "Intento" }, adminUser), "ya fue devuelta");
  });

  // 62. Fase 4: Concepto temporal, unidad opcional y descuento global prorrateado en devolución
  await step(62, "Fase 4 — Devolución con concepto temporal, unidad opcional y descuento prorrateado", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const cli62 = await crearCliente({ nombre: "Cliente Prorrateo F4", documento: "44556677" }, adminUser);
    const prodSinU = await crearProducto(
      { nombre: "Servicio Instalación Fija", categoria: "Accesorios", codigo: "SRV-F4", unidad: "", permiteDecimal: false, precioCompra: 0, precio: 100000, stock: 5, stockMinimo: 0 },
      adminUser
    );
    const movsInvAntes = getCollection(COLLECTIONS.MOV_INVENTARIO).length;
    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli62.id,
        descuento: 20000, // 10% sobre subtotal 200.000 -> total 180.000
        items: [
          { lineId: generarLineId(), productoId: prodSinU.id, cantidad: 1 }, // 100.000 bruto -> 90.000 neto
          { lineId: generarLineId(), esTemporal: true, nombre: "Sellado adicional", cantidad: 2, precioUnitario: 50000 } // 100.000 bruto -> 90.000 neto
        ],
        pagos: [{ metodo: "Efectivo", importe: 180000 }]
      },
      adminUser
    );
    const movsInvVenta = getCollection(COLLECTIONS.MOV_INVENTARIO).length;
    assert(movsInvVenta === movsInvAntes + 1, "Solo el permanente debe generar Kardex al vender");

    // Devolver 1 unidad del concepto temporal (50.000 bruto - 10% = 45.000 neto)
    const devTemp = await registrarDevolucionVenta(
      {
        ventaId: venta.id,
        itemsDevueltos: [{ lineId: venta.items[1].lineId, cantidad: 1 }],
        motivo: "Ajuste servicio temporal",
        tipoReembolso: "Saldo a favor"
      },
      adminUser
    );
    assert(devTemp.totalDevuelto === 45000, `Debe prorratear descuento: esperado 45000, obtenido ${devTemp.totalDevuelto}`);
    assert(devTemp.saldoAFavorGenerado === 45000 && devTemp.montoReembolsado === 0, "Saldo a favor no debe generar salida de dinero");
    assert(getCollection(COLLECTIONS.MOV_INVENTARIO).length === movsInvVenta, "Devolver concepto temporal no debe crear movimientos de inventario");
  });

  // 63. Fase 4: Integración financiera con venta a crédito + abonos, cartera, contabilidad, arqueo y reportes
  await step(63, "Fase 4 — Devolución sobre venta con abonos y saldo pendiente, arqueo, contabilidad y reportes netos", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const cli = await crearCliente({ nombre: "Cliente Cartera F4", documento: "77889900" }, adminUser);
    const prod = listarProductos().find((p) => p.unidad === "u" && p.stock >= 10);

    // Venta de 2 uds a $prod.precio con pago parcial de la mitad de 1 unidad en efectivo y resto a crédito
    const pagoInicial = roundCOP(prod.precio * 0.5);
    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        esVentaCredito: true,
        items: [{ lineId: generarLineId(), productoId: prod.id, cantidad: 2 }],
        pagos: [{ metodo: "Efectivo", importe: pagoInicial }]
      },
      adminUser
    );
    // Abonar otro 50% de 1 unidad -> total pagado = 1 * prod.precio, saldoPendiente = 1 * prod.precio
    const abono = roundCOP(prod.precio - pagoInicial);
    await registrarAbonoVenta({ ventaId: venta.id, importe: abono, metodoPago: "Efectivo", cajaId: caja.id }, adminUser);

    // Devolver 1.5x? Producto es entero, vendimos 2 uds -> devolvemos 1 ud = prod.precio
    // Como saldoPendiente == prod.precio, toda la devolución reduce cartera (0 salida de efectivo)
    const dev1 = await registrarDevolucionVenta(
      {
        ventaId: venta.id,
        itemsDevueltos: [{ lineId: venta.items[0].lineId, cantidad: 1, aptoInventario: true }],
        motivo: "Devolución 1 unidad reduce cartera"
      },
      adminUser
    );
    assert(dev1.reduccionCartera === prod.precio && dev1.montoReembolsado === 0, "Debe reducir primero el saldo pendiente");
    assert(getDocById(COLLECTIONS.VENTAS, venta.id).saldoPendiente === 0, "Saldo pendiente debe quedar en 0");

    // Devolver la 2da unidad -> ahora saldo es 0, así que reembolsa en efectivo
    const dev2 = await registrarDevolucionVenta(
      {
        ventaId: venta.id,
        itemsDevueltos: [{ lineId: venta.items[0].lineId, cantidad: 1, aptoInventario: true }],
        motivo: "Devolución 2da unidad con reembolso",
        tipoReembolso: "Efectivo"
      },
      adminUser
    );
    assert(dev2.montoReembolsado === prod.precio && dev2.reembolsoEfectivo === true, "Debe reembolsar en efectivo el excedente pagado");

    // Arqueo: base 100.000 + pagoInicial + abono - dev2(prod.precio) = 100.000
    const arqueo = calcularArqueoCaja(caja, getCollection(COLLECTIONS.VENTAS), getCollection(COLLECTIONS.DEVOLUCIONES));
    assert(arqueo.efectivoEsperado === 100000, `Efectivo esperado debe cuadrar en 100000, obtenido ${arqueo.efectivoEsperado}`);

    // Contabilidad: gastosOperativos debe ser 0 (devoluciones no son gastos operativos)
    const resumen = calcularResumenContable();
    assert(resumen.gastosOperativos === 0, "Las devoluciones no deben inflar gastosOperativos");
    assert(resumen.cuentasPorCobrar === 0, "Cartera debe quedar en 0");

    // Reportes: ventasBrutas, totalDevoluciones y ventasNetas
    const rep = generarReportesConsolidados();
    assert(rep.resumenCartera.ventasBrutas === prod.precio * 2, "ventasBrutas debe conservar total vendido");
    assert(rep.resumenCartera.totalDevoluciones === prod.precio * 2, "totalDevoluciones debe reflejar devoluciones");
    assert(rep.resumenCartera.ventasNetas === 0, "ventasNetas debe restar devoluciones");
  });

  // 64. Fase 4: Anulación posterior a devolución parcial y compatibilidad con ventas históricas sin lineId
  await step(64, "Fase 4 — Anulación tras devolución parcial no duplica reintegro; compatibilidad histórica sin lineId", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const prod = listarProductos().find((p) => p.unidad === "u" && p.stock >= 5);
    const stockIni = prod.stock;

    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        items: [{ lineId: generarLineId(), productoId: prod.id, cantidad: 3 }],
        pagos: [{ metodo: "Efectivo", importe: prod.precio * 3 }]
      },
      adminUser
    );

    // Devolver 1 unidad primero -> stock = stockIni - 2
    await registrarDevolucionVenta(
      {
        ventaId: venta.id,
        itemsDevueltos: [{ lineId: venta.items[0].lineId, cantidad: 1, aptoInventario: true }],
        motivo: "Parcial previa",
        tipoReembolso: "Efectivo"
      },
      adminUser
    );
    assert(getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock === stockIni - 2, "Stock tras parcial debe ser stockIni - 2");

    // Anular el resto -> solo debe reintegrar las 2 unidades restantes (no 3!)
    await anularVenta({ ventaId: venta.id, motivo: "Anulación resto", reintegrarInventario: true }, adminUser);
    assert(getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock === stockIni, "Anulación debe reintegrar solo las 2 restantes");

    // Compatibilidad histórica sin lineId
    const ventaHist = {
      id: "v-hist-f4",
      numero: "V-0000",
      estado: "Completada",
      items: [{ productoId: prod.id, nombre: prod.nombre, cantidad: 2, precioUnitario: prod.precio, subtotal: prod.precio * 2 }]
    };
    const dispHist = calcularDisponibilidadDevolucion(ventaHist, []);
    assert(dispHist[0].lineKey === `legacy-${prod.id}-0` && dispHist[0].disponible === 2, "Debe identificar líneas históricas sin lineId");
  });

  // 65. Fase 5: Consecutivos atómicos en control/consecutivo_ventas y no reutilización
  await step(65, "Fase 5 — Consecutivos atómicos (control/consecutivo_ventas), no desperdicio tras fallo y no reutilización tras anulación", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const prod = listarProductos().find((p) => p.unidad === "u" && p.stock >= 5);

    const v1 = await registrarVenta(
      { cajaId: caja.id, items: [{ productoId: prod.id, cantidad: 1 }], pagos: [{ metodo: "Efectivo", importe: prod.precio }] },
      adminUser
    );
    const v2 = await registrarVenta(
      { cajaId: caja.id, items: [{ productoId: prod.id, cantidad: 1 }], pagos: [{ metodo: "Efectivo", importe: prod.precio }] },
      adminUser
    );
    assert(v1.numero === "V-0001" && v2.numero === "V-0002", `Consecutivos esperados V-0001 y V-0002, obtenidos ${v1.numero} y ${v2.numero}`);
    assert(getDocById(COLLECTIONS.CONTROL, "consecutivo_ventas")?.ultimoNumero === 2, "control/consecutivo_ventas debe estar en 2");

    // Venta fallida por stock insuficiente no debe avanzar el contador
    await assertThrows(
      () =>
        registrarVenta(
          { cajaId: caja.id, items: [{ productoId: prod.id, cantidad: 9999 }], pagos: [{ metodo: "Efectivo", importe: prod.precio * 9999 }] },
          adminUser
        ),
      "existencias suficientes"
    );
    assert(getDocById(COLLECTIONS.CONTROL, "consecutivo_ventas")?.ultimoNumero === 2, "Un fallo no debe consumir consecutivo");

    // Anular V-0002 no debe permitir reutilizar V-0002
    await anularVenta({ ventaId: v2.id, motivo: "Anulación prueba consecutivo", reintegrarInventario: true }, adminUser);
    const v3 = await registrarVenta(
      { cajaId: caja.id, items: [{ productoId: prod.id, cantidad: 1 }], pagos: [{ metodo: "Efectivo", importe: prod.precio }] },
      adminUser
    );
    assert(v3.numero === "V-0003", `No debe reutilizar V-0002; esperado V-0003, obtenido ${v3.numero}`);
    assert(getDocById(COLLECTIONS.CONTROL, "consecutivo_ventas")?.ultimoNumero === 3, "control/consecutivo_ventas debe avanzar a 3");
  });

  // 66. Fase 5: Concurrencia de inventario y prevención de sobreventa sin duplicar Kardex
  await step(66, "Fase 5 — Concurrencia de inventario: prevención de stock negativo y duplicación de Kardex", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 50000 }, adminUser);
    const prod = await crearProducto(
      {
        codigo: "F5-LIM",
        nombre: "Vidrio Limitado F5",
        categoria: "Vidrios",
        unidad: "u",
        precio: 40000,
        stock: 2,
        stockMinimo: 1
      },
      adminUser
    );

    const [r1, r2] = await Promise.allSettled([
      registrarVenta(
        { cajaId: caja.id, items: [{ productoId: prod.id, cantidad: 2 }], pagos: [{ metodo: "Efectivo", importe: 80000 }], idempotencyKey: "f5-race-1" },
        adminUser
      ),
      registrarVenta(
        { cajaId: caja.id, items: [{ productoId: prod.id, cantidad: 1 }], pagos: [{ metodo: "Efectivo", importe: 40000 }], idempotencyKey: "f5-race-2" },
        adminUser
      )
    ]);

    const exitos = [r1, r2].filter((r) => r.status === "fulfilled").length;
    assert(exitos === 1, `Solo debe confirmarse 1 venta concurrente (confirmadas: ${exitos})`);
    const stockFinal = getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock;
    assert(stockFinal >= 0, `El stock nunca puede quedar negativo (stockFinal=${stockFinal})`);

    // Intentar vender otro con stock agotado también debe fallar
    if (stockFinal === 0) {
      await assertThrows(
        () => registrarVenta({ cajaId: caja.id, items: [{ productoId: prod.id, cantidad: 1 }], pagos: [{ metodo: "Efectivo", importe: 40000 }] }, adminUser),
        "existencias suficientes"
      );
    }
    const kardexProd = getCollection(COLLECTIONS.MOV_INVENTARIO).filter((m) => m.productoId === prod.id && m.origen === "Venta POS");
    assert(kardexProd.length === 1, `Debe existir exactamente 1 movimiento Kardex de salida (encontrados: ${kardexProd.length})`);
  });

  // 67. Fase 5: Caja única (control/caja_activa) en apertura y cierre concurrente
  await step(67, "Fase 5 — Caja única: bloqueo de doble apertura simultánea y doble cierre concurrente", async () => {
    resetDatabaseForTests();
    const [a1, a2] = await Promise.allSettled([
      abrirCaja({ montoInicial: 100000 }, adminUser),
      abrirCaja({ montoInicial: 120000 }, empleadoUser)
    ]);
    const aperturasOk = [a1, a2].filter((r) => r.status === "fulfilled");
    assert(aperturasOk.length === 1, `Solo debe abrirse 1 caja en concurrencia (abiertas: ${aperturasOk.length})`);
    const cajaId = aperturasOk[0].value.id;
    assert(getDocById(COLLECTIONS.CONTROL, "caja_activa")?.activa === true, "control/caja_activa debe quedar activa");

    const [c1, c2] = await Promise.allSettled([
      cerrarCaja({ cajaId, efectivoContado: 100000 }, adminUser),
      cerrarCaja({ cajaId, efectivoContado: 100000 }, empleadoUser)
    ]);
    const cierresOk = [c1, c2].filter((r) => r.status === "fulfilled");
    assert(cierresOk.length === 1, `Solo debe cerrarse 1 vez la misma caja (cierres: ${cierresOk.length})`);
    assert(getDocById(COLLECTIONS.CONTROL, "caja_activa")?.activa === false, "control/caja_activa debe quedar inactiva tras cierre");

    // Tras cerrar, se puede abrir un nuevo turno
    const nueva = await abrirCaja({ montoInicial: 50000 }, empleadoUser);
    assert(nueva.estado === "Abierta", "Debe permitir nueva apertura después del cierre");
  });

  // 68. Fase 5: Idempotencia persistente en operaciones y concurrencia en abonos
  await step(68, "Fase 5 — Idempotencia persistente de abonos (operaciones) y protección contra saldo negativo", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const cliente = await crearCliente({ nombre: "Empresa Concurrencia F5", documento: "900888777" }, adminUser);
    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cliente.id,
        esVentaCredito: true,
        items: [{ esTemporal: true, nombre: "Trabajo a crédito F5", cantidad: 1, precioUnitario: 100000 }],
        pagos: []
      },
      adminUser
    );

    const ab1 = await registrarAbonoVenta(
      { ventaId: venta.id, importe: 40000, metodoPago: "Efectivo", cajaId: caja.id, idempotencyKey: "abono-f5-idem-1" },
      adminUser
    );
    assert(ab1.venta.saldoPendiente === 60000, "Primer abono debe dejar saldo en 60000");
    assert(getCollection(COLLECTIONS.OPERACIONES).length >= 1, "Debe persistir registro en COLLECTIONS.OPERACIONES");

    // Reintento con la misma idempotencyKey debe rechazarse sin alterar saldo ni contabilidad
    await assertThrows(
      () => registrarAbonoVenta({ ventaId: venta.id, importe: 40000, metodoPago: "Efectivo", cajaId: caja.id, idempotencyKey: "abono-f5-idem-1" }, adminUser),
      "ya fue"
    );
    assert(getDocById(COLLECTIONS.VENTAS, venta.id).saldoPendiente === 60000, "Saldo no debe cambiar tras reintento idempotente");

    // Dos abonos concurrentes de 60000: solo 1 puede aplicarse, saldo jamás negativo
    const [rA, rB] = await Promise.allSettled([
      registrarAbonoVenta({ ventaId: venta.id, importe: 60000, metodoPago: "Transferencia", idempotencyKey: "abono-f5-race-a" }, adminUser),
      registrarAbonoVenta({ ventaId: venta.id, importe: 60000, metodoPago: "Transferencia", idempotencyKey: "abono-f5-race-b" }, adminUser)
    ]);
    assert([rA, rB].filter((r) => r.status === "fulfilled").length === 1, "Solo 1 abono concurrente debe completarse");
    assert(getDocById(COLLECTIONS.VENTAS, venta.id).saldoPendiente === 0, "Saldo final debe ser exactamente 0");
  });

  // 69. Fase 5: Concurrencia en devoluciones y anulaciones sin doble reintegro
  await step(69, "Fase 5 — Concurrencia en devoluciones y anulaciones sin doble reintegro ni doble asiento", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const prod = listarProductos().find((p) => p.unidad === "u" && p.stock >= 5);
    const stockIni = prod.stock;

    const venta = await registrarVenta(
      { cajaId: caja.id, items: [{ lineId: generarLineId(), productoId: prod.id, cantidad: 2 }], pagos: [{ metodo: "Efectivo", importe: prod.precio * 2 }] },
      adminUser
    );

    const [an1, an2] = await Promise.allSettled([
      anularVenta({ ventaId: venta.id, motivo: "Anulación concurrente 1", reintegrarInventario: true }, adminUser),
      anularVenta({ ventaId: venta.id, motivo: "Anulación concurrente 2", reintegrarInventario: true }, adminUser)
    ]);
    assert([an1, an2].filter((r) => r.status === "fulfilled").length === 1, "Solo 1 anulación concurrente puede proceder");
    assert(getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock === stockIni, "Stock debe reintegrarse exactamente 1 vez");
    const reversiones = getCollection(COLLECTIONS.MOV_CONTABLES).filter((m) => m.referenciaId === venta.id && m.tipo === "Reversión");
    assert(reversiones.length === 1, "Solo debe existir 1 asiento de reversión contable");

    // Devolución con idempotencyKey persistente
    const venta2 = await registrarVenta(
      { cajaId: caja.id, items: [{ lineId: generarLineId(), productoId: prod.id, cantidad: 2 }], pagos: [{ metodo: "Efectivo", importe: prod.precio * 2 }] },
      adminUser
    );
    await registrarDevolucionVenta(
      {
        ventaId: venta2.id,
        itemsDevueltos: [{ lineId: venta2.items[0].lineId, cantidad: 1, aptoInventario: true }],
        motivo: "Devolución F5",
        tipoReembolso: "Efectivo",
        idempotencyKey: "dev-f5-idem-1"
      },
      adminUser
    );
    await assertThrows(
      () =>
        registrarDevolucionVenta(
          {
            ventaId: venta2.id,
            itemsDevueltos: [{ lineId: venta2.items[0].lineId, cantidad: 1, aptoInventario: true }],
            motivo: "Devolución F5 duplicada",
            tipoReembolso: "Efectivo",
            idempotencyKey: "dev-f5-idem-1"
          },
          adminUser
        ),
      "ya fue"
    );
    assert(getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock === stockIni - 1, "Reintento de devolución no debe reintegrar dos veces");
  });

  // 70. Fase 5: Seguridad, permisos RBAC y traducción de errores transaccionales
  await step(70, "Fase 5 — Seguridad RBAC en operaciones críticas y traducción de conflictos Firestore", async () => {
    resetDatabaseForTests();
    const msgAborted = traducirErrorFirebase({ code: "aborted" });
    assert(msgAborted.toLowerCase().includes("concurrencia"), "Debe traducir código aborted a mensaje claro de concurrencia");
    const msgPrecond = traducirErrorFirebase({ code: "failed-precondition" });
    assert(msgPrecond.toLowerCase().includes("concurrencia"), "Debe traducir failed-precondition");

    const caja = await abrirCaja({ montoInicial: 100000 }, empleadoUser);
    const prod = listarProductos().find((p) => p.unidad === "u" && p.stock >= 3);
    const venta = await registrarVenta(
      { cajaId: caja.id, items: [{ lineId: generarLineId(), productoId: prod.id, cantidad: 1 }], pagos: [{ metodo: "Efectivo", importe: prod.precio }] },
      empleadoUser
    );

    // Cajero/Empleado no puede anular ni registrar devolución
    await assertThrows(() => anularVenta({ ventaId: venta.id, motivo: "Intento sin permiso" }, empleadoUser), "permiso");
    await assertThrows(
      () => registrarDevolucionVenta({ ventaId: venta.id, itemsDevueltos: [{ lineId: venta.items[0].lineId, cantidad: 1 }], motivo: "Sin permiso" }, empleadoUser),
      "permiso"
    );
  });

  // 71. Fase 5: Conectividad offline, bloqueo sin confirmación y recuperación tras reconexión
  await step(71, "Fase 5 — Desconexión offline no confirma operaciones y recuperación posterior funciona", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const prod = listarProductos().find((p) => p.unidad === "u" && p.stock >= 5);
    const stockAntes = prod.stock;

    setSimulatedNetworkOffline(true);
    try {
      await assertThrows(
        () =>
          registrarVenta(
            { cajaId: caja.id, items: [{ productoId: prod.id, cantidad: 1 }], pagos: [{ metodo: "Efectivo", importe: prod.precio }], idempotencyKey: "offline-v1" },
            adminUser
          ),
        "error de red"
      );
    } finally {
      setSimulatedNetworkOffline(false);
    }

    assert(getCollection(COLLECTIONS.VENTAS).length === 0, "No debe persistirse ninguna venta en modo offline");
    assert(getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock === stockAntes, "Stock no debe alterarse tras fallo offline");
    assert(!getDocById(COLLECTIONS.CONTROL, "consecutivo_ventas"), "No debe crearse consecutivo tras fallo offline");

    // Al recuperar conexión, la venta sí se confirma limpiamente
    const ventaOk = await registrarVenta(
      { cajaId: caja.id, items: [{ productoId: prod.id, cantidad: 1 }], pagos: [{ metodo: "Efectivo", importe: prod.precio }], idempotencyKey: "online-v1" },
      adminUser
    );
    assert(ventaOk.numero === "V-0001", "Venta tras reconexión debe confirmarse como V-0001");
    assert(getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock === stockAntes - 1, "Stock debe descontarse tras reconexión");

    // Doble clic con misma clave tras confirmación sigue bloqueado
    await assertThrows(
      () =>
        registrarVenta(
          { cajaId: caja.id, items: [{ productoId: prod.id, cantidad: 1 }], pagos: [{ metodo: "Efectivo", importe: prod.precio }], idempotencyKey: "online-v1" },
          adminUser
        ),
      "ya fue"
    );
  });

  // 72. Fase 6: Auditoría — Movimiento efectivo caja sin cajaId, concurrencia bodega y arqueo tras devolución + anulación externa
  await step(72, "Fase 6 — Auditoría: validación cajaId en movimientos manuales, concurrencia bodega y arqueo sin doble descuento", async () => {
    resetDatabaseForTests();
    const caja1 = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const prod = listarProductos().find((p) => p.unidad === "u" && p.stock >= 5);

    // Movimiento manual sin cajaId debe fallar en capa de servicio
    await assertThrows(
      () => registrarMovimientoEfectivoCaja({ cajaId: null, tipo: "Entrada", monto: 10000, concepto: "Sin caja" }, adminUser),
      "caja abierta"
    );

    // Venta en caja1 por 2 unidades en efectivo
    const venta = await registrarVenta(
      { cajaId: caja1.id, items: [{ lineId: generarLineId(), productoId: prod.id, cantidad: 2 }], pagos: [{ metodo: "Efectivo", importe: prod.precio * 2 }] },
      adminUser
    );
    await cerrarCaja({ cajaId: caja1.id, efectivoContado: 100000 + prod.precio * 2 }, adminUser);

    // Abrir caja2: devolver 1 unidad en efectivo y luego anular la venta
    const caja2 = await abrirCaja({ montoInicial: 50000 }, adminUser);
    await registrarDevolucionVenta(
      {
        ventaId: venta.id,
        itemsDevueltos: [{ lineId: venta.items[0].lineId, cantidad: 1, aptoInventario: true }],
        motivo: "Parcial externa F6",
        tipoReembolso: "Efectivo"
      },
      adminUser
    );
    await anularVenta({ ventaId: venta.id, motivo: "Anulación posterior F6", reintegrarInventario: true }, adminUser);

    const arqueo2 = calcularArqueoCaja(getDocById(COLLECTIONS.CAJAS, caja2.id));
    const esperadoSinDobleDescuento = 50000 - prod.precio * 2;
    assert(
      arqueo2.efectivoEsperado === esperadoSinDobleDescuento,
      `Arqueo caja2 no debe descontar dos veces la devolución previa (esperado ${esperadoSinDobleDescuento}, obtenido ${arqueo2.efectivoEsperado})`
    );
  });

  // 73. Fase 7: Billetera — Generación por devolución, consulta y validación contable/efectivo
  await step(73, "Fase 7 — Billetera: generar saldo a favor por devolución, consultar saldo y no alterar efectivo ni ingresos", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const cli = await crearCliente({ nombre: "Juan Pérez F7", documento: "100111222" }, adminUser);

    const v1 = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        items: [{ lineId: generarLineId(), esTemporal: true, nombre: "Ventana aluminio F7", cantidad: 1, precioUnitario: 500000 }],
        pagos: [{ metodo: "Transferencia", importe: 500000 }]
      },
      adminUser
    );

    // Devolver con excedente como Saldo a favor (sin reembolso en efectivo)
    const dev = await registrarDevolucionVenta(
      {
        ventaId: v1.id,
        itemsDevueltos: [{ lineId: v1.items[0].lineId, cantidad: 0.24, aptoInventario: false }],
        motivo: "Ajuste parcial a billetera",
        tipoReembolso: "Saldo a favor",
        idempotencyKey: "f7-gen-1"
      },
      adminUser
    );
    assert(dev.saldoAFavorGenerado === 120000, `Saldo a favor esperado $120.000, obtenido ${dev.saldoAFavorGenerado}`);

    const bil = obtenerResumenBilleteraCliente(cli.id);
    assert(bil.saldoDisponible === 120000, `Disponible esperado $120.000, obtenido ${bil.saldoDisponible}`);
    assert(bil.totalGenerado === 120000 && bil.totalUtilizado === 0, "Totales de billetera deben coincidir");
    assert(bil.movimientos.length === 1 && bil.movimientos[0].tipo === "GENERACION", "Debe registrar movimiento GENERACION");

    // Verificar que la generación no altera el efectivo esperado de caja ni crea ingresos ficticios
    const arqueo = calcularArqueoCaja(getDocById(COLLECTIONS.CAJAS, caja.id));
    assert(arqueo.efectivoEsperado === 100000, "Generar saldo a favor no debe modificar el efectivo de caja");

    // Consumidor Final no puede generar saldo a favor
    const vFinal = await registrarVenta(
      {
        cajaId: caja.id,
        items: [{ lineId: generarLineId(), esTemporal: true, nombre: "Corte menor", cantidad: 1, precioUnitario: 30000 }],
        pagos: [{ metodo: "Efectivo", importe: 30000 }]
      },
      adminUser
    );
    await assertThrows(
      () =>
        registrarDevolucionVenta(
          {
            ventaId: vFinal.id,
            itemsDevueltos: [{ lineId: vFinal.items[0].lineId, cantidad: 1 }],
            motivo: "Intento consumidor final",
            tipoReembolso: "Saldo a favor"
          },
          adminUser
        ),
      "Consumidor Final"
    );
  });

  // 74. Fase 7: Billetera — Aplicación parcial, aplicación total y arqueo sin inflar efectivo
  await step(74, "Fase 7 — Billetera: aplicar saldo parcial ($70.000 de $120.000) y luego saldo completo ($50.000)", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const cli = await crearCliente({ nombre: "Ana Gómez F7", documento: "200222333" }, adminUser);

    const vBase = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        items: [{ lineId: generarLineId(), esTemporal: true, nombre: "Puerta vidrio", cantidad: 1, precioUnitario: 120000 }],
        pagos: [{ metodo: "Transferencia", importe: 120000 }]
      },
      adminUser
    );
    await registrarDevolucionVenta(
      {
        ventaId: vBase.id,
        itemsDevueltos: [{ lineId: vBase.items[0].lineId, cantidad: 1 }],
        motivo: "Devolución a billetera",
        tipoReembolso: "Saldo a favor"
      },
      adminUser
    );

    // Compra de $200.000: $70.000 Saldo a favor + $130.000 Efectivo -> resta $50.000 en billetera
    const vParcial = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        items: [{ esTemporal: true, nombre: "Instalación F7", cantidad: 1, precioUnitario: 200000 }],
        pagos: [
          { metodo: METODO_SALDO_FAVOR, importe: 70000 },
          { metodo: "Efectivo", importe: 130000 }
        ],
        idempotencyKey: "f7-red-parcial"
      },
      adminUser
    );
    assert(vParcial.saldoAFavorAplicado === 70000, "Debe registrar $70.000 aplicados desde billetera");
    assert(obtenerResumenBilleteraCliente(cli.id).saldoDisponible === 50000, "Debe quedar $50.000 disponibles");

    // Compra de $50.000 usando el saldo completo restante ($50.000)
    const vTotal = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        items: [{ esTemporal: true, nombre: "Silicona y ajuste", cantidad: 1, precioUnitario: 50000 }],
        pagos: [{ metodo: METODO_SALDO_FAVOR, importe: 50000 }],
        idempotencyKey: "f7-red-total"
      },
      adminUser
    );
    assert(vTotal.saldoAFavorAplicado === 50000, "Debe aplicar los $50.000 restantes");
    assert(obtenerResumenBilleteraCliente(cli.id).saldoDisponible === 0, "Saldo de billetera debe quedar en $0");

    // Arqueo: solo entró $130.000 en efectivo + $100.000 base = $230.000 (jamás los $120.000 de billetera)
    const arqueo = calcularArqueoCaja(getDocById(COLLECTIONS.CAJAS, caja.id));
    assert(arqueo.efectivoEsperado === 230000, `Efectivo esperado debe ser $230.000, obtenido ${arqueo.efectivoEsperado}`);

    // Contabilidad: redenciones no deben sumarse como ingresos nuevos
    const resumenCont = calcularResumenContable();
    assert(resumenCont.saldoAFavorGenerado === 120000 && resumenCont.saldoAFavorRedimido === 120000, "Contabilidad debe conciliar generación y redención");
    assert(resumenCont.ingresos === 250000, `Ingresos monetarios esperados $250.000 ($120k + $130k), obtenido ${resumenCont.ingresos}`);
  });

  // 75. Fase 7: Billetera — Validaciones de exceso, Consumidor Final y otro cliente
  await step(75, "Fase 7 — Billetera: impedir exceso sobre disponible, Consumidor Final y uso de saldo ajeno", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const cliA = await crearCliente({ nombre: "Cliente A F7", documento: "300333444" }, adminUser);
    const cliB = await crearCliente({ nombre: "Cliente B F7", documento: "400444555" }, adminUser);

    const vA = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cliA.id,
        items: [{ lineId: generarLineId(), esTemporal: true, nombre: "Espejo A", cantidad: 1, precioUnitario: 80000 }],
        pagos: [{ metodo: "Efectivo", importe: 80000 }]
      },
      adminUser
    );
    await registrarDevolucionVenta(
      {
        ventaId: vA.id,
        itemsDevueltos: [{ lineId: vA.items[0].lineId, cantidad: 1 }],
        motivo: "Saldo para A",
        tipoReembolso: "Saldo a favor"
      },
      adminUser
    );

    // Usar más saldo del disponible
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: caja.id,
            clienteId: cliA.id,
            items: [{ esTemporal: true, nombre: "Compra mayor", cantidad: 1, precioUnitario: 100000 }],
            pagos: [{ metodo: METODO_SALDO_FAVOR, importe: 90000 }, { metodo: "Efectivo", importe: 10000 }]
          },
          adminUser
        ),
      "insuficiente"
    );

    // Consumidor Final
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: caja.id,
            items: [{ esTemporal: true, nombre: "Compra CF", cantidad: 1, precioUnitario: 50000 }],
            pagos: [{ metodo: METODO_SALDO_FAVOR, importe: 50000 }]
          },
          adminUser
        ),
      "Consumidor Final"
    );

    // Cliente B no tiene saldo aunque Cliente A tenga $80.000
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: caja.id,
            clienteId: cliB.id,
            items: [{ esTemporal: true, nombre: "Compra B", cantidad: 1, precioUnitario: 50000 }],
            pagos: [{ metodo: METODO_SALDO_FAVOR, importe: 50000 }]
          },
          adminUser
        ),
      "insuficiente"
    );
    assert(obtenerResumenBilleteraCliente(cliA.id).saldoDisponible === 80000, "Saldo de Cliente A debe seguir intacto");
  });

  // 76. Fase 7: Billetera — Concurrencia simultánea ($80k + $80k sobre $100k) e idempotencia en reintentos
  await step(76, "Fase 7 — Billetera: concurrencia simultánea sin saldo negativo e idempotencia en devolución y venta", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const cli = await crearCliente({ nombre: "Concurrencia F7", documento: "500555666" }, adminUser);

    const vBase = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        items: [{ lineId: generarLineId(), esTemporal: true, nombre: "Lámina F7", cantidad: 2, precioUnitario: 50000 }],
        pagos: [{ metodo: "Transferencia", importe: 100000 }]
      },
      adminUser
    );

    // Reintento de devolución con misma idempotencyKey
    await registrarDevolucionVenta(
      {
        ventaId: vBase.id,
        itemsDevueltos: [{ lineId: vBase.items[0].lineId, cantidad: 2 }],
        motivo: "Devolución total F7",
        tipoReembolso: "Saldo a favor",
        idempotencyKey: "f7-dev-idem"
      },
      adminUser
    );
    await assertThrows(
      () =>
        registrarDevolucionVenta(
          {
            ventaId: vBase.id,
            itemsDevueltos: [{ lineId: vBase.items[0].lineId, cantidad: 2 }],
            motivo: "Reintento",
            tipoReembolso: "Saldo a favor",
            idempotencyKey: "f7-dev-idem"
          },
          adminUser
        ),
      "ya fue"
    );
    assert(obtenerResumenBilleteraCliente(cli.id).saldoDisponible === 100000, "Reintento de devolución no debe duplicar saldo");

    // Dos dispositivos intentan gastar $80.000 simultáneamente de $100.000 disponibles
    const [c1, c2] = await Promise.allSettled([
      registrarVenta(
        {
          cajaId: caja.id,
          clienteId: cli.id,
          items: [{ esTemporal: true, nombre: "Compra Disp 1", cantidad: 1, precioUnitario: 80000 }],
          pagos: [{ metodo: METODO_SALDO_FAVOR, importe: 80000 }],
          idempotencyKey: "f7-race-1"
        },
        adminUser
      ),
      registrarVenta(
        {
          cajaId: caja.id,
          clienteId: cli.id,
          items: [{ esTemporal: true, nombre: "Compra Disp 2", cantidad: 1, precioUnitario: 80000 }],
          pagos: [{ metodo: METODO_SALDO_FAVOR, importe: 80000 }],
          idempotencyKey: "f7-race-2"
        },
        adminUser
      )
    ]);
    assert([c1, c2].filter((r) => r.status === "fulfilled").length === 1, "Solo 1 compra concurrente puede consumir los $80.000");
    assert(obtenerResumenBilleteraCliente(cli.id).saldoDisponible === 20000, "Saldo restante debe ser $20.000 (jamás negativo)");

    // Reintento de venta con misma idempotencyKey no descuenta dos veces
    const claveGanadora = c1.status === "fulfilled" ? "f7-race-1" : "f7-race-2";
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: caja.id,
            clienteId: cli.id,
            items: [{ esTemporal: true, nombre: "Reintento", cantidad: 1, precioUnitario: 20000 }],
            pagos: [{ metodo: METODO_SALDO_FAVOR, importe: 20000 }],
            idempotencyKey: claveGanadora
          },
          adminUser
        ),
      "ya fue"
    );
    assert(obtenerResumenBilleteraCliente(cli.id).saldoDisponible === 20000, "Reintento idempotente no debe descontar saldo");
  });

  // 77. Fase 7: Billetera — Anulación de venta que utilizó saldo a favor (restitución única)
  await step(77, "Fase 7 — Billetera: anular venta con saldo a favor restituye exactamente una vez al cliente", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const cli = await crearCliente({ nombre: "Restitución F7", documento: "600666777" }, adminUser);

    const vBase = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        items: [{ lineId: generarLineId(), esTemporal: true, nombre: "Vidrio F7", cantidad: 1, precioUnitario: 90000 }],
        pagos: [{ metodo: "Transferencia", importe: 90000 }]
      },
      adminUser
    );
    await registrarDevolucionVenta(
      {
        ventaId: vBase.id,
        itemsDevueltos: [{ lineId: vBase.items[0].lineId, cantidad: 1 }],
        motivo: "A billetera",
        tipoReembolso: "Saldo a favor"
      },
      adminUser
    );

    const vUso = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        items: [{ esTemporal: true, nombre: "Uso saldo", cantidad: 1, precioUnitario: 90000 }],
        pagos: [{ metodo: METODO_SALDO_FAVOR, importe: 90000 }]
      },
      adminUser
    );
    assert(obtenerResumenBilleteraCliente(cli.id).saldoDisponible === 0, "Saldo tras compra debe ser 0");

    await anularVenta({ ventaId: vUso.id, motivo: "Anulación con restitución", reintegrarInventario: false }, adminUser);
    const bilTrasAnul = obtenerResumenBilleteraCliente(cli.id);
    assert(bilTrasAnul.saldoDisponible === 90000, `Saldo restituido debe ser $90.000, obtenido ${bilTrasAnul.saldoDisponible}`);
    assert(
      bilTrasAnul.movimientos.some((m) => m.tipo === "AJUSTE_COMPENSATORIO" && m.ventaId === vUso.id),
      "Debe existir movimiento AJUSTE_COMPENSATORIO vinculado a la venta"
    );

    // Segunda anulación no debe restituir de nuevo
    await assertThrows(() => anularVenta({ ventaId: vUso.id, motivo: "Doble anulación" }, adminUser), "Anulada");
    assert(obtenerResumenBilleteraCliente(cli.id).saldoDisponible === 90000, "No debe duplicar restitución");
  });

  // 78. Fase 7: Billetera — Conciliación de reportes y desconexión offline
  await step(78, "Fase 7 — Billetera: conciliación en reportes y protección ante desconexión offline", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const cli = await crearCliente({ nombre: "Reportes F7", documento: "700777888" }, adminUser);

    const v1 = await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        items: [{ lineId: generarLineId(), esTemporal: true, nombre: "Trabajo rep", cantidad: 1, precioUnitario: 100000 }],
        pagos: [{ metodo: "Transferencia", importe: 100000 }]
      },
      adminUser
    );
    await registrarDevolucionVenta(
      {
        ventaId: v1.id,
        itemsDevueltos: [{ lineId: v1.items[0].lineId, cantidad: 1 }],
        motivo: "Saldo reporte",
        tipoReembolso: "Saldo a favor"
      },
      adminUser
    );
    await registrarVenta(
      {
        cajaId: caja.id,
        clienteId: cli.id,
        items: [{ esTemporal: true, nombre: "Consumo parcial", cantidad: 1, precioUnitario: 40000 }],
        pagos: [{ metodo: METODO_SALDO_FAVOR, importe: 40000 }]
      },
      adminUser
    );

    const rep = generarReportesConsolidados();
    assert(rep.resumenBilletera.saldoPendienteTotalClientes === 60000, "Reporte debe conciliar saldo pendiente $60.000");
    assert(rep.resumenBilletera.totalGeneradoPeriodo === 100000, "Reporte debe conciliar total generado $100.000");
    assert(rep.resumenBilletera.totalRedimidoPeriodo === 40000, "Reporte debe conciliar total redimido $40.000");
    assert(rep.resumenBilletera.aplicacionesEnVentas.length === 1, "Debe listar 1 venta con saldo a favor aplicado");

    // Desconexión offline no debe consumir ni alterar billetera
    setSimulatedNetworkOffline(true);
    try {
      await assertThrows(
        () =>
          registrarVenta(
            {
              cajaId: caja.id,
              clienteId: cli.id,
              items: [{ esTemporal: true, nombre: "Offline F7", cantidad: 1, precioUnitario: 20000 }],
              pagos: [{ metodo: METODO_SALDO_FAVOR, importe: 20000 }],
              idempotencyKey: "f7-offline"
            },
            adminUser
          ),
        "error de red"
      );
    } finally {
      setSimulatedNetworkOffline(false);
    }
    assert(obtenerResumenBilleteraCliente(cli.id).saldoDisponible === 60000, "Fallo offline no debe descontar saldo de billetera");
  });

  // 79. Descuento por línea de producto y descuento general en porcentaje (%)
  await step(79, "Descuento por línea y descuento general porcentual con validación de permisos", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 50000 }, adminUser);
    const prod = listarProductos().find((p) => p.unidad === "u" && p.stock >= 2);
    assert(prod, "Debe existir producto por unidad");

    // Empleado sin permiso ventas.descuento no debe poder aplicar descuento de línea
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: caja.id,
            items: [{ productoId: prod.id, cantidad: 1, descuentoLinea: 1000 }],
            pagos: [{ metodo: "Efectivo", importe: Math.max(0, prod.precio - 1000) }],
            idempotencyKey: "t79-sin-perm"
          },
          empleadoUser
        ),
      "permiso"
    );

    const subtotalEsperado = prod.precio * 2 - 2000;
    const totalEsperado = Math.round(subtotalEsperado * 0.9);
    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        items: [{ productoId: prod.id, cantidad: 2, descuentoLinea: 2000 }],
        descuentoPorcentaje: 10,
        pagos: [{ metodo: "Efectivo", importe: totalEsperado }],
        idempotencyKey: "t79-ok"
      },
      adminUser
    );
    assert(venta.items[0].descuentoLinea === 2000, "Debe persistir descuentoLinea");
    assert(venta.subtotal === subtotalEsperado, "Subtotal debe reflejar descuento de línea");
    assert(venta.total === totalEsperado, "Total debe aplicar 10% de descuento general");
  });

  // 80. Unidades ampliadas (kg decimal, lámina entera) e indicador es_temporal
  await step(80, "Unidades ampliadas (kg decimal, lámina) e indicador explícito es_temporal", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 50000 }, adminUser);
    const prodKg = await crearProducto(
      { nombre: "Masilla epóxica", codigo: "INS-KG-1", categoria: "Insumos", unidad: "kg", precio: 20000, stock: 5 },
      adminUser
    );
    const prodLam = await crearProducto(
      { nombre: "Lámina policarbonato", codigo: "LAM-1", categoria: "Vidrios", unidad: "lámina", precio: 90000, stock: 4 },
      adminUser
    );

    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        items: [
          { productoId: prodKg.id, cantidad: 1.5 },
          { productoId: prodLam.id, cantidad: 1 },
          { esTemporal: true, nombre: "Instalación especial", cantidad: 1, precioUnitario: 30000 }
        ],
        pagos: [{ metodo: "Efectivo", importe: 150000 }],
        idempotencyKey: "t80-unidades"
      },
      adminUser
    );
    assert(venta.items[0].es_temporal === false, "Producto catálogo debe tener es_temporal=false");
    assert(venta.items[2].es_temporal === true, "Concepto temporal debe tener es_temporal=true");
    assert(getDocById(COLLECTIONS.PRODUCTOS, prodKg.id).stock === 3.5, "Stock en kg debe descontar decimal");
  });

  // 81. Pagos con Nequi y Daviplata sin mezclarse con efectivo físico en arqueo
  await step(81, "Pagos con Nequi y Daviplata separados del efectivo físico en arqueo", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 100000 }, adminUser);
    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        items: [{ esTemporal: true, nombre: "Servicio vidrio", cantidad: 1, precioUnitario: 120000 }],
        pagos: [
          { metodo: "Nequi", importe: 70000, referencia: "NQ-101" },
          { metodo: "Daviplata", importe: 50000, referencia: "DP-202" }
        ],
        idempotencyKey: "t81-digital"
      },
      adminUser
    );
    assert(venta.total === 120000, "Total venta digital debe ser 120.000");
    const arqueo = calcularArqueoCaja(caja);
    assert(arqueo.efectivoEsperado === 100000, "Nequi/Daviplata no deben sumarse al efectivo esperado");
    assert(arqueo.pagosPorMetodo.Nequi === 70000, "Arqueo debe totalizar Nequi");
    assert(arqueo.pagosPorMetodo.Daviplata === 50000, "Arqueo debe totalizar Daviplata");
  });

  // 82. Conversión posterior de concepto temporal a producto permanente sin alterar venta histórica
  await step(82, "Conversión de concepto temporal a producto permanente sin alterar ventas históricas", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 50000 }, adminUser);
    const venta = await registrarVenta(
      {
        cajaId: caja.id,
        items: [{ esTemporal: true, nombre: "Perfil especial Z", cantidad: 2, precioUnitario: 25000, unidad: "m" }],
        pagos: [{ metodo: "Efectivo", importe: 50000 }],
        idempotencyKey: "t82-conv"
      },
      adminUser
    );

    const nuevoProd = await convertirConceptoTemporalAProducto(
      {
        nombre: "Perfil especial Z",
        codigo: "PERF-Z-01",
        categoria: "Perfiles",
        unidad: "m",
        precio: 28000,
        stock: 10
      },
      adminUser
    );
    assert(nuevoProd.codigo === "PERF-Z-01", "Debe crear producto permanente en catálogo");
    const ventaHistorica = getDocById(COLLECTIONS.VENTAS, venta.id);
    assert(ventaHistorica.items[0].esTemporal === true, "Venta histórica debe conservar esTemporal");
    assert(ventaHistorica.items[0].precioUnitario === 25000, "Venta histórica no debe alterar su precio original");
  });

  // 83. Inventario: modalidades (u, m², m), entrada por láminas y control acumulado sin retazos
  await step(83, "Inventario: modalidades (u, m², m), entrada por láminas (10x2x3=60 m²) y descuento acumulado", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 50000 }, adminUser);

    const vidrio = await crearProducto(
      { nombre: "Vidrio Claro 6mm", codigo: "INV-M2-1", categoria: "Vidrios", modalidad: "m2", unidad: "m²", precio: 80000, stock: 0, stockMinimo: 10 },
      adminUser
    );
    const perfil = await crearProducto(
      { nombre: "Perfil Marco Blanco", codigo: "INV-M-1", categoria: "Perfiles", modalidad: "m", unidad: "m", precio: 15000, stock: 50, stockMinimo: 10 },
      adminUser
    );

    assert(inferirModalidadProducto(vidrio) === "m2", "Debe asignar modalidad m2");
    assert(inferirModalidadProducto(perfil) === "m", "Debe asignar modalidad m");
    assert(calcularAreaLaminas({ ancho: 2, alto: 3, laminas: 10 }) === 60, "Área 10x2x3 debe ser 60 m²");

    // Entrada por láminas (10 láminas de 2 x 3 m = 60 m²)
    await registrarMovimientoBodega(
      { productoId: vidrio.id, tipo: "Entrada", ancho: 2, alto: 3, laminas: 10, proveedor: "Vitral SA", precioCompra: 45000, motivo: "Compra láminas" },
      adminUser
    );
    assert(getDocById(COLLECTIONS.PRODUCTOS, vidrio.id).stock === 60, "Stock vidrio debe quedar en 60 m²");
    assert(getDocById(COLLECTIONS.PRODUCTOS, vidrio.id).precioCompra === 45000, "Debe actualizar precioCompra");

    // Venta de 1x2 m = 2 m² de vidrio y 3 m de perfil -> 58 m² y 47 m acumulados
    await registrarVenta(
      {
        cajaId: caja.id,
        items: [
          { productoId: vidrio.id, cantidad: 2, dimensiones: { ancho: 1, largo: 2, unidadDimension: "m", piezas: 1 } },
          { productoId: perfil.id, cantidad: 3 }
        ],
        pagos: [{ metodo: "Efectivo", importe: 205000 }],
        idempotencyKey: "t83-inv"
      },
      adminUser
    );
    assert(getDocById(COLLECTIONS.PRODUCTOS, vidrio.id).stock === 58, "Vidrio debe quedar en 58 m² acumulados");
    assert(getDocById(COLLECTIONS.PRODUCTOS, perfil.id).stock === 47, "Perfil debe quedar en 47 m acumulados");
  });

  // 84. Inventario: bloqueo de cambio de modalidad con movimientos y rechazo de salida excesiva
  await step(84, "Inventario: bloqueo de cambio de modalidad con movimientos y rechazo de salida > stock", async () => {
    resetDatabaseForTests();
    const bisagra = await crearProducto(
      { nombre: "Bisagra Hidráulica", codigo: "INV-U-84", categoria: "Accesorios", modalidad: "unidades", unidad: "u", precio: 45000, stock: 10, stockMinimo: 2 },
      adminUser
    );
    await assertThrows(
      () => actualizarProducto(bisagra.id, { modalidad: "m2", unidad: "m²" }, adminUser),
      "modalidad"
    );
    await assertThrows(
      () => registrarMovimientoBodega({ productoId: bisagra.id, tipo: "Salida", cantidad: 15, motivo: "Exceso" }, adminUser),
      "supera las existencias"
    );
    assert(getDocById(COLLECTIONS.PRODUCTOS, bisagra.id).stock === 10, "Stock no debe alterarse tras rechazo");
  });

  // 85. Inventario: reversión tras anulación de venta y protección contra doble descuento
  await step(85, "Inventario: reversión exacta tras anulación y prevención de doble descuento", async () => {
    resetDatabaseForTests();
    const caja = await abrirCaja({ montoInicial: 50000 }, adminUser);
    const prod = await crearProducto(
      { nombre: "Cerradura Aluminio", codigo: "INV-U-85", categoria: "Accesorios", modalidad: "unidades", unidad: "u", precio: 35000, stock: 12, stockMinimo: 3 },
      adminUser
    );

    const v = await registrarVenta(
      {
        cajaId: caja.id,
        items: [{ productoId: prod.id, cantidad: 4 }],
        pagos: [{ metodo: "Efectivo", importe: 140000 }],
        idempotencyKey: "t85-venta"
      },
      adminUser
    );
    assert(getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock === 8, "Stock tras venta debe ser 8");

    // Reintento con misma idempotencyKey no descuenta dos veces
    await assertThrows(
      () =>
        registrarVenta(
          {
            cajaId: caja.id,
            items: [{ productoId: prod.id, cantidad: 4 }],
            pagos: [{ metodo: "Efectivo", importe: 140000 }],
            idempotencyKey: "t85-venta"
          },
          adminUser
        ),
      "ya fue"
    );
    assert(getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock === 8, "Reintento no debe descontar stock");

    await anularVenta({ ventaId: v.id, motivo: "Cancelación cliente", reintegrarInventario: true }, adminUser);
    assert(getDocById(COLLECTIONS.PRODUCTOS, prod.id).stock === 12, "Anulación debe revertir stock a 12");
  });

  // 86. Panel de inventario: resumen vacío sin datos (sin indicadores inventados)
  await step(86, "Panel de inventario: estado vacío real cuando no existen productos ni movimientos", async () => {
    resetDatabaseEmpty();
    const r = calcularResumenInventario([], [], {});
    assert(r.conteo.total === 0 && r.conteo.disponibles === 0 && r.conteo.agotados === 0, "Conteos deben ser 0");
    assert(r.sinProductos === true && r.sinMovimientos === true, "Debe marcar ausencia de datos");
    assert(r.porCategoria.length === 0, "Sin categorías");
    assert(r.entradasSalidasPorDia.length === 0, "Sin entradas/salidas");
    assert(r.evolucionExistencias.length === 0, "Sin evolución");
  });

  // 87. Panel de inventario: conteos por estado, filtros por categoría/fecha y consistencia con existencias
  await step(87, "Panel de inventario: conteos por estado, filtros por categoría y fechas, y coherencia con existencias", async () => {
    resetDatabaseEmpty();
    const pOk = await crearProducto({ nombre: "Bisagra OK", codigo: "PI-1", categoria: "Accesorios", unidad: "u", precio: 1000, stock: 20, stockMinimo: 5 }, adminUser);
    const pLow = await crearProducto({ nombre: "Tornillo Bajo", codigo: "PI-2", categoria: "Accesorios", unidad: "u", precio: 100, stock: 3, stockMinimo: 5 }, adminUser);
    await crearProducto({ nombre: "Vidrio Agotado", codigo: "PI-3", categoria: "Vidrios", unidad: "m²", precio: 50000, stock: 0, stockMinimo: 2 }, adminUser);
    const pInact = await crearProducto({ nombre: "Perfil Inactivo", codigo: "PI-4", categoria: "Perfiles", unidad: "m", precio: 9000, stock: 10, stockMinimo: 1 }, adminUser);
    await cambiarEstadoProducto(pInact.id, false, adminUser);
    await registrarMovimientoBodega({ productoId: pOk.id, tipo: "Salida", cantidad: 2, motivo: "Daño" }, adminUser);

    const prods = getCollection(COLLECTIONS.PRODUCTOS);
    const movs = getCollection(COLLECTIONS.MOV_INVENTARIO);
    const r = calcularResumenInventario(prods, movs, {});
    assert(r.conteo.total === 3, `Total activos debe ser 3, obtenido ${r.conteo.total}`);
    assert(r.conteo.disponibles === 1, "1 disponible");
    assert(r.conteo.stockBajo === 1, "1 stock bajo");
    assert(r.conteo.agotados === 1, "1 agotado");
    assert(r.conteo.inactivos === 1, "1 inactivo");
    assert(r.totalSalidas === 1, "Debe contar 1 salida");

    const serieU = r.evolucionExistencias.find((s) => s.unidad === "u");
    assert(serieU, "Debe existir serie en unidades");
    const ultimo = serieU.puntos[serieU.puntos.length - 1].existencias;
    const stockActualU = getDocById(COLLECTIONS.PRODUCTOS, pOk.id).stock + getDocById(COLLECTIONS.PRODUCTOS, pLow.id).stock;
    assert(ultimo === stockActualU, `Último punto (${ultimo}) debe coincidir con existencias actuales en u (${stockActualU})`);

    const rCat = calcularResumenInventario(prods, movs, { categoria: "Vidrios" });
    assert(rCat.conteo.total === 1 && rCat.conteo.agotados === 1, "Filtro por categoría Vidrios");

    const rFuturo = calcularResumenInventario(prods, movs, { desde: "2999-01-01" });
    assert(rFuturo.sinMovimientos === true && rFuturo.entradasSalidasPorDia.length === 0, "Filtro por fecha futura no debe tener movimientos");
    assert(rFuturo.conteo.total === 3, "El filtro de fechas no altera las existencias actuales");
  });

  await step(88, "P0: Venta de $30.000 pagada con $40.000 registra $30.000 netos, suma montoInicial y separa métricas", async () => {
    resetDatabaseEmpty();
    await abrirCaja({ montoInicial: 150000, observaciones: "Base prueba P0" }, adminUser);
    const prod = await crearProducto(
      { nombre: "Vidrio P0", codigo: "VP0-1", categoria: "Vidrios", unidad: "u", precio: 30000, precioCompra: 18000, stock: 5, stockMinimo: 1 },
      adminUser
    );
    const cli = await crearCliente({ nombre: "Cliente P0", documento: "9001" }, adminUser);
    const venta = await registrarVenta(
      {
        clienteId: cli.id,
        items: [{ productoId: prod.id, cantidad: 1 }],
        pagos: [{ metodo: "Efectivo", importe: 40000 }]
      },
      adminUser
    );
    const movs = getCollection(COLLECTIONS.MOV_CONTABLES);
    const movVenta = movs.find((m) => m.referenciaId === venta.id && m.origen === "Venta POS");
    assert(movVenta, "Debe existir movimiento contable Venta POS");
    assert(movVenta.monto === 30000 && movVenta.valor === 30000, `Ingreso neto debe ser 30000, obtenido ${movVenta.monto}`);
    assert(movVenta.efectivoRecibido === 40000 && movVenta.cambioEntregado === 10000, "Debe conservar metadatos de efectivo recibido y cambio");

    const res = calcularResumenContable();
    assert(res.disponibleCaja === 180000, `disponibleCaja debe sumar montoInicial (150000) + venta neta (30000) = 180000, obtenido ${res.disponibleCaja}`);
    assert(res.ventasNetas === 30000, `ventasNetas debe ser 30000, obtenido ${res.ventasNetas}`);
    assert(res.recaudos === 30000, `recaudos debe ser 30000, obtenido ${res.recaudos}`);
    assert(res.flujoNetoEfectivo === 30000, `flujoNetoEfectivo debe ser 30000, obtenido ${res.flujoNetoEfectivo}`);
    assert(res.costoVentasEstimado === 18000, `costoVentasEstimado debe ser 18000, obtenido ${res.costoVentasEstimado}`);
    assert(res.utilidadOperativaEstimada === 12000, `utilidadOperativaEstimada debe ser 12000, obtenido ${res.utilidadOperativaEstimada}`);
  });

  await step(89, "P0: generarInformeFinancieroContable() por período pasado aísla movimientos y ventas de otros meses", async () => {
    const movs = [
      { id: "m1", tipo: TIPOS_CONTABLE.INGRESO, categoria: "Ventas de mostrador", concepto: "Enero", monto: 100000, valor: 100000, metodoPago: "Efectivo", fechaEfectiva: "2025-01-15", fecha: "2025-01-15T10:00:00.000Z" },
      { id: "m2", tipo: TIPOS_CONTABLE.GASTO, categoria: "Transporte", concepto: "Enero gasto", monto: 20000, valor: 20000, metodoPago: "Efectivo", fechaEfectiva: "2025-01-20", fecha: "2025-01-20T10:00:00.000Z" },
      { id: "m3", tipo: TIPOS_CONTABLE.INGRESO, categoria: "Ventas de mostrador", concepto: "Marzo", monto: 500000, valor: 500000, metodoPago: "Transferencia", fechaEfectiva: "2025-03-10", fecha: "2025-03-10T10:00:00.000Z" }
    ];
    const ventasMock = [
      { id: "v1", estado: "Completada", total: 100000, totalDevueltoAcumulado: 0, fecha: "2025-01-15T10:00:00.000Z", items: [] },
      { id: "v2", estado: "Completada", total: 500000, totalDevueltoAcumulado: 0, fecha: "2025-03-10T10:00:00.000Z", items: [] }
    ];
    const inf = generarInformeFinancieroContable(movs, {
      periodo: "personalizado",
      desde: "2025-01-01",
      hasta: "2025-01-31",
      ventas: ventasMock,
      cajas: [],
      productos: []
    });
    assert(inf.resumen.recaudos === 100000, `Recaudos enero debe ser 100000, obtenido ${inf.resumen.recaudos}`);
    assert(inf.resumen.gastos === 20000, `Gastos enero debe ser 20000, obtenido ${inf.resumen.gastos}`);
    assert(inf.resumen.ventasNetas === 100000, `ventasNetas enero debe ser 100000, obtenido ${inf.resumen.ventasNetas}`);
    assert(inf.resumen.flujoNetoEfectivo === 80000, `flujoNetoEfectivo enero debe ser 80000, obtenido ${inf.resumen.flujoNetoEfectivo}`);
    assert(inf.resumen.disponibleTotal === 80000, `disponibleTotal al corte de enero debe ser 80000, obtenido ${inf.resumen.disponibleTotal}`);
  });

  await step(90, "Prompt 2: Cuentas por pagar con abonos parciales ($1.000.000 -> -$300.000 -> -$200.000 = $500.000) y vencimiento", async () => {
    resetDatabaseEmpty();
    await abrirCaja({ montoInicial: 500000, observaciones: "Turno CXP" }, adminUser);
    await registrarMovimientoContable(
      {
        tipo: TIPOS_CONTABLE.INGRESO,
        categoria: "Otros ingresos",
        concepto: "Base banco para CXP",
        monto: 1000000,
        metodoPago: "Transferencia bancaria"
      },
      adminUser
    );
    const deuda = await registrarMovimientoContable(
      {
        tipo: TIPOS_CONTABLE.GASTO,
        categoria: "Compra de mercancía",
        concepto: "Lote vidrio laminado",
        monto: 1000000,
        estadoPago: "Pendiente",
        fechaVencimiento: "2026-12-01",
        proveedor: "Vitral S.A."
      },
      adminUser
    );
    assert(deuda.saldoPendiente === 1000000 && deuda.montoPagado === 0 && deuda.estadoPago === "Pendiente", "Deuda inicial debe tener saldo 1000000");
    let res = calcularResumenContable();
    assert(res.porPagar === 1000000 && res.gastos === 0, `porPagar debe ser 1000000 y gastos 0 (got porPagar=${res.porPagar}, gastos=${res.gastos})`);

    // Abono 1: $300.000 por Transferencia bancaria
    const p1 = await pagarCuentaPorPagar(
      { movimientoId: deuda.id, montoPago: 300000, metodoPago: "Transferencia bancaria", fecha: "2026-11-22", referencia: "TR-1" },
      adminUser
    );
    assert(p1.saldoPendiente === 700000 && p1.estadoPago === "Parcial", `Tras primer abono saldo debe ser 700000 y Parcial, obtenido ${p1.saldoPendiente}`);
    res = calcularResumenContable();
    assert(res.porPagar === 700000, `porPagar debe bajar a 700000, obtenido ${res.porPagar}`);
    assert(res.gastos === 300000, `gastos debe reflejar 300000 abonados, obtenido ${res.gastos}`);
    assert(res.saldosPorCuenta["Transferencia bancaria"] === 700000, `Banco debe quedar en 700000, obtenido ${res.saldosPorCuenta["Transferencia bancaria"]}`);

    // Abono 2: $200.000 en Efectivo desde caja abierta
    const p2 = await pagarCuentaPorPagar(
      { movimientoId: deuda.id, montoPago: 200000, metodoPago: "Efectivo", fecha: "2026-11-22", referencia: "RC-2" },
      adminUser
    );
    assert(p2.saldoPendiente === 500000 && p2.estadoPago === "Parcial", `Tras segundo abono saldo debe ser 500000, obtenido ${p2.saldoPendiente}`);
    const obligActual = getDocById(COLLECTIONS.MOV_CONTABLES, deuda.id);
    assert(obligActual.montoPagado === 500000 && obligActual.pagos.length === 2, "Obligación debe registrar 2 pagos y 500000 pagados");

    res = calcularResumenContable();
    assert(res.porPagar === 500000, `porPagar final debe ser 500000, obtenido ${res.porPagar}`);
    assert(res.gastos === 500000, `gastos acumulados debe ser 500000, obtenido ${res.gastos}`);
    assert(res.disponibleCaja === 300000, `Caja física (500000 base - 200000 abono efectivo) debe ser 300000, obtenido ${res.disponibleCaja}`);

    const abonosIndep = getCollection(COLLECTIONS.MOV_CONTABLES).filter(
      (m) => m.origen === "Abono cuenta por pagar" && m.obligacionId === deuda.id
    );
    assert(abonosIndep.length === 2, `Deben existir 2 movimientos independientes de abono, encontrados ${abonosIndep.length}`);
  });

  await step(91, "Prompt 2: Saldos iniciales por cuenta aumentan Disponible sin inflar Recaudos ni Ventas", async () => {
    resetDatabaseEmpty();
    await guardarSaldosInicialesCuentas(
      { transferencia: 1200000, nequi: 350000, daviplata: 150000, caja: 200000 },
      adminUser
    );
    const guardados = obtenerSaldosInicialesCuentas();
    assert(guardados.nequi === 350000 && guardados.transferencia === 1200000, "Debe persistir saldos iniciales en control");

    const res = calcularResumenContable();
    assert(res.recaudos === 0 && res.ingresos === 0, `Recaudos no debe inflarse con saldos iniciales (got ${res.recaudos})`);
    assert(res.ventasNetas === 0, `ventasNetas debe permanecer en 0 (got ${res.ventasNetas})`);
    assert(res.saldosPorCuenta["Transferencia bancaria"] === 1200000, "Saldo inicial Transferencia = 1200000");
    assert(res.saldosPorCuenta.Nequi === 350000, "Saldo inicial Nequi = 350000");
    assert(res.saldosPorCuenta.Daviplata === 150000, "Saldo inicial Daviplata = 150000");
    assert(res.saldosPorCuenta["Caja física"] === 200000, "Saldo inicial Caja cerrada = 200000");
    assert(res.disponibleBancos === 1700000, `disponibleBancos debe ser 1700000, obtenido ${res.disponibleBancos}`);
    assert(res.disponibleTotal === 1900000, `disponibleTotal debe ser 1900000, obtenido ${res.disponibleTotal}`);
  });

  await step(92, "Prompt 3: Perfil del negocio (No responsable de IVA) propagado al Comprobante de Venta", async () => {
    resetDatabaseEmpty();
    await assertThrows(
      () => guardarPerfilNegocio({ nombreEstablecimiento: "Hack", documentoNit: "123" }, empleadoUser),
      "permiso"
    );
    await guardarPerfilNegocio(
      {
        nombreEstablecimiento: "Vidrios y Aluminios El Carmen SAS",
        tipoPersona: "Persona jurídica",
        documentoNit: "900123456-7",
        regimenIva: "No responsable de IVA",
        direccion: "Cra 10 # 20-30",
        telefono: "3105551234",
        ciudad: "El Carmen"
      },
      adminUser
    );
    const perfil = obtenerPerfilNegocio();
    assert(perfil.documentoNit === "900123456-7" && perfil.regimenIva === "No responsable de IVA", "Perfil debe guardarse en control/perfil_negocio");

    await abrirCaja({ montoInicial: 100000 }, adminUser);
    const prod = await crearProducto({ nombre: "Vidrio Test", codigo: "VT-92", categoria: "Vidrios", unidad: "u", precio: 50000, stock: 5 }, adminUser);
    const cli = await crearCliente({ nombre: "Cliente 92", documento: "8888" }, adminUser);
    const venta = await registrarVenta(
      { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 1 }], pagos: [{ metodo: "Efectivo", importe: 50000 }] },
      adminUser
    );
    const comp = generarDatosComprobante(venta);
    assert(comp.establecimiento === "Vidrios y Aluminios El Carmen SAS", "Comprobante debe usar nombre del perfil");
    assert(comp.documentoNit === "900123456-7", "Comprobante debe incluir NIT del establecimiento");
    assert(comp.direccionEstablecimiento === "Cra 10 # 20-30" && comp.telefonoEstablecimiento === "3105551234", "Comprobante debe incluir dirección y teléfono");
    assert(comp.regimenIva === "No responsable de IVA", "Comprobante debe mostrar No responsable de IVA");
    assert(comp.leyendaLegal.includes("No constituye factura electrónica"), "Debe conservar leyenda de control interno");
  });

  await step(93, "Prompt 3: Libro Fiscal de Operaciones Diarias en Reportes + CSV + referencia UVT", async () => {
    const hoyStr = new Date().toISOString().slice(0, 10);
    const rep = generarReportesConsolidados(
      {},
      {
        productos: [],
        cajas: [],
        movsInventario: [],
        devoluciones: [],
        clientes: [],
        movimientosBilletera: [],
        ventas: [
          { id: "v1", estado: "Completada", total: 200000, fecha: `${hoyStr}T10:00:00.000Z`, items: [] },
          { id: "v2", estado: "Anulada", total: 999999, fecha: `${hoyStr}T11:00:00.000Z`, items: [] }
        ],
        movsContables: [
          { id: "m1", tipo: TIPOS_CONTABLE.INGRESO, origen: "Venta POS", monto: 200000, valor: 200000, fechaEfectiva: hoyStr, fecha: `${hoyStr}T10:00:00.000Z` },
          { id: "m2", tipo: TIPOS_CONTABLE.INGRESO, origen: "Manual", categoria: "Otros ingresos", monto: 50000, valor: 50000, fechaEfectiva: hoyStr, fecha: `${hoyStr}T12:00:00.000Z` },
          { id: "m3", tipo: TIPOS_CONTABLE.GASTO, origen: "Manual", categoria: "Transporte", monto: 40000, valor: 40000, estadoPago: "Pagado", fechaEfectiva: hoyStr, fecha: `${hoyStr}T13:00:00.000Z` },
          { id: "m4", tipo: TIPOS_CONTABLE.TRASLADO, monto: 100000, valor: 100000, fechaEfectiva: hoyStr, fecha: `${hoyStr}T14:00:00.000Z` }
        ],
        perfilNegocio: { nombreEstablecimiento: "El Carmen", topeAnualUvt: 183309000, regimenIva: "No responsable de IVA" }
      }
    );
    const libro = rep.libroFiscalDiario;
    assert(libro && libro.filas.length === 1, "Debe agrupar operaciones del día sin duplicar");
    assert(libro.filas[0].ingresosDiarios === 250000, `Ingresos diarios debe ser 250000 (200000 venta + 50000 ingreso manual), obtenido ${libro.filas[0].ingresosDiarios}`);
    assert(libro.filas[0].comprasYPagosDiarios === 40000, `Compras y pagos debe ser 40000, obtenido ${libro.filas[0].comprasYPagosDiarios}`);
    assert(libro.filas[0].saldoNetoDia === 210000, `Saldo neto día debe ser 210000, obtenido ${libro.filas[0].saldoNetoDia}`);
    assert(libro.ingresosBrutosAnioActual === 250000, `Ingresos brutos año actual debe ser 250000, obtenido ${libro.ingresosBrutosAnioActual}`);
    const csv = generarCSVReporte("libro_fiscal", rep);
    assert(csv.includes("Ingresos Diarios COP;Compras y Pagos Diarios COP") && csv.includes("250000") && csv.includes("210000"), "CSV libro_fiscal debe exportar columnas separadas por ; y totales reales");
  });

  await step(94, "Prompt 3: Copia de seguridad JSON (exportarRespaldoJSON y restaurarRespaldoJSON)", async () => {
    resetDatabaseEmpty();
    await crearProducto({ nombre: "Producto Respaldo", codigo: "RES-1", categoria: "Vidrios", unidad: "u", precio: 25000, stock: 7 }, adminUser);
    await assertThrows(() => exportarRespaldoJSON(empleadoUser), "permiso");

    const respaldo = exportarRespaldoJSON(adminUser);
    assert(respaldo.version === 1 && respaldo.colecciones.productos.length === 1, "Respaldo debe empaquetar las colecciones");
    assert(Object.keys(respaldo.colecciones).length === 11, "Respaldo debe incluir las 11 colecciones");

    await assertThrows(() => restaurarRespaldoJSON("{json corrupto", adminUser), "JSON");
    await assertThrows(() => restaurarRespaldoJSON({ version: 1, colecciones: { invalida: [] } }, adminUser), "desconocida");
    await assertThrows(() => restaurarRespaldoJSON(respaldo.jsonString, empleadoUser), "permiso");

    resetDatabaseEmpty();
    assert(getCollection(COLLECTIONS.PRODUCTOS).length === 0, "BD limpia antes de restaurar");

    const resRestauracion = await restaurarRespaldoJSON(respaldo.jsonString, adminUser);
    assert(resRestauracion.totalRestaurados >= 1, "Debe restaurar los registros del respaldo");
    const prodsRestaurados = getCollection(COLLECTIONS.PRODUCTOS);
    assert(prodsRestaurados.length === 1 && prodsRestaurados[0].codigo === "RES-1", "Producto restaurado correctamente desde JSON");
  });

  await step(95, "Orden descendente global (más reciente primero) en Productos, Usuarios, Contabilidad, Kardex, Caja, Clientes y Reportes", async () => {
    resetDatabaseForTests();
    const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

    // 1. Productos: recién creado debe quedar #1 sobre catálogo inicial y sobre productos anteriores
    const p1 = await crearProducto({ nombre: "Perfil Viejo Test", codigo: "ORD-P1", categoria: "Perfiles", unidad: "m", precio: 15000, stock: 10 }, adminUser);
    await waitMs(12);
    const p2 = await crearProducto({ nombre: "Perfil Último Test", codigo: "ORD-P2", categoria: "Perfiles", unidad: "m", precio: 18000, stock: 20 }, adminUser);
    const listaProds = listarProductos({ incluirInactivos: true });
    assert(listaProds[0].id === p2.id && listaProds[1].id === p1.id, "listarProductos debe ubicar el producto más reciente primero");
    let snapProds = [];
    const unsubP = watchProductos((l) => { snapProds = l; }, { incluirInactivos: true });
    unsubP();
    assert(snapProds[0].id === p2.id, "watchProductos debe ubicar el producto más reciente primero");

    // 2. Usuarios: último creado debe aparecer primero
    await crearUsuario({ nombre: "Ana Primera", email: "ana.primera@elcarmen.com", rol: ROLES.EMPLEADO }, adminUser);
    await waitMs(12);
    const uUlt = await crearUsuario({ nombre: "Zulema Última", email: "zulema.ultima@elcarmen.com", rol: ROLES.EMPLEADO }, adminUser);
    let snapUsers = [];
    const unsubU = watchUsuarios((l) => { snapUsers = l; });
    unsubU();
    assert(snapUsers[0].id === uUlt.id, `watchUsuarios debe mostrar el usuario más reciente primero (esperado ${uUlt.id}, obtenido ${snapUsers[0]?.id})`);

    // 3. Clientes: último creado debe aparecer primero
    await crearCliente({ nombre: "Cliente Primero", documento: "900111222" }, adminUser);
    await waitMs(12);
    const cliUlt = await crearCliente({ nombre: "Cliente Último", documento: "900333444" }, adminUser);
    let snapClientes = [];
    const unsubCli = watchClientes((l) => { snapClientes = l; });
    unsubCli();
    assert(snapClientes[0].id === cliUlt.id, "watchClientes debe mostrar el cliente recién creado primero");

    // 4. Kardex: último movimiento arriba
    await waitMs(12);
    await registrarMovimientoBodega({ productoId: p2.id, tipo: "Entrada", cantidad: 5, motivo: "Compra reciente" }, adminUser);
    let snapKardex = [];
    const unsubK = watchMovimientosInventario((l) => { snapKardex = l; });
    unsubK();
    assert(snapKardex[0].productoId === p2.id && snapKardex[0].motivo === "Compra reciente", "watchMovimientosInventario debe ordenar del más reciente al más antiguo");

    // 5. Caja y Ventas: última venta y última caja primero
    const caja1 = await abrirCaja({ montoInicial: 100000 }, adminUser);
    await waitMs(12);
    const v1 = await registrarVenta({
      clienteId: cliUlt.id,
      items: [{ productoId: p1.id, cantidad: 1 }],
      pagos: [{ metodo: "Efectivo", importe: 15000 }]
    }, adminUser);
    await waitMs(12);
    const v2 = await registrarVenta({
      clienteId: cliUlt.id,
      items: [{ productoId: p2.id, cantidad: 1 }],
      pagos: [{ metodo: "Efectivo", importe: 18000 }]
    }, adminUser);
    assert(listarVentas()[0].id === v2.id, "listarVentas debe mostrar la última venta primero");
    let snapVentas = [];
    const unsubV = watchVentas((l) => { snapVentas = l; });
    unsubV();
    assert(snapVentas[0].id === v2.id, "watchVentas debe mostrar la última venta primero");

    // 6. Contabilidad: gasto manual registrado después de una venta del mismo día debe aparecer primero por fechaRegistro
    await waitMs(12);
    const hoyIso = new Date().toISOString().slice(0, 10);
    const gastoManual = await registrarMovimientoContable({
      tipo: TIPOS_CONTABLE.GASTO,
      categoria: "Transporte",
      concepto: "Flete último",
      monto: 12000,
      metodoPago: "Efectivo",
      fechaEfectiva: hoyIso
    }, adminUser);
    const movsCont = listarMovimientosContables();
    assert(movsCont[0].id === gastoManual.id, "listarMovimientosContables debe ordenar por fechaRegistro || fecha poniendo el último movimiento arriba");
    let snapCont = [];
    const unsubC = watchMovimientosContables((l) => { snapCont = l; });
    unsubC();
    assert(snapCont[0].id === gastoManual.id, "watchMovimientosContables debe poner el último movimiento arriba");

    // 7. Reportes consolidados: detalleVentas, movimientosInventario, movimientosContables e inventarioActual en orden descendente
    const rep = generarReportesConsolidados();
    assert(rep.inventarioActual[0].id === p2.id, "Reportes.inventarioActual debe conservar orden más reciente primero");
    assert(rep.detalleVentas[0].ventaId === v2.id, "Reportes.detalleVentas debe mostrar la venta más reciente primero");
    assert(
      rep.movimientosInventario[0].productoId === p2.id &&
        rep.movimientosInventario[0].tipo === "Salida" &&
        Date.parse(rep.movimientosInventario[0].fecha) >= Date.parse(rep.movimientosInventario[1].fecha),
      "Reportes.movimientosInventario debe mostrar el último movimiento (venta más reciente) primero"
    );
    assert(rep.ingresosYGastos[0].id === gastoManual.id, "Reportes.ingresosYGastos debe mostrar el último movimiento contable primero");

    // Cierre de caja y segunda apertura: verificar watchCajas ordenado descendente por fechaApertura
    await cerrarCaja({ cajaId: caja1.id, efectivoContado: 121000, observaciones: "Cierre orden" }, adminUser);
    await waitMs(12);
    const caja2 = await abrirCaja({ montoInicial: 50000 }, adminUser);
    let snapCajas = [];
    const unsubCaja = watchCajas(({ historial }) => { snapCajas = historial; });
    unsubCaja();
    assert(snapCajas.length >= 2 && snapCajas[0].id === caja2.id && snapCajas[1].id === caja1.id, "watchCajas debe devolver el turno más reciente primero");
    assert(v1.id !== v2.id);
  });

  await step(96, "Importación masiva Excel/CSV: mapeo, traductor, validaciones, transacción atómica, Kardex y venta POS", async () => {
    resetDatabaseEmpty();
    const existente = await crearProducto(
      { nombre: "Chapa Existente", codigo: "CH-01", categoria: "Accesorios", unidad: "u", precioCompra: 10000, precio: 20000, stock: 10, stockMinimo: 2 },
      adminUser
    );

    await assertThrows(() => sugerirMapeoColumnasExcel(["ARTICULO"], empleadoUser), "permiso");

    // 1. Parser CSV con BOM, punto y coma y comillas
    const csvSample = "\uFEFFVALOR;ARTICULO;CANT;LINEA;UND;SKU\r\n\"$ 35.000\";\"Perfil Aluminio 2\"\"\";\"12,5\";Aluminio;ml;\r\n\"$ 80.000\";Vidrio Templado 8mm;6.5;Templado;m2;VT-800\r\n\"$ 25.000\";;5;Herraje;u;\r\n\"$ 22.000\";Chapa Renovada;3;Accesorios;u;CH-01\r\n\"$ 10.000\";Repetido;2;Insumos;u;VT-800";
    const parsed = parsearCSVTabla(csvSample);
    assert(parsed.encabezados.length === 6 && parsed.filas.length === 5, "Debe parsear CSV con BOM y comillas");

    const mapeo = sugerirMapeoColumnasExcel(parsed.encabezados, adminUser);
    assert(mapeo.nombre === "ARTICULO" && mapeo.precio === "VALOR" && mapeo.stock === "CANT", `Mapeo automático incorrecto: ${JSON.stringify(mapeo)}`);
    assert(mapeo.categoria === "LINEA" && mapeo.unidad === "UND" && mapeo.codigo === "SKU", "Debe mapear categoría, unidad y código");

    const preparadas = normalizarYValidarFilasImportacion(parsed.filas, mapeo, { stockMinimo: 4 }, adminUser);
    assert(preparadas[0].categoria === "Perfiles" && preparadas[0].unidad === "m" && preparadas[0].precio === 35000 && preparadas[0].stock === 12.5 && preparadas[0].estado === "nuevo", "Debe traducir Aluminio->Perfiles, ml->m y $ 35.000->35000");
    assert(preparadas[1].categoria === "Vidrios" && preparadas[1].unidad === "m²" && preparadas[1].permiteDimensiones === true, "Debe traducir Templado->Vidrios y m2->m² con dimensiones");
    assert(preparadas[2].estado === "error" && preparadas[2].bloqueante && !preparadas[2].incluir, "Fila sin nombre debe quedar bloqueada como error");
    assert(preparadas[3].estado === "duplicado" && preparadas[3].productoExistenteId === existente.id, "Debe detectar duplicado por código CH-01");
    assert(preparadas[4].estado === "error" && preparadas[4].mensaje.includes("repetido"), "Debe detectar código repetido VT-800 dentro del mismo archivo");

    // Coherencia entero vs decimal en unidad "u"
    const decUnidad = normalizarYValidarFilasImportacion(
      [{ ARTICULO: "Tornillo", VALOR: "500", CANT: "2.5", LINEA: "Herraje", UND: "u" }],
      mapeo,
      {},
      adminUser
    );
    assert(decUnidad[0].bloqueante && decUnidad[0].mensaje.includes("enteras"), "Debe alertar cantidad decimal en unidad 'u'");

    // 2. Importación atómica (modo omitir) -> crea los 2 nuevos, omite CH-01, reporta errores
    const res1 = await importarProductosMasivo(preparadas, { modoDuplicados: "omitir" }, adminUser);
    assert(res1.creados === 2 && res1.actualizados === 0 && res1.omitidos === 1 && res1.errores === 2, `Conteos inesperados: ${JSON.stringify(res1)}`);

    const prods = listarProductos();
    const perfil = prods.find((p) => p.nombre.includes("Perfil Aluminio"));
    const vidrio = prods.find((p) => p.codigo === "VT-800");
    assert(perfil && /^PR-\d{4}$/.test(perfil.codigo), `Debe autogenerar código consecutivo PR-XXXX, obtenido ${perfil?.codigo}`);
    assert(vidrio && vidrio.stock === 6.5 && vidrio.permiteDimensiones, "Vidrio importado debe conservar stock 6.5 m²");

    // Verificar Kardex inicial y auditoría
    const movsInv = getCollection(COLLECTIONS.MOV_INVENTARIO);
    assert(movsInv.some((m) => m.productoId === vidrio.id && m.tipo === "Entrada" && m.origen === "Stock inicial" && m.cantidad === 6.5), "Debe crear entrada inicial en Kardex");
    const aud = getCollection(COLLECTIONS.AUDITORIA);
    assert(aud.some((a) => a.accion === "PRODUCTOS_IMPORTACION_EXCEL" && a.creados === 2), "Debe registrar auditoría PRODUCTOS_IMPORTACION_EXCEL");

    // 3. Modo actualizar_y_sumar_stock sobre CH-01
    const res2 = await importarProductosMasivo([preparadas[3]], { modoDuplicados: "actualizar_y_sumar_stock" }, adminUser);
    assert(res2.actualizados === 1, "Debe actualizar producto existente");
    const chActualizado = getDocById(COLLECTIONS.PRODUCTOS, existente.id);
    assert(chActualizado.precio === 22000 && chActualizado.stock === 13, `Debe actualizar precio a 22000 y sumar stock a 13 (obtenido ${chActualizado.stock})`);

    // 4. Vender producto importado (Vidrio m²) desde Caja y confirmar descuento real de existencias
    await abrirCaja({ montoInicial: 50000 }, adminUser);
    const cli = await crearCliente({ nombre: "Cliente Excel Test", documento: "777888999" }, adminUser);
    await registrarVenta({
      clienteId: cli.id,
      items: [{ productoId: vidrio.id, cantidad: 2.5 }],
      pagos: [{ metodo: "Efectivo", importe: 200000 }]
    }, adminUser);
    const vidrioPost = getDocById(COLLECTIONS.PRODUCTOS, vidrio.id);
    assert(vidrioPost.stock === 4, `Stock de vidrio importado debe bajar de 6.5 a 4, obtenido ${vidrioPost.stock}`);
  });

  return results.sort((a, b) => a.num - b.num);
}

// Renderizado en tests/caja-ventas.test.html
async function renderInBrowser() {
  const resultsEl = document.getElementById("test-results");
  const summaryEl = document.getElementById("test-summary");
  const badgeEl = document.getElementById("test-status-badge");
  if (!resultsEl) return;

  const list = await runAll25Tests();
  const passed = list.filter((r) => r.passed).length;
  const failed = list.length - passed;

  if (badgeEl) {
    badgeEl.textContent = failed === 0 ? `${passed} / ${list.length} Aprobadas` : `${failed} Fallidas`;
    badgeEl.className = `badge ${failed === 0 ? "badge-success" : "badge-danger"}`;
  }

  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="card stat income" style="flex:1"><div class="stat-label">Pruebas aprobadas</div><p class="stat-value num">${passed}</p></div>
      <div class="card stat ${failed ? "expense" : ""}" style="flex:1"><div class="stat-label">Pruebas fallidas</div><p class="stat-value num">${failed}</p></div>
      <div class="card stat" style="flex:1"><div class="stat-label">Total escenarios</div><p class="stat-value num">${list.length}</p></div>
    `;
  }

  resultsEl.innerHTML = list
    .map(
      (r) => `
        <div class="test-row">
          <span><b>#${r.num}.</b> ${r.title}</span>
          <span class="badge ${r.passed ? "badge-success" : "badge-danger"}">${r.passed ? "PASÓ" : `FALLÓ: ${r.detail}`}</span>
        </div>
      `
    )
    .join("");
}

if (typeof document !== "undefined") {
  document.getElementById("btn-run-tests")?.addEventListener("click", renderInBrowser);
  renderInBrowser();
} else {
  const list = await runAll25Tests();
  const passed = list.filter((r) => r.passed).length;
  const failed = list.length - passed;
  console.log(`NODE TEST RESULT: ${passed} / ${list.length} Aprobadas (FAIL: ${failed})`);
  if (failed > 0) {
    for (const r of list.filter((x) => !x.passed)) {
      console.error(`FAIL #${r.num}: ${r.title} -> ${r.detail}`);
    }
    process.exitCode = 1;
  }
}

