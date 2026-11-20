// Controlador de la vista Caja y Ventas — Vidrios y Aluminios El Carmen.
// Conecta la plantilla de Caja y Ventas con inventario en tiempo real, apertura/cierre de caja,
// carrito con unidades enteras y decimales (m, m²), calculadora de cortes de vidrio en cm,
// cobro transaccional con idempotencia, comprobante imprimible e historial con anulaciones.

import { getCurrentUser, hasPermission } from "../auth.js";
import {
  watchProductos,
  filtrarCatalogo,
  getEstadoStock,
  formatCOP,
  roundQty,
  roundCOP,
  calcularAreaM2,
  calcularVidrioPersonalizado,
  crearProducto
} from "../services/inventario-service.js";
import {
  watchClientes,
  watchMovimientosBilletera,
  crearCliente,
  buscarClientes,
  obtenerHistorialCliente,
  obtenerResumenBilleteraCliente,
  listarCarteraClientes,
  calcularSaldoPendienteVenta
} from "../services/clientes-service.js";
import { COLLECTIONS, getCollection } from "../services/store.js";
import {
  watchCajas,
  watchVentas,
  METODO_SALDO_FAVOR,
  abrirCaja,
  cerrarCaja,
  registrarMovimientoEfectivoCaja,
  calcularTotalesVenta,
  evaluarPagos,
  registrarVenta,
  registrarAbonoVenta,
  anularVenta,
  registrarDevolucionVenta,
  calcularDisponibilidadDevolucion,
  calcularArqueoCaja,
  filtrarHistorialVentas,
  generarDatosComprobante,
  generarLineId
} from "../services/caja-service.js";

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

function formatDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-CO", {
      dateStyle: "short",
      timeStyle: "short"
    });
  } catch {
    return iso;
  }
}

function formatShortDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("es-CO", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    });
  } catch {
    return String(iso).slice(0, 10);
  }
}

export function mountCajaView(root) {
  const $ = (sel) => root.querySelector(sel);

  function parseMontoInput(val) {
    if (typeof val === "number") return Number.isFinite(val) ? roundCOP(val) : 0;
    const digits = String(val ?? "").replace(/[^\d]/g, "");
    return digits ? roundCOP(Number(digits)) : 0;
  }

  function formatMontoInput(val) {
    const digits = String(val ?? "").replace(/[^\d]/g, "");
    if (!digits) return "";
    return Number(digits).toLocaleString("en-US");
  }

  // Formateo en tiempo real con comas de miles para todos los campos monetarios
  root.addEventListener(
    "input",
    (e) => {
      const inp = e.target.closest('[data-money-input="1"]');
      if (!inp) return;
      const formatted = formatMontoInput(inp.value);
      if (inp.value !== formatted) inp.value = formatted;
    },
    true
  );

  let productos = [];
  let clientes = [];
  let movimientosBilletera = [];
  let cajaAbierta = null;
  let ventas = [];
  let categoriaActiva = "Todos";
  let cart = []; // [{ productoId, codigo, nombre, unidad, permiteDecimal, precioUnitario, cantidad, dimensiones }]
  let isProcessingSale = false;

  const feedbackEl = $("#pos-feedback");

  function showFeedback(message, type = "info") {
    if (!feedbackEl) return;
    feedbackEl.textContent = message;
    feedbackEl.className = `alert ${type === "danger" ? "alert-danger" : "alert-info"}`;
    feedbackEl.classList.remove("hidden");
  }

  function hideFeedback() {
    if (feedbackEl) feedbackEl.classList.add("hidden");
  }

  function tieneClienteSeleccionado() {
    const val = String($("#pos-cliente")?.value || "").trim();
    return Boolean(val && val !== "cli-consumidor");
  }

  function exigirClienteAntesDeAgregar() {
    if (tieneClienteSeleccionado()) return true;
    showFeedback("Primero debes seleccionar o registrar un cliente antes de agregar productos a la venta.", "danger");
    $("#box-buscar-cliente")?.classList.remove("hidden");
    $("#pos-cliente-buscar")?.focus();
    return false;
  }

  // -------------------------------------------------------------------------
  // 1. RENDERIZADO DEL ESTADO DE CAJA (ABIERTA / CERRADA)
  // -------------------------------------------------------------------------
  function renderEstadoCaja() {
    const user = getCurrentUser();
    const statusBar = $("#cash-status-bar");
    const badgeEl = $("#caja-badge-estado");
    const metaEl = $("#caja-meta-info");
    const actionsEl = $("#caja-status-actions");
    const panelApertura = $("#panel-apertura-caja");
    const posWorkspace = $("#pos-workspace");

    if (!cajaAbierta) {
      if (statusBar) statusBar.classList.add("hidden");
      if (posWorkspace) posWorkspace.classList.add("hidden");
      if (actionsEl) actionsEl.classList.add("hidden");
      if (panelApertura) {
        panelApertura.classList.remove("hidden");
        const usrInput = $("#apertura-usuario");
        const fechaInput = $("#apertura-fecha");
        if (usrInput) usrInput.value = user.name || user.email;
        if (fechaInput) fechaInput.value = formatDateTime(new Date().toISOString());
      }
      updateCobrarButtonState();
      return;
    }

    if (statusBar) statusBar.classList.remove("hidden");
    if (posWorkspace) posWorkspace.classList.remove("hidden");

    const arqueo = calcularArqueoCaja(cajaAbierta, ventas);
    if (badgeEl) {
      badgeEl.textContent = "Caja abierta";
      badgeEl.className = "badge badge-success";
    }
    if (metaEl && arqueo) {
      metaEl.innerHTML = `
        <span>Abierta por: <b>${escapeHtml(cajaAbierta.usuarioApertura)}</b></span>
        <span>Monto inicial: <b class="num">${formatCOP(arqueo.montoInicial)}</b></span>
        <span>Ventas del turno: <b>${arqueo.numeroVentas}</b></span>
        <span>Efectivo esperado: <b class="num">${formatCOP(arqueo.efectivoEsperado)}</b></span>
      `;
    }
    if (actionsEl) actionsEl.classList.remove("hidden");
    if (panelApertura) panelApertura.classList.add("hidden");

    renderResumenModalCierre(arqueo);
    updateCobrarButtonState();
  }

  function renderResumenModalCierre(arqueo) {
    if (!arqueo) return;
    const setTxt = (sel, val) => {
      const el = $(sel);
      if (el) el.textContent = val;
    };
    const efectivoTurno = roundCOP(
      (arqueo.entradasEfectivoVentas || 0) +
        (arqueo.entradasEfectivoAbonos || 0) +
        (arqueo.entradasEfectivoManual || 0) -
        (arqueo.totalSalidasEfectivo || 0)
    );
    const digitalBanco = roundCOP(
      (arqueo.pagosPorMetodo?.Transferencia || 0) +
        (arqueo.pagosPorMetodo?.Nequi || 0) +
        (arqueo.pagosPorMetodo?.Daviplata || 0)
    );
    setTxt(
      "#cierre-subtitulo-fecha",
      `Resumen del turno · ${formatShortDate(cajaAbierta?.fechaApertura || new Date().toISOString())}`
    );
    setTxt("#cierre-base", formatCOP(arqueo.montoInicial));
    setTxt(
      "#cierre-efectivo-ventas",
      `${efectivoTurno >= 0 ? "+" : "−"}${formatCOP(Math.abs(efectivoTurno))}`
    );
    setTxt("#cierre-transferencia", formatCOP(digitalBanco));
    setTxt("#cierre-esperado", formatCOP(arqueo.efectivoEsperado));
    actualizarDiferenciaCierre();
  }

  function actualizarDiferenciaCierre() {
    if (!cajaAbierta) return;
    const arqueo = calcularArqueoCaja(cajaAbierta, ventas);
    const contadoEl = $("#efectivo-contado");
    const difEl = $("#cierre-diferencia");
    const badgeEl = $("#cierre-diferencia-badge");
    const helpEl = $("#cierre-diferencia-help");
    if (!contadoEl || !difEl || !arqueo) return;

    const raw = contadoEl.value.trim();
    if (raw === "") {
      difEl.textContent = "$ 0";
      difEl.className = "cierre-diff-val is-neutral num";
      if (badgeEl) {
        badgeEl.textContent = "Pendiente de conteo";
        badgeEl.className = "badge badge-neutral";
      }
      if (helpEl) {
        helpEl.textContent = "Ingrese arriba el efectivo contado para calcular si hay diferencia.";
      }
      return;
    }

    const contado = parseMontoInput(raw);
    const dif = roundCOP(contado - arqueo.efectivoEsperado);
    if (dif === 0) {
      difEl.textContent = "$ 0";
      difEl.className = "cierre-diff-val is-exact num";
      if (badgeEl) {
        badgeEl.textContent = "Cuadre exacto";
        badgeEl.className = "badge badge-success";
      }
      if (helpEl) {
        helpEl.textContent = "El dinero contado coincide exactamente con el efectivo esperado.";
      }
    } else if (dif < 0) {
      difEl.textContent = `−${formatCOP(Math.abs(dif))}`;
      difEl.className = "cierre-diff-val is-short num";
      if (badgeEl) {
        badgeEl.textContent = "Faltante de efectivo";
        badgeEl.className = "badge badge-danger";
      }
      if (helpEl) {
        helpEl.textContent = "El dinero contado es inferior al efectivo esperado.";
      }
    } else {
      difEl.textContent = `+${formatCOP(dif)}`;
      difEl.className = "cierre-diff-val is-over num";
      if (badgeEl) {
        badgeEl.textContent = "Sobrante de efectivo";
        badgeEl.className = "badge badge-warning";
      }
      if (helpEl) {
        helpEl.textContent = "El dinero contado es superior al efectivo esperado.";
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. CATÁLOGO Y BÚSQUEDA DE PRODUCTOS (Sección 4)
  // -------------------------------------------------------------------------
  function renderTarjetaProductoHTML(p) {
    const estado = getEstadoStock(p);
    const agotado = estado.codigo === "agotado";
    const enCarrito = getCantidadEnCarrito(p.id);
    const seleccionada = enCarrito > 0;
    const siglas = escapeHtml(
      p.codigo
        ? p.codigo.split("-")[0]
        : p.nombre
            .split(" ")
            .slice(0, 2)
            .map((w) => w[0])
            .join("")
            .toUpperCase()
    );
    const botonAgregar = agotado
      ? `<button type="button" class="btn btn-outline btn-block product-add-btn" disabled>Agotado</button>`
      : `<button type="button" class="btn btn-primary btn-block product-add-btn" data-add-prod="${escapeHtml(p.id)}">+ Agregar${seleccionada ? ` (En venta: ${enCarrito}${p.unidad ? ` ${escapeHtml(p.unidad)}` : ""})` : ""}</button>`;
    return `
      <article class="product-card${seleccionada ? " is-selected" : ""}">
        <div class="product-thumb" style="display:flex; justify-content:space-between; align-items:center; padding:0 .65rem">
          <span>${siglas}</span>
          <span class="badge ${estado.claseBadge}" style="font-size:.68rem">${estado.etiqueta}</span>
        </div>
        <span class="product-name">${escapeHtml(p.nombre)}</span>
        <span class="product-meta">Cód: <b>${escapeHtml(p.codigo)}</b> · ${escapeHtml(p.categoria)}</span>
        <span class="product-meta">Disponible: <b>${p.stock}${p.unidad ? ` ${escapeHtml(p.unidad)}` : ""}</b></span>
        <span class="product-price num">${formatCOP(p.precio)}${p.unidad ? ` <small style="font-weight:500; font-size:.75rem; color:var(--text-muted)">/ ${escapeHtml(p.unidad)}</small>` : ""}</span>
        ${botonAgregar}
      </article>
    `;
  }

  function renderCatalogo() {
    const gridEl = $("#product-grid");
    if (!gridEl) return;

    const totalCountEl = $("#catalogo-total-count");
    const infCountEl = $("#catalogo-inferior-count");
    const boxVerMas = $("#box-ver-mas-catalogo");
    if (totalCountEl) totalCountEl.textContent = String(productos.length);
    if (infCountEl) infCountEl.textContent = String(productos.length);

    const busqueda = $("#buscar-producto")?.value || "";
    const filtrados = filtrarCatalogo(productos, {
      categoria: categoriaActiva,
      busqueda
    });

    if (filtrados.length === 0) {
      if (boxVerMas) boxVerMas.classList.add("hidden");
      gridEl.innerHTML = `
        <div class="card" style="grid-column: 1 / -1">
          <div class="empty" style="padding:1.75rem">
            <h3>Sin coincidencias</h3>
            <p>No se encontraron productos para esta búsqueda o categoría.</p>
          </div>
        </div>
      `;
      return;
    }

    const hayBusqueda = Boolean(busqueda.trim());
    const visibles = !hayBusqueda && filtrados.length > 12 ? filtrados.slice(0, 12) : filtrados;
    if (boxVerMas) {
      boxVerMas.classList.toggle("hidden", hayBusqueda || filtrados.length <= 12);
    }

    gridEl.innerHTML = visibles.map(renderTarjetaProductoHTML).join("");

    // Poblar también el selector del modal de corte a medida (m²)
    const medSelect = $("#med-producto");
    if (medSelect) {
      const m2Prods = productos.filter((p) => p.unidad === "m²" && p.stock > 0);
      medSelect.innerHTML = m2Prods.length
        ? m2Prods
            .map(
              (p) =>
                `<option value="${escapeHtml(p.id)}">${escapeHtml(p.nombre)} (${formatCOP(p.precio)} / m² · Disp: ${p.stock} m²)</option>`
            )
            .join("")
        : `<option value="">Sin vidrios o espejos disponibles</option>`;
    }
  }

  // -------------------------------------------------------------------------
  // 3. CARRITO DE VENTA ACTUAL, UNIDADES Y CÁLCULOS (Secciones 5, 6 y 8)
  // -------------------------------------------------------------------------
  function getCantidadEnCarrito(productoId) {
    return roundQty(
      cart
        .filter((i) => i.productoId === productoId)
        .reduce((acc, i) => acc + Number(i.cantidad || 0), 0)
    );
  }

  function agregarProductoAlCarrito(productoId, cantidadAgregar = 1, opcionesPersonalizadas = null) {
    hideFeedback();
    if (!cajaAbierta) {
      showFeedback("Debes abrir una caja antes de registrar ventas.", "danger");
      return false;
    }
    if (!exigirClienteAntesDeAgregar()) return false;

    const prod = productos.find((p) => p.id === productoId);
    if (!prod) {
      showFeedback("Producto no encontrado en el inventario.", "danger");
      return false;
    }

    const cantSolicitada = roundQty(cantidadAgregar);
    if (!(cantSolicitada > 0)) {
      showFeedback("La cantidad debe ser mayor que cero.", "danger");
      return false;
    }

    const enCarrito = getCantidadEnCarrito(prod.id);
    if (roundQty(enCarrito + cantSolicitada) > roundQty(prod.stock)) {
      showFeedback(
        `No hay existencias suficientes para esta cantidad (${prod.nombre}: disponible ${prod.stock}${prod.unidad ? ` ${prod.unidad}` : ""}).`,
        "danger"
      );
      return false;
    }

    const dimensiones = opcionesPersonalizadas?.dimensiones || null;

    // Si es un vidrio por medida personalizada, registrar siempre como línea independiente
    // para no combinar piezas de dimensiones diferentes ni perder su detalle (Sección 4).
    const existingIndex = !dimensiones
      ? cart.findIndex((i) => i.productoId === prod.id && !i.dimensiones)
      : -1;

    if (existingIndex >= 0) {
      cart[existingIndex].cantidad = roundQty(cart[existingIndex].cantidad + cantSolicitada);
      cart[existingIndex].precioUnitario = roundCOP(prod.precio);
      cart[existingIndex].precioMaterial = roundCOP(cart[existingIndex].precioUnitario * cart[existingIndex].cantidad);
      cart[existingIndex].subtotal = cart[existingIndex].precioMaterial;
    } else {
      const precioUnitario =
        opcionesPersonalizadas?.precioUnitario !== undefined
          ? roundCOP(opcionesPersonalizadas.precioUnitario)
          : roundCOP(prod.precio);
      const precioMaterial =
        opcionesPersonalizadas?.precioMaterial !== undefined
          ? roundCOP(opcionesPersonalizadas.precioMaterial)
          : roundCOP(precioUnitario * cantSolicitada);
      const costosAdicionales = roundCOP(opcionesPersonalizadas?.costosAdicionales || 0);
      const conceptoAdicional = String(opcionesPersonalizadas?.conceptoAdicional || "").trim();
      const subtotal = roundCOP(precioMaterial + costosAdicionales);

      cart.push({
        lineId: generarLineId(),
        productoId: prod.id,
        codigo: prod.codigo,
        nombre: prod.nombre,
        unidad: prod.unidad ?? "",
        permiteDecimal: Boolean(prod.permiteDecimal || prod.unidad === "m" || prod.unidad === "m²"),
        precioUnitario,
        precioAutorizado: precioUnitario !== roundCOP(prod.precio),
        cantidad: cantSolicitada,
        precioMaterial,
        costosAdicionales,
        conceptoAdicional,
        subtotal,
        dimensiones
      });
    }

    renderCarrito();
    return true;
  }

  function actualizarPiezasVidrioLinea(lineId, nuevasPiezas) {
    hideFeedback();
    const idx = cart.findIndex((i) => i.lineId === lineId);
    if (idx === -1) return;

    const item = cart[idx];
    if (!item.dimensiones) return;

    const prod = productos.find((p) => p.id === item.productoId);
    if (!prod) return;

    const piezasNum = Number(nuevasPiezas);
    if (!Number.isInteger(piezasNum) || piezasNum < 1) {
      showFeedback("La cantidad de piezas debe ser un número entero mayor o igual a 1.", "danger");
      renderCarrito();
      return;
    }

    const calc = calcularVidrioPersonalizado({
      ancho: item.dimensiones.ancho ?? item.dimensiones.anchoCm,
      largo: item.dimensiones.largo ?? item.dimensiones.altoCm,
      unidadDimension: item.dimensiones.unidadDimension || "cm",
      piezas: piezasNum,
      precioM2: item.precioUnitario,
      costosAdicionales: item.costosAdicionales || 0,
      conceptoAdicional: item.conceptoAdicional || ""
    });

    const otrosMismoProd = roundQty(
      cart
        .filter((i) => i.productoId === item.productoId && i.lineId !== lineId)
        .reduce((s, i) => s + i.cantidad, 0)
    );
    if (roundQty(otrosMismoProd + calc.areaTotal) > roundQty(prod.stock)) {
      showFeedback(
        `No hay existencias suficientes para ${piezasNum} piezas (${calc.areaTotal} m² requeridos; disponible: ${prod.stock} ${prod.unidad}).`,
        "danger"
      );
      renderCarrito();
      return;
    }

    cart[idx].dimensiones = {
      ancho: calc.ancho,
      largo: calc.largo,
      unidadDimension: calc.unidadDimension,
      anchoM: calc.anchoM,
      largoM: calc.largoM,
      anchoCm: roundQty(calc.anchoM * 100),
      altoCm: roundQty(calc.largoM * 100),
      piezas: calc.piezas,
      areaPorPieza: calc.areaPorPieza,
      areaTotal: calc.areaTotal
    };
    cart[idx].cantidad = calc.areaTotal;
    cart[idx].precioMaterial = calc.precioMaterial;
    cart[idx].subtotal = calc.precioFinalLinea;
    renderCarrito();
  }

  function agregarConceptoTemporalAlCarrito({ nombre, cantidad, precioUnitario, unidad, observacion }) {
    hideFeedback();
    if (!exigirClienteAntesDeAgregar()) return false;
    const cant = roundQty(cantidad);
    const precio = roundCOP(precioUnitario);
    const sub = roundCOP(precio * cant);
    cart.push({
      lineId: generarLineId(),
      esTemporal: true,
      productoId: null,
      codigo: "",
      nombre: String(nombre || "").trim(),
      unidad: String(unidad || "").trim(),
      permiteDecimal: true,
      cantidad: cant,
      precioUnitario: precio,
      precioMaterial: sub,
      costosAdicionales: 0,
      subtotal: sub,
      observacion: String(observacion || "").trim()
    });
    renderCarrito();
  }

  function actualizarCantidadLinea(lineId, nuevaCantidad) {
    hideFeedback();
    const idx = cart.findIndex((i) => i.lineId === lineId);
    if (idx === -1) return;

    const item = cart[idx];
    if (item.dimensiones) {
      actualizarPiezasVidrioLinea(lineId, nuevaCantidad);
      return;
    }

    if (item.esTemporal) {
      const cant = roundQty(nuevaCantidad);
      if (!(cant > 0)) {
        showFeedback("La cantidad no puede ser cero ni negativa. Usa el botón × para eliminar la línea.", "danger");
        renderCarrito();
        return;
      }
      cart[idx].cantidad = cant;
      cart[idx].precioMaterial = roundCOP(cart[idx].precioUnitario * cant);
      cart[idx].subtotal = cart[idx].precioMaterial;
      renderCarrito();
      return;
    }

    const prod = productos.find((p) => p.id === item.productoId);
    if (!prod) return;

    const cant = roundQty(nuevaCantidad);
    if (!(cant > 0)) {
      showFeedback("La cantidad no puede ser cero ni negativa. Usa el botón × para eliminar la línea.", "danger");
      renderCarrito();
      return;
    }
    if (!item.permiteDecimal && !Number.isInteger(cant)) {
      showFeedback(`El producto "${item.nombre}" solo admite unidades enteras.`, "danger");
      renderCarrito();
      return;
    }

    const otrosMismoProd = roundQty(
      cart
        .filter((i) => i.productoId === item.productoId && i.lineId !== lineId)
        .reduce((s, i) => s + i.cantidad, 0)
    );
    if (roundQty(otrosMismoProd + cant) > roundQty(prod.stock)) {
      showFeedback(
        `No hay existencias suficientes para esta cantidad (máximo disponible: ${prod.stock}${prod.unidad ? ` ${prod.unidad}` : ""}).`,
        "danger"
      );
      renderCarrito();
      return;
    }

    cart[idx].cantidad = cant;
    cart[idx].precioUnitario = roundCOP(prod.precio);
    cart[idx].precioMaterial = roundCOP(cart[idx].precioUnitario * cant);
    cart[idx].subtotal = cart[idx].precioMaterial;
    renderCarrito();
  }

  function eliminarLineaCarrito(lineId) {
    cart = cart.filter((i) => i.lineId !== lineId);
    renderCarrito();
  }

  function obtenerPagosFormulario(totalVenta) {
    const modalidad = $("#modalidad-cobro")?.value || "completo";
    if (modalidad === "credito") return [];

    const cliId = $("#pos-cliente")?.value || "cli-consumidor";
    const cliObj = clientes.find((c) => c.id === cliId);
    const saldoDisp =
      cliId !== "cli-consumidor" && !cliObj?.esConsumidorFinal
        ? roundCOP(cliObj?.saldoAFavorDisponible || 0)
        : 0;
    const saldoAplicadoInput = Math.min(
      saldoDisp,
      roundCOP(totalVenta),
      Math.max(0, parseMontoInput($("#pago-saldo-favor")?.value))
    );

    const metodo = $("#metodo-pago")?.value || "Efectivo";
    const lista = [];
    if (saldoAplicadoInput > 0) {
      lista.push({ metodo: METODO_SALDO_FAVOR, importe: saldoAplicadoInput });
    }

    if (metodo === METODO_SALDO_FAVOR) {
      if (saldoAplicadoInput <= 0 && saldoDisp > 0) {
        lista.push({
          metodo: METODO_SALDO_FAVOR,
          importe: Math.min(saldoDisp, roundCOP(totalVenta))
        });
      }
      return lista;
    }

    const restantePorCobrar = Math.max(0, roundCOP(totalVenta) - saldoAplicadoInput);
    if (restantePorCobrar === 0 && saldoAplicadoInput > 0) {
      return lista;
    }

    if (metodo === "Efectivo") {
      const raw = $("#recibido")?.value;
      const recibido = raw === "" || raw === undefined ? 0 : parseMontoInput(raw);
      if (recibido > 0 || saldoAplicadoInput === 0) {
        lista.push({ metodo: "Efectivo", importe: recibido });
      }
      return lista;
    }
    if (metodo === "Mixto") {
      const ef = parseMontoInput($("#mixto-efectivo")?.value);
      const otroMetodo = $("#mixto-otro-metodo")?.value || "Transferencia";
      const otroImp = parseMontoInput($("#mixto-otro-importe")?.value);
      const ref = $("#mixto-referencia")?.value || "";
      if (ef > 0) lista.push({ metodo: "Efectivo", importe: ef });
      if (otroImp > 0) lista.push({ metodo: otroMetodo, importe: otroImp, referencia: ref });
      return lista;
    }
    const importeMetodo =
      modalidad === "parcial"
        ? parseMontoInput($("#recibido")?.value)
        : restantePorCobrar;
    if (importeMetodo > 0 || saldoAplicadoInput === 0) {
      lista.push({
        metodo,
        importe: importeMetodo,
        referencia: $("#referencia-pago")?.value || ""
      });
    }
    return lista;
  }

  function renderCarrito() {
    const listEl = $("#cart-items");
    const emptyEl = $("#cart-empty");
    if (!listEl || !emptyEl) return;
    const user = getCurrentUser();

    const statusBadge = $("#cart-status-badge");
    const btnVaciar = $("#btn-vaciar");
    const countNumEl = $("#cart-count-num");
    if (countNumEl) countNumEl.textContent = String(cart.length);
    if (statusBadge) {
      statusBadge.textContent = cart.length > 0 ? "En proceso" : "Nueva venta";
      statusBadge.classList.toggle("is-active", cart.length > 0);
    }
    if (btnVaciar) btnVaciar.classList.toggle("hidden", cart.length === 0);

    if (cart.length === 0) {
      listEl.innerHTML = "";
      emptyEl.textContent = tieneClienteSeleccionado()
        ? "Todavía no hay productos en esta venta. Pulse + Agregar en un producto del catálogo."
        : "1. Seleccione o registre un cliente arriba. 2. Luego agregue los productos con el botón + Agregar.";
      emptyEl.classList.remove("hidden");
    } else {
      emptyEl.classList.add("hidden");
      listEl.innerHTML = cart
        .map((item) => {
          const esMedida = Boolean(item.dimensiones);
          const esTemporal = Boolean(item.esTemporal);
          const precioMaterial = roundCOP(item.precioMaterial ?? item.precioUnitario * item.cantidad);
          const costosAdic = roundCOP(item.costosAdicionales || 0);
          const descLinea = roundCOP(item.descuentoLinea || 0);
          const subtotal = roundCOP(item.subtotal ?? Math.max(0, precioMaterial + costosAdic - descLinea));
          const step = esMedida ? "1" : item.permiteDecimal ? "0.01" : "1";
          const inputVal = esMedida ? item.dimensiones.piezas : item.cantidad;
          const puedeEditarPrecio = esTemporal && hasPermission("ventas.modificar_precio", user);

          let dimText = "";
          if (esMedida) {
            const d = item.dimensiones;
            const uDim = d.unidadDimension || "cm";
            const anchoVis = d.ancho ?? d.anchoCm;
            const largoVis = d.largo ?? d.altoCm;
            const areaPza = d.areaPorPieza ?? roundQty(item.cantidad / (d.piezas || 1));
            const adicStr =
              costosAdic > 0
                ? `<div class="cart-item-meta">Material: ${formatCOP(precioMaterial)} + Adic.: ${formatCOP(costosAdic)}${item.conceptoAdicional ? ` (${escapeHtml(item.conceptoAdicional)})` : ""}</div>`
                : "";
            dimText = `<div class="cart-item-meta">Medida: ${anchoVis} × ${largoVis} ${escapeHtml(uDim)} · ${d.piezas} ${d.piezas === 1 ? "pieza" : "piezas"} (${areaPza} m²/pza = <b>${item.cantidad} m²</b>)</div>${adicStr}`;
          }

          const titleHtml = esTemporal
            ? `${escapeHtml(item.nombre)} <span class="badge-temp">SOLO ESTA VENTA</span>`
            : `${escapeHtml(item.nombre)}${item.codigo ? ` (${escapeHtml(item.codigo)})` : ""}`;

          const unitPriceHtml = puedeEditarPrecio
            ? `$ <input type="number" min="0" step="100" value="${item.precioUnitario}" data-price-input="${escapeHtml(item.lineId)}" aria-label="Precio unitario de ${escapeHtml(item.nombre)}" style="width:82px; padding:1px 4px; border:1px solid var(--border-color); border-radius:4px; font-size:.82rem; background:var(--bg-input); color:var(--text-primary)">${item.unidad ? ` / ${escapeHtml(item.unidad)}` : ""}`
            : `${formatCOP(item.precioUnitario)}${item.unidad ? ` / ${escapeHtml(item.unidad)}` : ""}`;

          const puedeDescLinea = hasPermission("ventas.descuento", user);
          const descLineaHtml = puedeDescLinea
            ? ` · Desc: $ <input type="number" min="0" step="100" value="${descLinea}" data-line-desc-input="${escapeHtml(item.lineId)}" aria-label="Descuento de ${escapeHtml(item.nombre)}" style="width:68px; padding:1px 4px; border:1px solid var(--border-color); border-radius:4px; font-size:.8rem; background:var(--bg-input); color:var(--text-primary)">`
            : descLinea > 0
              ? ` · Desc. ${formatCOP(descLinea)}`
              : "";

          const obsHtml = esTemporal
            ? `<input type="text" maxlength="140" value="${escapeHtml(item.observacion || "")}" placeholder="Observación opcional..." data-obs-input="${escapeHtml(item.lineId)}" aria-label="Observación de ${escapeHtml(item.nombre)}" style="width:100%; max-width:260px; margin-top:.35rem; padding:3px 7px; border:1px solid var(--border-color); border-radius:4px; font-size:.8rem; background:var(--bg-input); color:var(--text-primary)">`
            : "";

          return `
            <li class="cart-item" data-line="${escapeHtml(item.lineId)}">
              <div class="cart-item-title">${titleHtml}</div>
              <div class="cart-item-subtotal num">${formatCOP(subtotal)}</div>
              <div class="cart-item-meta num">${unitPriceHtml}${descLineaHtml}</div>
              ${dimText}
              ${obsHtml}
              <div class="cart-item-bottom">
                <span class="cart-item-qty-label">Cantidad: ${inputVal}</span>
                <div class="cart-item-actions">
                  <div class="cart-qty-controls" title="${esMedida ? "Cantidad de piezas de esta medida" : "Cantidad"}">
                    <button type="button" class="cart-qty-btn" data-qty-dec="${escapeHtml(item.lineId)}" aria-label="Disminuir">−</button>
                    <input
                      type="number"
                      class="cart-qty-pill"
                      min="${step}"
                      step="${step}"
                      value="${inputVal}"
                      data-qty-input="${escapeHtml(item.lineId)}"
                      aria-label="Cantidad de ${escapeHtml(item.nombre)}"
                    >
                    <button type="button" class="cart-qty-btn" data-qty-inc="${escapeHtml(item.lineId)}" aria-label="Aumentar">+</button>
                  </div>
                  <button
                    type="button"
                    class="cart-del-btn"
                    data-line-del="${escapeHtml(item.lineId)}"
                    title="Quitar producto"
                    aria-label="Quitar producto"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                      <path d="M10 11v6M14 11v6"/>
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                    </svg>
                  </button>
                </div>
              </div>
            </li>
          `;
        })
        .join("");
    }

    recalcularResumenPago();
    guardarBorradorPOS();
    renderCatalogo();
    if ($("#modal-catalogo-completo")?.classList.contains("is-open")) {
      renderCatalogoModal();
    }
    renderResumenLateralCatalogo();
  }

  function renderCatalogoModal() {
    const gridEl = $("#modal-product-grid");
    const countEl = $("#modal-cat-count");
    if (!gridEl) return;

    const q = ($("#buscar-catalogo-modal")?.value || "").trim().toLowerCase();
    const filtrados = q
      ? productos.filter(
          (p) =>
            String(p.nombre || "").toLowerCase().includes(q) ||
            String(p.codigo || "").toLowerCase().includes(q) ||
            String(p.categoria || "").toLowerCase().includes(q) ||
            String(p.referencia || "").toLowerCase().includes(q) ||
            String(p.codigoBarras || "").toLowerCase().includes(q)
        )
      : productos;

    if (countEl) countEl.textContent = `Mostrando ${filtrados.length} productos`;

    if (filtrados.length === 0) {
      gridEl.innerHTML = `
        <div class="card" style="grid-column: 1 / -1">
          <div class="empty" style="padding:1.75rem">
            <h3>Sin coincidencias</h3>
            <p>No se encontraron productos para esta búsqueda.</p>
          </div>
        </div>
      `;
      return;
    }

    gridEl.innerHTML = filtrados.map(renderTarjetaProductoHTML).join("");
  }

  function renderResumenLateralCatalogo() {
    const cliLabel = $("#modal-cat-cliente-nombre");
    const btnElegirCli = $("#btn-modal-cat-elegir-cliente");
    const listEl = $("#modal-cat-cart-list");
    const emptyEl = $("#modal-cat-cart-empty");
    const countEl = $("#modal-cat-items-count");
    const totalEl = $("#modal-cat-total");
    if (!listEl || !totalEl) return;

    const cliId = $("#pos-cliente")?.value || "";
    const cliObj = cliId ? clientes.find((c) => c.id === cliId) : null;
    if (cliLabel) {
      cliLabel.textContent = cliObj
        ? `${cliObj.nombre} (${cliObj.documento})`
        : "Ningún cliente seleccionado";
    }
    if (btnElegirCli) {
      btnElegirCli.classList.toggle("hidden", Boolean(cliObj));
    }

    if (cart.length === 0) {
      listEl.innerHTML = "";
      if (emptyEl) emptyEl.classList.remove("hidden");
    } else {
      if (emptyEl) emptyEl.classList.add("hidden");
      listEl.innerHTML = cart
        .map((item) => {
          const esMedida = Boolean(item.dimensiones);
          const subtotal = roundCOP(item.subtotal ?? item.precioUnitario * item.cantidad);
          const cantLabel = esMedida ? `${item.dimensiones.piezas} pza` : `${item.cantidad}`;
          return `
            <li class="cat-modal-cart-item">
              <div>
                <div style="font-weight:650; font-size:.9rem">${escapeHtml(item.nombre)}</div>
                <div class="text-muted" style="font-size:.8rem">${cantLabel}${item.unidad ? ` ${escapeHtml(item.unidad)}` : ""} · ${formatCOP(item.precioUnitario)}</div>
              </div>
              <div style="text-align:right">
                <div class="num" style="font-weight:700; font-size:.92rem">${formatCOP(subtotal)}</div>
                <div style="display:inline-flex; gap:.25rem; align-items:center; margin-top:.2rem">
                  <button type="button" class="btn btn-outline btn-xs" data-qty-dec="${escapeHtml(item.lineId)}" aria-label="Disminuir">−</button>
                  <button type="button" class="btn btn-outline btn-xs" data-qty-inc="${escapeHtml(item.lineId)}" aria-label="Aumentar">+</button>
                  <button type="button" class="btn btn-outline btn-xs" style="color:var(--danger)" data-line-del="${escapeHtml(item.lineId)}" aria-label="Quitar">×</button>
                </div>
              </div>
            </li>
          `;
        })
        .join("");
    }

    let total = 0;
    try {
      total = cart.length ? calcularTotalesVenta(cart, obtenerDescuentoFormulario()).total : 0;
    } catch {
      total = 0;
    }
    if (countEl) countEl.textContent = String(cart.length);
    totalEl.textContent = formatCOP(total);
  }

  const POS_DRAFT_KEY = "el_carmen_pos_draft_v1";

  function guardarBorradorPOS() {
    try {
      if (!cart || cart.length === 0) {
        localStorage.removeItem(POS_DRAFT_KEY);
        return;
      }
      localStorage.setItem(
        POS_DRAFT_KEY,
        JSON.stringify({
          cart,
          clienteId: $("#pos-cliente")?.value || "cli-consumidor",
          descuento: $("#cart-descuento-input")?.value || "0",
          descuentoTipo: $("#cart-descuento-tipo")?.value || "COP"
        })
      );
    } catch {
      // Ignorar si localStorage no está disponible
    }
  }

  function restaurarBorradorPOS() {
    try {
      const raw = localStorage.getItem(POS_DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (Array.isArray(draft?.cart) && draft.cart.length > 0 && cart.length === 0) {
        cart = draft.cart;
        if ($("#cart-descuento-input") && draft.descuento !== undefined) {
          $("#cart-descuento-input").value = String(draft.descuento);
        }
        if ($("#cart-descuento-tipo") && draft.descuentoTipo) {
          $("#cart-descuento-tipo").value = draft.descuentoTipo;
        }
      }
    } catch {
      // Ignorar borradores corruptos
    }
  }

  function obtenerDescuentoFormulario() {
    const raw = Math.max(0, parseMontoInput($("#cart-descuento-input")?.value));
    const tipo = $("#cart-descuento-tipo")?.value || "COP";
    return tipo === "%"
      ? { descuento: 0, descuentoPorcentaje: Math.min(100, raw) }
      : { descuento: roundCOP(raw), descuentoPorcentaje: 0 };
  }

  function syncModalidadButtons(valor) {
    const val = valor === "parcial" ? "parcial" : "completo";
    if ($("#modalidad-cobro")) $("#modalidad-cobro").value = val;
    root.querySelectorAll("[data-modalidad-btn]").forEach((btn) => {
      const activo = btn.dataset.modalidadBtn === val;
      btn.classList.toggle("btn-primary", activo);
      btn.classList.toggle("btn-outline", !activo);
      btn.setAttribute("aria-pressed", String(activo));
    });
  }

  function setModalidadCobro(valor) {
    syncModalidadButtons(valor);
    recalcularResumenPago();
  }

  function recalcularResumenPago() {
    const descInput = $("#cart-descuento-input");
    const descTipo = $("#cart-descuento-tipo");
    const user = getCurrentUser();
    if (descInput) {
      const puedeDescuento = hasPermission("ventas.descuento", user);
      descInput.disabled = !puedeDescuento;
      if (descTipo) descTipo.disabled = !puedeDescuento;
      if (!puedeDescuento) descInput.value = "0";
    }

    const descOpts = obtenerDescuentoFormulario();
    let calculo = { subtotal: 0, descuento: 0, impuesto: 0, total: 0 };
    const errEl = $("#cart-error");
    if (errEl) {
      errEl.textContent = "";
      errEl.classList.add("hidden");
    }

    try {
      if (cart.length > 0) {
        calculo = calcularTotalesVenta(cart, descOpts);
      }
    } catch (e) {
      if (errEl) {
        errEl.textContent = e.message;
        errEl.classList.remove("hidden");
      }
    }

    const subEl = $("#cart-subtotal");
    const descEl = $("#cart-descuento");
    const totEl = $("#cart-total");

    const descLineas = Array.isArray(calculo.lineas)
      ? calculo.lineas.reduce((acc, l) => acc + roundCOP(l.descuentoLinea || 0), 0)
      : 0;
    const subtotalSinDesc = roundCOP(calculo.subtotal + descLineas);
    const totalDescuentos = roundCOP(calculo.descuento + descLineas);

    if (subEl) subEl.textContent = formatCOP(subtotalSinDesc);
    if (descEl) {
      descEl.textContent = totalDescuentos > 0 ? `− ${formatCOP(totalDescuentos)}` : "$ 0";
    }
    if (totEl) totEl.textContent = formatCOP(calculo.total);

    // Visibilidad según modalidad de cobro y método de pago seleccionado
    const cliId = $("#pos-cliente")?.value || "";
    const cliObj = clientes.find((c) => c.id === cliId);
    const puedeCredito = Boolean(cliId) && hasPermission("ventas.credito", user) && cliId !== "cli-consumidor" && !cliObj?.esConsumidorFinal;
    const modSel = $("#modalidad-cobro");
    const btnParcial = root.querySelector('[data-modalidad-btn="parcial"]');
    if (btnParcial) btnParcial.disabled = !puedeCredito;
    const hintEl = $("#cobro-credito-hint");
    if (modSel) {
      if (!puedeCredito && modSel.value !== "completo") {
        syncModalidadButtons("completo");
      } else {
        syncModalidadButtons(modSel.value);
      }
    }
    if (hintEl) {
      if (!hasPermission("ventas.credito", user)) {
        hintEl.textContent = "Las ventas a crédito o con saldo pendiente requieren permiso de Administrador.";
        hintEl.classList.remove("hidden");
      } else if (cliId === "cli-consumidor" || cliObj?.esConsumidorFinal) {
        hintEl.textContent = "Selecciona un cliente identificado para habilitar pago parcial o crédito.";
        hintEl.classList.remove("hidden");
      } else {
        hintEl.classList.add("hidden");
      }
    }

    const modalidad = modSel?.value || "completo";
    const esCreditoTotal = modalidad === "credito";
    const saldoFavorDisp =
      cliId !== "cli-consumidor" && !cliObj?.esConsumidorFinal
        ? roundCOP(cliObj?.saldoAFavorDisponible || 0)
        : 0;
    const optSaldoFavor = $("#opt-metodo-saldo-favor");
    if (optSaldoFavor) {
      optSaldoFavor.disabled = !(saldoFavorDisp > 0);
    }
    const metodoSel = $("#metodo-pago");
    if (metodoSel && metodoSel.value === METODO_SALDO_FAVOR && !(saldoFavorDisp > 0)) {
      metodoSel.value = "Efectivo";
    }
    const metodo = metodoSel?.value || "Efectivo";

    const boxSaldoFavor = $("#box-saldo-favor");
    const inputSaldoFavor = $("#pago-saldo-favor");
    if (boxSaldoFavor) {
      boxSaldoFavor.classList.toggle("hidden", esCreditoTotal || !(saldoFavorDisp > 0));
    }
    if (inputSaldoFavor) {
      if (!(saldoFavorDisp > 0) || esCreditoTotal) {
        inputSaldoFavor.value = "0";
      } else if (metodo === METODO_SALDO_FAVOR && parseMontoInput(inputSaldoFavor.value) === 0) {
        inputSaldoFavor.value = formatMontoInput(Math.min(saldoFavorDisp, roundCOP(calculo.total)));
      }
      const aplicado = Math.min(
        saldoFavorDisp,
        roundCOP(calculo.total),
        Math.max(0, parseMontoInput(inputSaldoFavor.value))
      );
      if ($("#pos-billetera-disponible")) $("#pos-billetera-disponible").textContent = formatCOP(saldoFavorDisp);
      if ($("#pos-billetera-otros")) $("#pos-billetera-otros").textContent = formatCOP(Math.max(0, roundCOP(calculo.total) - aplicado));
      if ($("#pos-billetera-restante")) $("#pos-billetera-restante").textContent = formatCOP(Math.max(0, saldoFavorDisp - aplicado));
    }

    $("#field-metodo-pago")?.classList.toggle("hidden", esCreditoTotal);
    const mostrarBoxRecibido =
      !esCreditoTotal &&
      metodo !== METODO_SALDO_FAVOR &&
      (metodo === "Efectivo" || (modalidad === "parcial" && metodo !== "Mixto"));
    $("#box-pago-efectivo")?.classList.toggle("hidden", !mostrarBoxRecibido);
    const lblRecibido = $("#box-pago-efectivo label");
    if (lblRecibido) {
      lblRecibido.textContent =
        modalidad === "parcial" && metodo !== "Efectivo"
          ? `Importe del abono inicial (${metodo})`
          : "Valor recibido en efectivo (COP)";
    }
    $("#box-pago-electronico")?.classList.toggle(
      "hidden",
      esCreditoTotal || metodo === "Efectivo" || metodo === "Mixto" || metodo === METODO_SALDO_FAVOR
    );
    $("#box-pago-mixto")?.classList.toggle("hidden", esCreditoTotal || metodo !== "Mixto");
    $("#row-cambio")?.classList.toggle(
      "hidden",
      esCreditoTotal || (metodo !== "Efectivo" && metodo !== "Mixto")
    );

    updateCobrarButtonState(calculo.total);
  }

  function updateCobrarButtonState(totalActual = null) {
    const btnCobrar = $("#btn-cobrar");
    const labelCambio = $("#label-cambio-faltante");
    const cambioEl = $("#cart-cambio");
    const recibidoResumenEl = $("#cart-valor-recibido-resumen");
    const rowSaldo = $("#row-saldo-pendiente");
    const saldoEl = $("#cart-saldo-pendiente");
    const errEl = $("#cart-error");
    if (!btnCobrar) return;

    const descOpts = obtenerDescuentoFormulario();
    let total = totalActual;
    if (total === null) {
      try {
        total = cart.length ? calcularTotalesVenta(cart, descOpts).total : 0;
      } catch {
        total = 0;
      }
    }

    if (!cajaAbierta || !tieneClienteSeleccionado() || cart.length === 0 || !(total > 0) || isProcessingSale) {
      btnCobrar.disabled = true;
      if (recibidoResumenEl) recibidoResumenEl.textContent = "$ 0";
      if (labelCambio) labelCambio.textContent = "Cambio a devolver";
      if (cambioEl) {
        cambioEl.textContent = "$ 0";
        cambioEl.className = "num cart-cambio-amount";
      }
      if (rowSaldo) rowSaldo.classList.add("hidden");
      return;
    }

    const modalidad = $("#modalidad-cobro")?.value || "completo";
    if (modalidad === "credito") {
      if (recibidoResumenEl) recibidoResumenEl.textContent = "$ 0";
      if (rowSaldo) rowSaldo.classList.remove("hidden");
      if (saldoEl) saldoEl.textContent = formatCOP(total);
      btnCobrar.disabled = false;
      btnCobrar.textContent = "Registrar venta a crédito";
      return;
    }

    btnCobrar.textContent = modalidad === "parcial" ? "Registrar venta con saldo" : "Cobrar venta";

    try {
      const pagos = obtenerPagosFormulario(total);
      const ev = evaluarPagos({ total, pagos });
      if (recibidoResumenEl) recibidoResumenEl.textContent = formatCOP(ev.totalRecibido);
      if (modalidad === "parcial") {
        if (rowSaldo) rowSaldo.classList.remove("hidden");
        if (saldoEl) saldoEl.textContent = formatCOP(ev.faltante);
        if (labelCambio) labelCambio.textContent = "Cambio a devolver";
        if (cambioEl) {
          cambioEl.textContent = formatCOP(ev.cambio);
          cambioEl.className = "num cart-cambio-amount";
        }
        btnCobrar.disabled = ev.totalRecibido <= 0 || ev.faltante <= 0;
      } else {
        if (rowSaldo) rowSaldo.classList.add("hidden");
        if (!ev.completo) {
          if (labelCambio) labelCambio.textContent = "Faltante";
          if (cambioEl) {
            cambioEl.textContent = formatCOP(ev.faltante);
            cambioEl.className = "num text-expense";
          }
          btnCobrar.disabled = true;
        } else {
          if (labelCambio) labelCambio.textContent = "Cambio a devolver";
          if (cambioEl) {
            cambioEl.textContent = formatCOP(ev.cambio);
            cambioEl.className = "num cart-cambio-amount";
          }
          btnCobrar.disabled = false;
        }
      }
    } catch {
      if (recibidoResumenEl) recibidoResumenEl.textContent = "$ 0";
      if (rowSaldo) rowSaldo.classList.add("hidden");
      if (labelCambio) labelCambio.textContent = "Faltante";
      if (cambioEl) {
        cambioEl.textContent = formatCOP(total);
        cambioEl.className = "num text-expense";
      }
      if (errEl && !errEl.textContent) {
        // Sin mensaje intrusivo mientras escribe
      }
      btnCobrar.disabled = true;
    }
  }

  // -------------------------------------------------------------------------
  // 4. CLIENTES E HISTORIAL DE VENTAS (Secciones 7, 10, 11 y 13)
  // -------------------------------------------------------------------------
  let clienteCarteraDetalleId = null;
  let clienteHistorialId = null;
  let clientSearchTimer = null;

  function renderSelectorClientes(seleccionarId = null) {
    const hiddenEl = $("#pos-cliente");
    if (!hiddenEl) return;
    const prev = seleccionarId !== null ? seleccionarId : hiddenEl.value;
    const cli =
      prev && prev !== "cli-consumidor"
        ? clientes.find((c) => c.id === prev && !c.esConsumidorFinal)
        : null;

    const avisoEl = $("#pos-cliente-aviso");
    const selCard = $("#pos-cliente-seleccionado");
    const boxBuscar = $("#box-buscar-cliente");
    const btnCambiar = $("#btn-cambiar-cliente");
    const sepCambiar = $("#sep-cambiar-cliente");
    const nomEl = $("#pos-cli-nombre");
    const docEl = $("#pos-cli-doc");
    const saldoBadge = $("#pos-cli-saldo-badge");
    const btnHist = $("#btn-ver-historial-cliente");
    const btnLimpiar = $("#btn-limpiar-cliente");

    if (!cli) {
      hiddenEl.value = "";
      if (avisoEl) avisoEl.classList.remove("hidden");
      if (selCard) selCard.classList.add("hidden");
      if (boxBuscar) boxBuscar.classList.remove("hidden");
      if (btnCambiar) btnCambiar.classList.add("hidden");
      if (sepCambiar) sepCambiar.classList.add("hidden");
      if (btnHist) btnHist.classList.add("hidden");
      if (btnLimpiar) btnLimpiar.classList.add("hidden");
      if (saldoBadge) saldoBadge.classList.add("hidden");
      if ($("#pago-saldo-favor")) $("#pago-saldo-favor").value = "0";
      recalcularResumenPago();
      return;
    }

    hiddenEl.value = cli.id;
    if (avisoEl) avisoEl.classList.add("hidden");
    if (selCard) selCard.classList.remove("hidden");
    if (boxBuscar) boxBuscar.classList.add("hidden");
    const resBuscar = $("#pos-cliente-resultados");
    if (resBuscar) {
      resBuscar.innerHTML = "";
      resBuscar.classList.add("hidden");
    }
    if ($("#pos-cliente-buscar")) $("#pos-cliente-buscar").value = "";
    if (btnCambiar) btnCambiar.classList.remove("hidden");
    if (sepCambiar) sepCambiar.classList.remove("hidden");
    if (nomEl) nomEl.textContent = cli.nombre;
    if (docEl) {
      docEl.textContent = `${cli.documento}${cli.telefono ? ` · ${cli.telefono}` : ""}`;
    }

    const hist = obtenerHistorialCliente(cli.id, { ventas });
    const saldoFavor = roundCOP(cli.saldoAFavorDisponible || 0);
    if (saldoBadge) {
      const mostrarBadge = hist.saldoPendienteTotal > 0 || saldoFavor > 0;
      saldoBadge.classList.toggle("hidden", !mostrarBadge);
      const partes = [];
      if (hist.saldoPendienteTotal > 0) partes.push(`Por cobrar: ${formatCOP(hist.saldoPendienteTotal)}`);
      if (saldoFavor > 0) partes.push(`Saldo a favor: ${formatCOP(saldoFavor)}`);
      saldoBadge.textContent = partes.join(" · ");
    }
    if ($("#pago-saldo-favor") && saldoFavor === 0) {
      $("#pago-saldo-favor").value = "0";
    }
    if (btnHist) btnHist.classList.remove("hidden");
    if (btnLimpiar) btnLimpiar.classList.remove("hidden");

    recalcularResumenPago();
  }

  function renderResultadosBusquedaClientes(termino = "") {
    const box = $("#pos-cliente-resultados");
    if (!box) return;
    const q = String(termino || "").trim();
    if (!q) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    const matches = buscarClientes(q, clientes)
      .filter((c) => !c.esConsumidorFinal && c.id !== "cli-consumidor")
      .slice(0, 10);
    if (matches.length === 0) {
      box.innerHTML = `<div style="padding:.5rem .75rem; font-size:.82rem" class="text-muted">Sin coincidencias. Usa "+ Nuevo cliente" para registrarlo.</div>`;
    } else {
      box.innerHTML = matches
        .map(
          (c) => `
          <button type="button" data-select-cliente="${escapeHtml(c.id)}" style="display:flex; justify-content:space-between; width:100%; text-align:left; padding:.45rem .7rem; border:0; border-bottom:1px solid var(--border); background:none; cursor:pointer; font-size:.82rem">
            <span><b>${escapeHtml(c.nombre)}</b></span>
            <span class="text-muted">${escapeHtml(c.documento)}${c.telefono ? ` · ${escapeHtml(c.telefono)}` : ""}</span>
          </button>
        `
        )
        .join("");
    }
    box.classList.remove("hidden");
  }

  function renderCarteraClientes() {
    const tbody = $("#tbody-cartera-clientes");
    const badge = $("#cartera-total-badge");
    if (!tbody) return;

    const q = $("#cartera-buscar")?.value || "";
    const cartera = listarCarteraClientes(clientes, ventas, q);
    const totalCartera = cartera.reduce((acc, r) => acc + r.totalPendiente, 0);
    if (badge) badge.textContent = `${formatCOP(totalCartera)} por cobrar`;

    if (cartera.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:1.25rem" class="text-muted">No hay clientes con saldo pendiente.</td></tr>`;
    } else {
      tbody.innerHTML = cartera
        .map(
          (r) => `
          <tr>
            <td><b>${escapeHtml(r.cliente.nombre)}</b></td>
            <td>${escapeHtml(r.cliente.documento)}</td>
            <td class="num"><b class="text-expense">${formatCOP(r.totalPendiente)}</b></td>
            <td class="num">${r.operacionesPendientes}</td>
            <td>${r.ultimoMovimiento ? formatDateTime(r.ultimoMovimiento) : "—"}</td>
            <td class="text-right" style="white-space:nowrap">
              <button type="button" class="btn btn-outline btn-xs" data-ver-cartera="${escapeHtml(r.cliente.id)}">Ver detalle</button>
              <button type="button" class="btn btn-outline btn-xs" data-ver-hist-cli="${escapeHtml(r.cliente.id)}">Historial</button>
            </td>
          </tr>
        `
        )
        .join("");
    }

    if (clienteCarteraDetalleId) {
      renderDetalleCarteraCliente(clienteCarteraDetalleId);
    }
  }

  function renderDetalleCarteraCliente(clienteId) {
    const panel = $("#cartera-detalle-panel");
    const tbody = $("#tbody-cartera-detalle");
    const title = $("#cartera-detalle-titulo");
    if (!panel || !tbody) return;

    const cli = clientes.find((c) => c.id === clienteId);
    const hist = obtenerHistorialCliente(clienteId, { ventas });
    const pendientes = hist.ventas.filter((v) => calcularSaldoPendienteVenta(v) > 0);

    if (!cli || pendientes.length === 0) {
      clienteCarteraDetalleId = null;
      panel.classList.add("hidden");
      return;
    }

    if (title) {
      title.textContent = `Cuentas pendientes de ${cli.nombre} (${cli.documento}) · Saldo total: ${formatCOP(hist.saldoPendienteTotal)}`;
    }
    const tbodyProds = $("#tbody-productos-cliente");
    if (tbodyProds) {
      const filasProds = [];
      const cliActualId = $("#pos-cliente")?.value || "cli-consumidor";
      if (cliActualId === cli.id && cart.length > 0) {
        for (const item of cart) {
          filasProds.push(`
            <tr>
              <td><span class="badge badge-warning">Venta en curso</span></td>
              <td><b>${escapeHtml(item.nombre)}</b>${item.esTemporal ? ` <span class="badge-temp">SOLO ESTA VENTA</span>` : ""}</td>
              <td class="num">${item.cantidad}${item.unidad ? ` ${escapeHtml(item.unidad)}` : ""}</td>
              <td class="num">${formatCOP(item.precioUnitario)}</td>
              <td class="num"><b>${formatCOP(item.subtotal)}</b></td>
            </tr>
          `);
        }
      }
      for (const v of hist.ventas) {
        if (v.estado === "Anulada") continue;
        for (const item of v.items || []) {
          filasProds.push(`
            <tr>
              <td><b>${escapeHtml(v.numero)}</b><br><small class="text-muted">${formatDateTime(v.fecha)}</small></td>
              <td>${escapeHtml(item.nombre)}${item.esTemporal ? ` <span class="badge-temp">SOLO ESTA VENTA</span>` : ""}</td>
              <td class="num">${item.cantidad}${item.unidad ? ` ${escapeHtml(item.unidad)}` : ""}</td>
              <td class="num">${formatCOP(item.precioUnitario)}</td>
              <td class="num"><b>${formatCOP(item.subtotal)}</b></td>
            </tr>
          `);
        }
      }
      tbodyProds.innerHTML = filasProds.length
        ? filasProds.join("")
        : `<tr><td colspan="5" class="text-muted" style="text-align:center; padding:1rem">Este cliente aún no tiene productos registrados.</td></tr>`;
    }

    const puedeAbonar = hasPermission("ventas.abonar", getCurrentUser());

    tbody.innerHTML = pendientes
      .map((v) => {
        const saldo = calcularSaldoPendienteVenta(v);
        const abonado = Math.max(0, roundCOP(v.total) - saldo);
        return `
          <tr>
            <td><b>${escapeHtml(v.numero)}</b></td>
            <td>${formatDateTime(v.fecha)}</td>
            <td class="num">${formatCOP(v.total)}</td>
            <td class="num">${formatCOP(abonado)}</td>
            <td class="num"><b class="text-expense">${formatCOP(saldo)}</b></td>
            <td><span class="badge badge-warning">Pendiente</span></td>
            <td class="text-right" style="white-space:nowrap">
              <button type="button" class="btn btn-outline btn-xs" data-ver-comprobante="${escapeHtml(v.id)}">Comprobante</button>
              ${puedeAbonar ? `<button type="button" class="btn btn-primary btn-xs" data-abrir-abono="${escapeHtml(v.id)}">Registrar abono</button>` : ""}
            </td>
          </tr>
        `;
      })
      .join("");
    panel.classList.remove("hidden");
  }

  function abrirModalHistorialCliente(clienteId) {
    const cli = clientes.find((c) => c.id === clienteId);
    if (!cli) return;
    clienteHistorialId = clienteId;
    renderModalHistorialCliente();
    $("#modal-historial-cliente")?.classList.add("is-open");
  }

  function renderModalHistorialCliente() {
    if (!clienteHistorialId) return;
    const cli = clientes.find((c) => c.id === clienteHistorialId);
    if (!cli) return;
    const desde = $("#hist-cli-desde")?.value || "";
    const hasta = $("#hist-cli-hasta")?.value || "";
    const hist = obtenerHistorialCliente(clienteHistorialId, { desde, hasta, ventas });

    if ($("#hist-cli-nombre")) $("#hist-cli-nombre").textContent = cli.nombre;
    if ($("#hist-cli-doc")) {
      $("#hist-cli-doc").textContent = `${cli.documento}${cli.telefono ? ` · Tel: ${cli.telefono}` : ""}`;
    }
    if ($("#hist-cli-total")) $("#hist-cli-total").textContent = formatCOP(hist.totalHistorico);
    if ($("#hist-cli-saldo")) $("#hist-cli-saldo").textContent = formatCOP(hist.saldoPendienteTotal);

    const tbody = $("#tbody-historial-cliente");
    if (!tbody) return;

    // Renderizar resumen y movimientos de Billetera de saldo a favor en la ficha del cliente
    const resumenBil = obtenerResumenBilleteraCliente(clienteHistorialId, { clientes, movimientosBilletera });
    const modalBody = tbody.closest(".modal-body");
    if (modalBody) {
      let boxBil = $("#hist-cli-billetera-box", modalBody);
      if (!boxBil) {
        boxBil = document.createElement("div");
        boxBil.id = "hist-cli-billetera-box";
        boxBil.style.marginTop = "1rem";
        boxBil.style.padding = ".75rem";
        boxBil.style.border = "1px solid var(--border)";
        boxBil.style.borderRadius = "var(--radius-sm)";
        boxBil.style.background = "#f8fafc";
        modalBody.appendChild(boxBil);
      }
      boxBil.innerHTML = `
        <div class="flex justify-between items-center" style="margin-bottom:.5rem; flex-wrap:wrap; gap:.5rem">
          <strong>Billetera de saldo a favor</strong>
          <div class="flex gap-2" style="font-size:.82rem">
            <span>Disponible: <b class="num" style="color:#166534">${formatCOP(resumenBil.saldoDisponible)}</b></span>
            <span>· Generado: <b class="num">${formatCOP(resumenBil.totalGenerado)}</b></span>
            <span>· Utilizado: <b class="num">${formatCOP(resumenBil.totalUtilizado)}</b></span>
          </div>
        </div>
        ${
          resumenBil.movimientos.length === 0
            ? `<div class="text-muted" style="font-size:.82rem">Sin movimientos de billetera registrados.</div>`
            : `<div class="table-wrap"><table style="font-size:.8rem">
                <thead><tr><th>Fecha</th><th>Tipo</th><th class="num">Monto</th><th class="num">Saldo</th><th>Referencia</th><th>Usuario</th></tr></thead>
                <tbody>
                  ${resumenBil.movimientos
                    .map(
                      (m) => `<tr>
                        <td>${formatDateTime(m.fecha)}</td>
                        <td><span class="badge">${escapeHtml(m.tipo)}</span></td>
                        <td class="num"><b>${formatCOP(m.monto)}</b></td>
                        <td class="num">${formatCOP(m.saldoAnterior)} → ${formatCOP(m.saldoPosterior)}</td>
                        <td>${escapeHtml(m.numeroVenta || m.devolucionId || m.observaciones || "")}</td>
                        <td>${escapeHtml(m.usuario || "")}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table></div>`
        }
      `;
    }

    const tbodyProds = $("#tbody-productos-cliente");
    if (tbodyProds) {
      const filasProds = [];
      const cliActualId = $("#pos-cliente")?.value || "cli-consumidor";
      if (cliActualId === cli.id && cart.length > 0) {
        for (const item of cart) {
          filasProds.push(`
            <tr>
              <td><span class="badge badge-warning">Venta en curso</span></td>
              <td><b>${escapeHtml(item.nombre)}</b>${item.esTemporal ? ` <span class="badge-temp">SOLO ESTA VENTA</span>` : ""}</td>
              <td class="num">${item.cantidad}${item.unidad ? ` ${escapeHtml(item.unidad)}` : ""}</td>
              <td class="num">${formatCOP(item.precioUnitario)}</td>
              <td class="num"><b>${formatCOP(item.subtotal)}</b></td>
            </tr>
          `);
        }
      }
      for (const v of hist.ventas) {
        if (v.estado === "Anulada") continue;
        for (const item of v.items || []) {
          filasProds.push(`
            <tr>
              <td><b>${escapeHtml(v.numero)}</b><br><small class="text-muted">${formatDateTime(v.fecha)}</small></td>
              <td>${escapeHtml(item.nombre)}${item.esTemporal ? ` <span class="badge-temp">SOLO ESTA VENTA</span>` : ""}</td>
              <td class="num">${item.cantidad}${item.unidad ? ` ${escapeHtml(item.unidad)}` : ""}</td>
              <td class="num">${formatCOP(item.precioUnitario)}</td>
              <td class="num"><b>${formatCOP(item.subtotal)}</b></td>
            </tr>
          `);
        }
      }
      tbodyProds.innerHTML = filasProds.length
        ? filasProds.join("")
        : `<tr><td colspan="5" class="text-muted" style="text-align:center; padding:1rem">Este cliente aún no tiene productos registrados.</td></tr>`;
    }

    if (hist.ventas.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:1.25rem" class="text-muted">No hay ventas registradas para este cliente en el rango seleccionado.</td></tr>`;
      return;
    }

    const puedeAbonar = hasPermission("ventas.abonar", getCurrentUser());
    tbody.innerHTML = hist.ventas
      .map((v) => {
        const saldo = calcularSaldoPendienteVenta(v);
        const pagado = v.estado === "Anulada" ? 0 : Math.max(0, roundCOP(v.total) - saldo);
        const badgeEstado =
          v.estado === "Anulada"
            ? `<span class="badge badge-danger">Anulada</span>`
            : saldo > 0
              ? `<span class="badge badge-warning">Saldo pendiente</span>`
              : `<span class="badge badge-success">Pagada</span>`;
        return `
          <tr>
            <td><b>${escapeHtml(v.numero)}</b></td>
            <td>${formatDateTime(v.fecha)}</td>
            <td class="num">${formatCOP(v.total)}</td>
            <td class="num">${formatCOP(pagado)}</td>
            <td class="num ${saldo > 0 ? "text-expense" : ""}"><b>${formatCOP(saldo)}</b></td>
            <td>${badgeEstado}</td>
            <td>${escapeHtml(v.vendedor || "")}</td>
            <td class="text-right" style="white-space:nowrap">
              <button type="button" class="btn btn-outline btn-xs" data-ver-comprobante="${escapeHtml(v.id)}">Detalle</button>
              ${v.estado !== "Anulada" && saldo > 0 && puedeAbonar ? `<button type="button" class="btn btn-primary btn-xs" data-abrir-abono="${escapeHtml(v.id)}">Abonar</button>` : ""}
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function abrirModalRegistrarAbono(ventaId) {
    const v = ventas.find((x) => x.id === ventaId);
    if (!v) return;
    const saldo = calcularSaldoPendienteVenta(v);
    if (!(saldo > 0)) {
      showFeedback("Esta venta ya está completamente pagada.", "info");
      return;
    }
    const pagado = Math.max(0, roundCOP(v.total) - saldo);
    if ($("#abono-venta-id")) $("#abono-venta-id").value = v.id;
    if ($("#abono-venta-numero")) $("#abono-venta-numero").textContent = v.numero;
    if ($("#abono-venta-cliente")) $("#abono-venta-cliente").textContent = `${v.cliente?.nombre || ""} (${v.cliente?.documento || ""})`;
    if ($("#abono-venta-total")) $("#abono-venta-total").textContent = formatCOP(v.total);
    if ($("#abono-venta-pagado")) $("#abono-venta-pagado").textContent = formatCOP(pagado);
    if ($("#abono-venta-saldo")) $("#abono-venta-saldo").textContent = formatCOP(saldo);
    if ($("#abono-importe")) {
      $("#abono-importe").value = "";
      $("#abono-importe").max = String(saldo);
    }
    if ($("#abono-referencia")) $("#abono-referencia").value = "";
    if ($("#abono-nuevo-saldo")) $("#abono-nuevo-saldo").textContent = formatCOP(saldo);
    $("#abono-error")?.classList.add("hidden");
    $("#modal-registrar-abono")?.classList.add("is-open");
  }

  function renderHistorialVentas() {
    const tbody = $("#tbody-historial-ventas");
    const countEl = $("#historial-ventas-count");
    if (!tbody) return;

    const filtradas = filtrarHistorialVentas(ventas, {
      busqueda: $("#hist-buscar")?.value || "",
      desde: $("#hist-desde")?.value || "",
      hasta: $("#hist-hasta")?.value || "",
      metodoPago: $("#hist-metodo")?.value || "Todos",
      estado: $("#hist-estado")?.value || "Todos"
    });

    if (countEl) countEl.textContent = `${filtradas.length} ventas`;

    if (filtradas.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:1.5rem" class="text-muted">No hay ventas que coincidan con la búsqueda.</td></tr>`;
      return;
    }

    const puedeAnular = hasPermission("ventas.anular", getCurrentUser());
    const puedeDevolver = hasPermission("ventas.devolucion", getCurrentUser());
    const puedeAbonar = hasPermission("ventas.abonar", getCurrentUser());

    tbody.innerHTML = filtradas
      .map((v) => {
        const badgeCls =
          v.estado === "Completada"
            ? "badge-success"
            : v.estado === "Devuelta"
              ? "badge-warning"
              : "badge-danger";
        const saldo = calcularSaldoPendienteVenta(v);
        const saldoHtml =
          v.estado !== "Anulada" && saldo > 0
            ? `<br><small class="text-expense">Saldo: ${formatCOP(saldo)}</small>`
            : "";
        const billeteraHtml =
          roundCOP(v.saldoAFavorAplicado || 0) > 0
            ? `<br><small style="color:#166534">Billetera: ${formatCOP(v.saldoAFavorAplicado)}</small>`
            : "";
        return `
          <tr>
            <td style="white-space:nowrap"><b>${escapeHtml(v.numero)}</b></td>
            <td style="white-space:nowrap">${formatDateTime(v.fecha)}</td>
            <td>${escapeHtml(v.cliente?.nombre || "Consumidor Final")}</td>
            <td><span class="badge">${escapeHtml(v.metodoPago)}</span>${billeteraHtml}</td>
            <td class="num"><b>${formatCOP(v.total)}</b>${saldoHtml}</td>
            <td><span class="badge ${badgeCls}">${escapeHtml(v.estado)}</span></td>
            <td class="text-right" style="white-space:nowrap">
              <button type="button" class="btn btn-outline btn-xs" data-ver-comprobante="${escapeHtml(v.id)}">Comprobante</button>
              ${
                v.estado !== "Anulada" && saldo > 0 && puedeAbonar
                  ? `<button type="button" class="btn btn-primary btn-xs" data-abrir-abono="${escapeHtml(v.id)}">Abonar</button>`
                  : ""
              }
              ${
                v.estado === "Completada" && puedeDevolver
                  ? `<button type="button" class="btn btn-outline btn-xs" data-abrir-devolucion="${escapeHtml(v.id)}">Devolver</button>`
                  : ""
              }
              ${
                v.estado === "Completada" && puedeAnular
                  ? `<button type="button" class="btn btn-outline btn-xs" style="color:var(--danger); border-color:var(--danger)" data-abrir-anular="${escapeHtml(v.id)}">Anular</button>`
                  : ""
              }
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function mostrarModalComprobante(venta) {
    const comp = generarDatosComprobante(venta);
    const body = $("#comprobante-body");
    const modal = $("#modal-comprobante");
    if (!body || !modal) return;

    const formatearCantUnidad = (cant, unidad) => {
      if (unidad === "u") return Number(cant) === 1 ? "1 unidad" : `${cant} unidades`;
      if (unidad) return `${cant} ${escapeHtml(unidad)}`;
      return `${cant}`;
    };

    const itemsHtml = comp.items
      .map((i) => {
        let extras = "";
        if (i.dimensiones) {
          const d = i.dimensiones;
          const uDim = d.unidadDimension || "cm";
          const anchoVis = d.ancho ?? d.anchoCm;
          const largoVis = d.largo ?? d.altoCm;
          const areaPza = d.areaPorPieza ?? roundQty(i.cantidad / (d.piezas || 1));
          const adic =
            roundCOP(i.costosAdicionales || 0) > 0
              ? ` · Material: ${formatCOP(i.precioMaterial ?? i.precioUnitario * i.cantidad)} + Adic.: ${formatCOP(i.costosAdicionales)}${i.conceptoAdicional ? ` (${escapeHtml(i.conceptoAdicional)})` : ""}`
              : "";
          extras += `<div class="receipt-item-extra">Medida: ${anchoVis} × ${largoVis} ${escapeHtml(uDim)} · ${d.piezas} pza (${areaPza} m²/pza)${adic}</div>`;
        }
        if (i.esTemporal && i.observacion) {
          extras += `<div class="receipt-item-extra">${escapeHtml(i.observacion)}</div>`;
        }
        if (roundCOP(i.descuentoLinea || 0) > 0) {
          extras += `<div class="receipt-item-extra text-expense">Descuento línea: −${formatCOP(i.descuentoLinea)}</div>`;
        }

        const btnConvertir =
          i.esTemporal && hasPermission("inventario.gestionar", getCurrentUser())
            ? ` <button type="button" class="btn btn-outline btn-xs" data-convert-temp-nombre="${escapeHtml(i.nombre)}" data-convert-temp-unidad="${escapeHtml(i.unidad || "")}" data-convert-temp-precio="${roundCOP(i.precioUnitario || 0)}">Convertir a producto</button>`
            : "";

        const nombreHtml = i.esTemporal
          ? `${escapeHtml(i.nombre)} <span class="badge-temp">SOLO ESTA VENTA</span>${btnConvertir}`
          : escapeHtml(i.nombre);

        return `
          <div class="receipt-item">
            <div class="receipt-item-top">
              <span>${nombreHtml}</span>
              <span class="num">${formatearCantUnidad(i.cantidad, i.unidad)}</span>
            </div>
            <div class="receipt-item-sub">
              <span>Referencia: ${escapeHtml(i.codigo || "Sin ref.")}</span>
              <span class="num"><b>${formatCOP(i.subtotal)}</b></span>
            </div>
            ${extras}
          </div>
        `;
      })
      .join("");

    const devolucionesHtml =
      Array.isArray(comp.devoluciones) && comp.devoluciones.length > 0
        ? `
          <div class="receipt-section">
            <div class="receipt-section-title">DEVOLUCIONES REGISTRADAS (${comp.devoluciones.length} · ${formatCOP(comp.totalDevueltoAcumulado)})</div>
            ${comp.devoluciones
              .map(
                (d) => `
                <div class="receipt-dev-box">
                  <div><b>${formatDateTime(d.fecha)}</b> · ${escapeHtml(d.tipoReembolso || "Reembolso")}: <b class="num">${formatCOP(d.totalDevuelto)}</b> · <i>${escapeHtml(d.motivo)}</i></div>
                  <div class="text-muted">${(d.items || []).map((it) => `${escapeHtml(it.nombre)} × ${it.cantidad}${it.unidad ? ` ${escapeHtml(it.unidad)}` : ""}`).join(", ")}</div>
                </div>`
              )
              .join("")}
          </div>
        `
        : "";

    let estadoClass = "is-completed";
    let estadoTexto = "VENTA COMPLETADA";
    if (comp.estado === "Anulada") {
      estadoClass = "is-voided";
      estadoTexto = "VENTA ANULADA";
    } else if (comp.estado === "Devuelta") {
      estadoClass = "is-voided";
      estadoTexto = "VENTA DEVUELTA";
    } else if (comp.saldoPendiente > 0) {
      estadoClass = "is-partial";
      estadoTexto = "PAGO PARCIAL · SALDO PENDIENTE";
    }

    const metodosUsados = [...new Set((comp.pagos || []).map((p) => p.metodo).filter(Boolean))];
    const metodoResumen =
      metodosUsados.length > 1
        ? `Pago mixto (${metodosUsados.join(" + ")})`
        : metodosUsados[0] || venta.metodoPago || "Efectivo";

    const docCli = comp.cliente?.documento && comp.cliente.documento !== "222222222222"
      ? ` (${escapeHtml(comp.cliente.documento)})`
      : "";
    const clienteDisplay = `${escapeHtml(comp.cliente?.nombre || "Cliente")}${docCli}`;

    const valorRecibido = roundCOP(
      comp.totalRecibido ?? comp.valorRecibido ?? comp.importePagado + (comp.cambio || 0)
    );
    const tieneAbonos = Array.isArray(comp.pagos) && comp.pagos.some((p) => p.tipoPago === "Abono");
    const esPagoParcialOHistorial = comp.saldoPendiente > 0 || tieneAbonos;

    let pagosHtml = "";
    if (esPagoParcialOHistorial) {
      const listaPagos = Array.isArray(comp.pagos) ? comp.pagos : [];
      const filasAbonos =
        listaPagos.length === 1 && !tieneAbonos
          ? `<div class="receipt-row"><span class="receipt-row-label">Abono inicial recibido (${escapeHtml(listaPagos[0].metodo || "Efectivo")})</span><b class="receipt-row-val num">${formatCOP(listaPagos[0].importe)}</b></div>`
          : listaPagos
              .map((p, idx) => {
                const fechaEtq = p.fecha ? ` · ${formatShortDate(p.fecha)}` : "";
                return `<div class="receipt-row"><span class="receipt-row-label">Abono ${idx + 1} (${escapeHtml(p.metodo || "Efectivo")}${fechaEtq})</span><b class="receipt-row-val num">${formatCOP(p.importe)}</b></div>`;
              })
              .join("");

      pagosHtml = `
        ${comp.anticipoAplicado > 0 ? `<div class="receipt-row"><span class="receipt-row-label">Anticipo aplicado</span><b class="receipt-row-val num">${formatCOP(comp.anticipoAplicado)}</b></div>` : ""}
        ${filasAbonos}
        <div class="receipt-row">
          <span class="receipt-row-label">Total abonado a la fecha</span>
          <b class="receipt-applied-amount num">${formatCOP(comp.importePagado)}</b>
        </div>
        ${
          comp.saldoPendiente > 0
            ? `<div class="receipt-row receipt-pending-row">
                <span class="receipt-pending-label">Saldo pendiente por pagar</span>
                <span class="receipt-pending-amount num">${formatCOP(comp.saldoPendiente)}</span>
              </div>`
            : `<div class="receipt-row receipt-change-row">
                <span class="receipt-change-label">Cambio entregado</span>
                <span class="receipt-change-amount num">${formatCOP(comp.cambio || 0)}</span>
              </div>`
        }
      `;
    } else {
      pagosHtml = `
        <div class="receipt-row">
          <span class="receipt-row-label">Valor recibido</span>
          <b class="receipt-row-val num">${formatCOP(valorRecibido)}</b>
        </div>
        <div class="receipt-row">
          <span class="receipt-row-label">Valor aplicado</span>
          <b class="receipt-row-val num">${formatCOP(comp.importePagado)}</b>
        </div>
        <div class="receipt-row receipt-change-row">
          <span class="receipt-change-label">Cambio entregado</span>
          <span class="receipt-change-amount num">${formatCOP(comp.cambio || 0)}</span>
        </div>
      `;
    }

    body.innerHTML = `
      <div class="receipt-modern">
        <!-- 1. Encabezado centrado con icono de tienda y estado inteligente -->
        <div class="receipt-header">
          <div class="receipt-store-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 9l1-5h16l1 5"/>
              <path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/>
              <path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8"/>
              <path d="M9 21v-6h6v6"/>
            </svg>
          </div>
          <div class="receipt-brand">${escapeHtml(String(comp.establecimiento || "VIDRIOS Y ALUMINIOS EL CARMEN").toUpperCase())}</div>
          <div class="receipt-subtitle">${escapeHtml(comp.tipoDocumento || "Comprobante interno de venta")}</div>
          <span class="receipt-status-badge ${estadoClass}">${estadoTexto}</span>
          <div class="receipt-number num">${escapeHtml(comp.numero)}</div>
        </div>

        <!-- 2. Información de la venta -->
        <div class="receipt-section">
          <div class="receipt-section-title">INFORMACIÓN DE LA VENTA</div>
          <div class="receipt-row">
            <span class="receipt-row-label">Fecha</span>
            <b class="receipt-row-val">${escapeHtml(formatDateTime(comp.fecha))}</b>
          </div>
          <div class="receipt-row">
            <span class="receipt-row-label">Atendido por</span>
            <b class="receipt-row-val">${escapeHtml(comp.vendedor)}</b>
          </div>
          <div class="receipt-row">
            <span class="receipt-row-label">Cliente</span>
            <b class="receipt-row-val">${clienteDisplay}</b>
          </div>
          <div class="receipt-row">
            <span class="receipt-row-label">Método de pago</span>
            <b class="receipt-row-val">${escapeHtml(metodoResumen)}</b>
          </div>
          ${
            comp.ordenReferencia
              ? `<div class="receipt-row"><span class="receipt-row-label">Referencia pedido</span><b class="receipt-row-val">${escapeHtml(comp.ordenReferencia)}</b></div>`
              : ""
          }
        </div>

        <!-- 3. Detalle de productos (sin tabla azul) -->
        <div class="receipt-section">
          <div class="receipt-section-title">DETALLE DE PRODUCTOS</div>
          <div class="receipt-items-list">${itemsHtml}</div>
          <div class="receipt-subtotals">
            <div class="receipt-row">
              <span class="receipt-row-label">Subtotal</span>
              <b class="receipt-row-val num">${formatCOP(comp.subtotal)}</b>
            </div>
            ${
              comp.descuento > 0
                ? `<div class="receipt-row"><span class="receipt-row-label">Descuento</span><b class="receipt-row-val num text-expense">− ${formatCOP(comp.descuento)}</b></div>`
                : ""
            }
          </div>
        </div>

        <!-- 4. Bloque destacado TOTAL DE LA VENTA -->
        <div class="receipt-total-block">
          <div class="receipt-total-label">TOTAL DE LA VENTA</div>
          <div class="receipt-total-amount num">${formatCOP(comp.total)}</div>
        </div>

        <!-- 5. Bloque dinámico de pagos (Pago completo vs Abono inicial / Saldo pendiente) -->
        <div class="receipt-payments">
          ${pagosHtml}
        </div>

        ${devolucionesHtml}

        <!-- 6. Pie del comprobante centrado -->
        <div class="receipt-footer">
          <svg class="receipt-footer-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 2v20l3-2 3 2 2-2 2 2 3-2 3 2V2H4z"/>
            <path d="M8 7h8M8 11h8M8 15h5"/>
          </svg>
          <p class="receipt-thanks">Gracias por su compra.</p>
          <p class="receipt-legal">Documento de control interno. No constituye factura electrónica validada ante la DIAN.</p>
        </div>
      </div>
    `;
    modal.classList.add("is-open");
  }

  // -------------------------------------------------------------------------
  // 5. EVENTOS DE INTERFAZ Y FORMULARIOS
  // -------------------------------------------------------------------------
  $("#buscar-producto")?.addEventListener("input", renderCatalogo);

  $("#pos-categorias")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-categoria]");
    if (!chip) return;
    categoriaActiva = chip.dataset.categoria;
    root.querySelectorAll("#pos-categorias .chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.categoria === categoriaActiva)
    );
    renderCatalogo();
  });

  // Selección de producto en el catálogo:
  // Si la unidad de venta es m² (vidrios y espejos), abrir formulario de medidas personalizadas.
  // Si es unidad entera (u) o metro lineal (m), agregar directamente al carrito.
  $("#product-grid")?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-add-prod]");
    if (!card || card.disabled) return;
    const prodId = card.dataset.addProd;
    const prod = productos.find((p) => p.id === prodId);
    if (!prod) return;

    if (prod.unidad === "m²") {
      abrirModalMedidas(prod.id);
    } else {
      agregarProductoAlCarrito(prod.id, 1);
    }
  });

  $("#cart-items")?.addEventListener("click", (e) => {
    const inc = e.target.closest("[data-qty-inc]");
    if (inc) {
      const item = cart.find((i) => i.lineId === inc.dataset.qtyInc);
      if (item) {
        if (item.dimensiones) {
          actualizarPiezasVidrioLinea(item.lineId, item.dimensiones.piezas + 1);
        } else {
          actualizarCantidadLinea(item.lineId, roundQty(item.cantidad + 1));
        }
      }
      return;
    }
    const dec = e.target.closest("[data-qty-dec]");
    if (dec) {
      const item = cart.find((i) => i.lineId === dec.dataset.qtyDec);
      if (item) {
        if (item.dimensiones) {
          const nuevasPiezas = item.dimensiones.piezas - 1;
          if (nuevasPiezas <= 0) eliminarLineaCarrito(item.lineId);
          else actualizarPiezasVidrioLinea(item.lineId, nuevasPiezas);
        } else {
          const nueva = roundQty(item.cantidad - 1);
          if (nueva <= 0) eliminarLineaCarrito(item.lineId);
          else actualizarCantidadLinea(item.lineId, nueva);
        }
      }
      return;
    }
    const del = e.target.closest("[data-line-del]");
    if (del) {
      eliminarLineaCarrito(del.dataset.lineDel);
    }
  });

  $("#cart-items")?.addEventListener("change", (e) => {
    const qtyInput = e.target.closest("[data-qty-input]");
    if (qtyInput) {
      actualizarCantidadLinea(qtyInput.dataset.qtyInput, Number(qtyInput.value));
      return;
    }
    const priceInput = e.target.closest("[data-price-input]");
    if (priceInput) {
      const idx = cart.findIndex((i) => i.lineId === priceInput.dataset.priceInput);
      if (idx === -1 || !cart[idx].esTemporal) return;
      const nuevoPrecio = roundCOP(Number(priceInput.value));
      if (Number.isNaN(nuevoPrecio) || nuevoPrecio < 0) {
        showFeedback("El precio del concepto temporal no puede ser negativo.", "danger");
        renderCarrito();
        return;
      }
      cart[idx].precioUnitario = nuevoPrecio;
      cart[idx].precioMaterial = roundCOP(nuevoPrecio * cart[idx].cantidad);
      cart[idx].subtotal = cart[idx].precioMaterial;
      renderCarrito();
      return;
    }
    const lineDescInput = e.target.closest("[data-line-desc-input]");
    if (lineDescInput) {
      const idx = cart.findIndex((i) => i.lineId === lineDescInput.dataset.lineDescInput);
      if (idx === -1) return;
      const bruto = roundCOP((cart[idx].precioMaterial ?? cart[idx].precioUnitario * cart[idx].cantidad) + (cart[idx].costosAdicionales || 0));
      const desc = Math.max(0, Math.min(bruto, roundCOP(Number(lineDescInput.value || 0))));
      cart[idx].descuentoLinea = desc;
      cart[idx].subtotal = roundCOP(bruto - desc);
      renderCarrito();
      return;
    }
    const obsInput = e.target.closest("[data-obs-input]");
    if (obsInput) {
      const idx = cart.findIndex((i) => i.lineId === obsInput.dataset.obsInput);
      if (idx === -1 || !cart[idx].esTemporal) return;
      cart[idx].observacion = String(obsInput.value || "").trim();
      guardarBorradorPOS();
    }
  });

  $("#btn-vaciar")?.addEventListener("click", () => {
    cart = [];
    syncModalidadButtons("completo");
    renderSelectorClientes("");
    renderCarrito();
  });

  root.querySelectorAll("[data-modalidad-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      setModalidadCobro(btn.dataset.modalidadBtn);
    });
  });

  ["#cart-descuento-input", "#cart-descuento-tipo", "#modalidad-cobro", "#metodo-pago", "#recibido", "#referencia-pago", "#mixto-efectivo", "#mixto-otro-metodo", "#mixto-otro-importe", "#mixto-referencia"].forEach((sel) => {
    $(sel)?.addEventListener("input", recalcularResumenPago);
    $(sel)?.addEventListener("change", recalcularResumenPago);
  });

  // Buscador dinámico de clientes en el POS (oculto hasta pulsar "Cambiar cliente")
  $("#btn-cambiar-cliente")?.addEventListener("click", () => {
    const box = $("#box-buscar-cliente");
    if (!box) return;
    box.classList.remove("hidden");
    $("#pos-cliente-buscar")?.focus();
  });

  $("#btn-cerrar-buscar-cliente")?.addEventListener("click", () => {
    $("#box-buscar-cliente")?.classList.add("hidden");
    $("#pos-cliente-resultados")?.classList.add("hidden");
    if ($("#pos-cliente-buscar")) $("#pos-cliente-buscar").value = "";
  });

  $("#pos-cliente-buscar")?.addEventListener("input", (e) => {
    clearTimeout(clientSearchTimer);
    const val = e.target.value;
    clientSearchTimer = setTimeout(() => {
      renderResultadosBusquedaClientes(val);
    }, 150);
  });

  $("#pos-cliente-resultados")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-select-cliente]");
    if (!btn) return;
    renderSelectorClientes(btn.dataset.selectCliente);
    if ($("#pos-cliente-buscar")) $("#pos-cliente-buscar").value = "";
    $("#pos-cliente-resultados")?.classList.add("hidden");
    $("#box-buscar-cliente")?.classList.add("hidden");
  });

  $("#btn-limpiar-cliente")?.addEventListener("click", () => {
    renderSelectorClientes("");
    renderCarrito();
  });

  $("#btn-ver-historial-cliente")?.addEventListener("click", () => {
    const cliId = $("#pos-cliente")?.value || "cli-consumidor";
    abrirModalHistorialCliente(cliId);
  });

  // Filtro solo numérico (7 a 10 dígitos) en campo teléfono de nuevo cliente
  $("#cli-pos-tel")?.addEventListener("input", (e) => {
    const clean = String(e.target.value || "").replace(/\D+/g, "").slice(0, 10);
    if (e.target.value !== clean) e.target.value = clean;
  });

  // Flujo de Venta de Vidrios por Medidas Personalizadas (m²)
  function abrirModalMedidas(productoId = null) {
    hideFeedback();
    if (!cajaAbierta) {
      showFeedback("Debes abrir una caja antes de registrar ventas.", "danger");
      return;
    }

    const medSelect = $("#med-producto");
    if (medSelect && productoId) {
      medSelect.value = productoId;
    }

    const selProdId = medSelect?.value || productoId;
    const prod = productos.find((p) => p.id === selProdId);
    const precioInput = $("#med-precio-m2");
    if (precioInput && prod) {
      precioInput.value = prod.precio;
      precioInput.disabled = !hasPermission("ventas.modificar_precio", getCurrentUser());
    }

    if ($("#med-costo-adicional")) $("#med-costo-adicional").value = "0";
    if ($("#med-concepto-adicional")) $("#med-concepto-adicional").value = "";
    if ($("#med-error")) $("#med-error").classList.add("hidden");

    $("#modal-medidas")?.classList.add("is-open");
    actualizarCalculoMedidasModal();
  }

  $("#btn-medida-vidrio")?.addEventListener("click", () => {
    if (!exigirClienteAntesDeAgregar()) return;
    abrirModalMedidas();
  });

  $("#med-producto")?.addEventListener("change", () => {
    const prod = productos.find((p) => p.id === $("#med-producto")?.value);
    const precioInput = $("#med-precio-m2");
    if (precioInput && prod) {
      precioInput.value = prod.precio;
    }
    actualizarCalculoMedidasModal();
  });

  $("#med-unidad")?.addEventListener("change", () => {
    const u = $("#med-unidad")?.value || "m";
    const step = u === "m" ? "0.01" : "1";
    const min = u === "m" ? "0.05" : "5";
    const anchoEl = $("#med-ancho");
    const largoEl = $("#med-largo") || $("#med-alto");
    if (anchoEl) {
      anchoEl.step = step;
      anchoEl.min = min;
    }
    if (largoEl) {
      largoEl.step = step;
      largoEl.min = min;
    }
    actualizarCalculoMedidasModal();
  });

  function actualizarCalculoMedidasModal() {
    const errEl = $("#med-error");
    const btnConfirmar = $("#btn-confirmar-medidas");
    if (errEl) errEl.classList.add("hidden");

    const prod = productos.find((p) => p.id === $("#med-producto")?.value);
    const precioDefault = prod ? prod.precio : 0;
    const precioInput = $("#med-precio-m2");
    const rawPrecio = precioInput && precioInput.value !== "" ? Number(precioInput.value) : precioDefault;
    const largoInput = $("#med-largo") || $("#med-alto");

    try {
      const calc = calcularVidrioPersonalizado({
        ancho: $("#med-ancho")?.value,
        largo: largoInput?.value,
        unidadDimension: $("#med-unidad")?.value || "m",
        piezas: $("#med-piezas")?.value,
        precioM2: rawPrecio,
        costosAdicionales: $("#med-costo-adicional")?.value || 0,
        conceptoAdicional: $("#med-concepto-adicional")?.value || ""
      });

      if ($("#med-area-pieza")) $("#med-area-pieza").textContent = `${calc.areaPorPieza} m²`;
      if ($("#med-res-piezas")) $("#med-res-piezas").textContent = `${calc.piezas}`;
      if ($("#med-area-resultado")) $("#med-area-resultado").textContent = `${calc.areaTotal} m²`;
      if ($("#med-precio-material")) $("#med-precio-material").textContent = formatCOP(calc.precioMaterial);
      if ($("#med-res-adicional")) $("#med-res-adicional").textContent = formatCOP(calc.costosAdicionales);
      if ($("#med-precio-final")) $("#med-precio-final").textContent = formatCOP(calc.precioFinalLinea);
      if (btnConfirmar) btnConfirmar.disabled = false;
    } catch (e) {
      if ($("#med-area-pieza")) $("#med-area-pieza").textContent = "0 m²";
      if ($("#med-area-resultado")) $("#med-area-resultado").textContent = "0 m²";
      if ($("#med-precio-material")) $("#med-precio-material").textContent = "$ 0";
      if ($("#med-res-adicional")) $("#med-res-adicional").textContent = "$ 0";
      if ($("#med-precio-final")) $("#med-precio-final").textContent = "$ 0";
      if (btnConfirmar) btnConfirmar.disabled = true;
      if (errEl) {
        errEl.textContent = e.message;
        errEl.classList.remove("hidden");
      }
    }
  }

  ["#med-ancho", "#med-largo", "#med-alto", "#med-piezas", "#med-precio-m2", "#med-costo-adicional", "#med-concepto-adicional"].forEach((sel) => {
    $(sel)?.addEventListener("input", actualizarCalculoMedidasModal);
  });

  $("#form-medidas")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const errEl = $("#med-error");
    if (errEl) errEl.classList.add("hidden");
    try {
      const prodId = $("#med-producto")?.value;
      const prod = productos.find((p) => p.id === prodId);
      if (!prod) throw new Error("Selecciona un vidrio o espejo válido del inventario.");

      const precioInput = $("#med-precio-m2");
      const rawPrecio = precioInput && precioInput.value !== "" ? Number(precioInput.value) : prod.precio;
      const puedeModificarPrecio = hasPermission("ventas.modificar_precio", getCurrentUser());
      const precioAplicado = puedeModificarPrecio ? rawPrecio : prod.precio;
      const largoInput = $("#med-largo") || $("#med-alto");

      const calc = calcularVidrioPersonalizado({
        ancho: $("#med-ancho")?.value,
        largo: largoInput?.value,
        unidadDimension: $("#med-unidad")?.value || "m",
        piezas: $("#med-piezas")?.value,
        precioM2: precioAplicado,
        costosAdicionales: $("#med-costo-adicional")?.value || 0,
        conceptoAdicional: $("#med-concepto-adicional")?.value || ""
      });

      const ok = agregarProductoAlCarrito(prodId, calc.areaTotal, {
        precioUnitario: calc.precioM2,
        precioMaterial: calc.precioMaterial,
        costosAdicionales: calc.costosAdicionales,
        conceptoAdicional: calc.conceptoAdicional,
        dimensiones: {
          ancho: calc.ancho,
          largo: calc.largo,
          unidadDimension: calc.unidadDimension,
          anchoM: calc.anchoM,
          largoM: calc.largoM,
          anchoCm: roundQty(calc.anchoM * 100),
          altoCm: roundQty(calc.largoM * 100),
          piezas: calc.piezas,
          areaPorPieza: calc.areaPorPieza,
          areaTotal: calc.areaTotal
        }
      });

      if (ok) {
        $("#modal-medidas")?.classList.remove("is-open");
      } else if (errEl && feedbackEl && !feedbackEl.classList.contains("hidden")) {
        errEl.textContent = feedbackEl.textContent;
        errEl.classList.remove("hidden");
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    }
  });

  // Formulario de Apertura de Caja
  $("#form-apertura-caja")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#apertura-error");
    if (errEl) errEl.classList.add("hidden");
    try {
      const monto = parseMontoInput($("#apertura-monto")?.value);
      const obs = $("#apertura-obs")?.value || "";
      await abrirCaja({ montoInicial: monto, observaciones: obs }, getCurrentUser());
      $("#form-apertura-caja").reset();
      showFeedback("Caja abierta correctamente. Puedes iniciar el registro de ventas.", "info");
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    }
  });

  // Cobrar venta actual
  $("#btn-cobrar")?.addEventListener("click", async () => {
    if (isProcessingSale) return;
    hideFeedback();
    const errEl = $("#cart-error");
    if (errEl) errEl.classList.add("hidden");

    isProcessingSale = true;
    updateCobrarButtonState();

    try {
      const descOpts = obtenerDescuentoFormulario();
      const { total } = calcularTotalesVenta(cart, descOpts);
      const modalidad = $("#modalidad-cobro")?.value || "completo";
      const esVentaCredito = modalidad === "credito" || modalidad === "parcial";
      const pagos = obtenerPagosFormulario(total);
      const idempotencyKey = `sale-${cajaAbierta?.id || "nocaja"}-${Date.now()}`;

      const ventaConfirmada = await registrarVenta(
        {
          cajaId: cajaAbierta?.id,
          items: cart,
          pagos,
          descuento: descOpts.descuento,
          descuentoPorcentaje: descOpts.descuentoPorcentaje,
          clienteId: $("#pos-cliente")?.value || "",
          ordenReferencia: document.getElementById("pos-orden-ref")?.value || "",
          esVentaCredito,
          idempotencyKey
        },
        getCurrentUser()
      );

      // Limpiar carrito solo tras éxito de la transacción
      cart = [];
      renderSelectorClientes("");
      if ($("#recibido")) $("#recibido").value = "";
      if ($("#referencia-pago")) $("#referencia-pago").value = "";
      const ordenRefEl = document.getElementById("pos-orden-ref");
      if (ordenRefEl) ordenRefEl.value = "";
      if ($("#pago-saldo-favor")) $("#pago-saldo-favor").value = "0";
      if ($("#cart-descuento-input")) $("#cart-descuento-input").value = "0";
      syncModalidadButtons("completo");
      renderCarrito();

      showFeedback(`La venta ${ventaConfirmada.numero} se registró correctamente.`, "info");
      mostrarModalComprobante(ventaConfirmada);
    } catch (err) {
      // No limpiar el carrito si el cobro falla (Requisito 9 y Prueba 16)
      const msg = err.message || "No se pudo registrar la venta. No se han aplicado cambios.";
      if (errEl) {
        errEl.textContent = msg;
        errEl.classList.remove("hidden");
      }
      showFeedback(msg, "danger");
    } finally {
      isProcessingSale = false;
      updateCobrarButtonState();
    }
  });

  // Crear cliente rápido desde POS
  $("#form-cliente-pos")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#cli-pos-error");
    if (errEl) errEl.classList.add("hidden");
    try {
      const nuevo = await crearCliente(
        {
          nombre: $("#cli-pos-nombre")?.value,
          documento: $("#cli-pos-doc")?.value,
          telefono: $("#cli-pos-tel")?.value
        },
        getCurrentUser()
      );
      $("#form-cliente-pos").reset();
      $("#modal-cliente-pos")?.classList.remove("is-open");
      renderSelectorClientes(nuevo.id);
      showFeedback(`Cliente "${nuevo.nombre}" registrado y seleccionado.`, "info");
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    }
  });

  // Movimiento manual de efectivo en caja
  $("#form-mov-caja")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#mov-caja-error");
    if (errEl) errEl.classList.add("hidden");
    try {
      await registrarMovimientoEfectivoCaja(
        {
          cajaId: cajaAbierta?.id,
          tipo: $("#mov-caja-tipo")?.value,
          monto: parseMontoInput($("#mov-caja-monto")?.value),
          concepto: $("#mov-caja-concepto")?.value
        },
        getCurrentUser()
      );
      $("#form-mov-caja").reset();
      $("#modal-mov-caja")?.classList.remove("is-open");
      showFeedback("Movimiento de efectivo registrado en la caja actual.", "info");
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    }
  });

  // Arqueo y Cierre de Caja
  $("#btn-abrir-cierre")?.addEventListener("click", () => {
    if (cajaAbierta) {
      renderResumenModalCierre(calcularArqueoCaja(cajaAbierta, ventas));
    }
  });

  $("#efectivo-contado")?.addEventListener("input", actualizarDiferenciaCierre);

  $("#form-cierre")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#cierre-error");
    if (errEl) errEl.classList.add("hidden");
    try {
      const rawContado = $("#efectivo-contado")?.value?.trim() || "";
      if (rawContado === "") {
        throw new Error("Por favor digite el efectivo contado antes de confirmar el cierre.");
      }
      const cerrada = await cerrarCaja(
        {
          cajaId: cajaAbierta?.id,
          efectivoContado: parseMontoInput(rawContado),
          observaciones: $("#obs-cierre")?.value
        },
        getCurrentUser()
      );
      $("#form-cierre").reset();
      $("#modal-cierre")?.classList.remove("is-open");
      cart = [];
      renderCarrito();
      showFeedback(
        `Caja cerrada correctamente. Efectivo esperado: ${formatCOP(cerrada.efectivoEsperado)} · Contado: ${formatCOP(cerrada.efectivoContado)} · Diferencia: ${formatCOP(cerrada.diferencia)}.`,
        "info"
      );
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    }
  });

  // Filtros de historial de ventas
  ["#hist-buscar", "#hist-desde", "#hist-hasta", "#hist-metodo", "#hist-estado"].forEach((sel) => {
    $(sel)?.addEventListener("input", renderHistorialVentas);
    $(sel)?.addEventListener("change", renderHistorialVentas);
  });

  // Acciones en la tabla de historial (Ver comprobante / Abonar / Anular o Devolver)
  $("#tbody-historial-ventas")?.addEventListener("click", (e) => {
    const btnComp = e.target.closest("[data-ver-comprobante]");
    if (btnComp) {
      const v = ventas.find((x) => x.id === btnComp.dataset.verComprobante);
      if (v) mostrarModalComprobante(v);
      return;
    }
    const btnAbono = e.target.closest("[data-abrir-abono]");
    if (btnAbono) {
      abrirModalRegistrarAbono(btnAbono.dataset.abrirAbono);
      return;
    }
    const btnDev = e.target.closest("[data-abrir-devolucion]");
    if (btnDev) {
      abrirModalDevolucionVenta(btnDev.dataset.abrirDevolucion);
      return;
    }
    const btnAnular = e.target.closest("[data-abrir-anular]");
    if (btnAnular) {
      const v = ventas.find((x) => x.id === btnAnular.dataset.abrirAnular);
      if (!v) return;
      $("#anular-venta-id").value = v.id;
      $("#anular-venta-resumen").textContent = `${v.numero} · ${v.cliente?.nombre || ""} · ${formatCOP(v.total)}`;
      $("#anular-motivo").value = "";
      $("#anular-error")?.classList.add("hidden");
      $("#modal-anular-venta")?.classList.add("is-open");
    }
  });

  function abrirModalDevolucionVenta(ventaId) {
    const v = ventas.find((x) => x.id === ventaId);
    if (!v) return;
    const devs = getCollection(COLLECTIONS.DEVOLUCIONES).filter((d) => d.ventaId === v.id);
    const disp = calcularDisponibilidadDevolucion(v, devs);
    const saldo = calcularSaldoPendienteVenta(v);
    const pagado = Math.max(0, roundCOP(v.total) - saldo);
    const previasTotal = devs.reduce((acc, d) => acc + roundCOP(d.totalDevuelto), 0);

    if ($("#dev-venta-id")) $("#dev-venta-id").value = v.id;
    if ($("#dev-venta-numero")) $("#dev-venta-numero").textContent = `${v.numero} · ${formatDateTime(v.fecha)} (${v.estado})`;
    if ($("#dev-venta-cliente")) $("#dev-venta-cliente").textContent = `${v.cliente?.nombre || "Consumidor Final"} · Vend.: ${v.vendedor || ""}`;
    if ($("#dev-venta-totales")) $("#dev-venta-totales").textContent = `${formatCOP(v.total)} / Pagado: ${formatCOP(pagado)}`;
    if ($("#dev-venta-saldo")) $("#dev-venta-saldo").textContent = formatCOP(saldo);
    if ($("#dev-venta-previas")) $("#dev-venta-previas").textContent = `${devs.length} (${formatCOP(previasTotal)})`;
    if ($("#dev-motivo")) $("#dev-motivo").value = "";
    if ($("#dev-referencia-reembolso")) $("#dev-referencia-reembolso").value = "";
    $("#dev-error")?.classList.add("hidden");

    const tbody = $("#tbody-devolucion-lineas");
    if (tbody) {
      tbody.innerHTML = disp
        .map((l) => {
          const esTemp = Boolean(l.esTemporal || !l.productoId);
          const badge = esTemp ? ` <span class="badge-temp">SOLO ESTA VENTA</span>` : "";
          const dim = l.dimensiones
            ? `<br><small class="text-muted">${l.dimensiones.ancho}×${l.dimensiones.largo} ${escapeHtml(l.dimensiones.unidadDimension || "m")} (${l.dimensiones.piezas} pza)</small>`
            : "";
          const step = l.dimensiones || l.permiteDecimal || esTemp ? "0.01" : "1";
          return `
            <tr data-dev-line="${escapeHtml(l.lineKey)}">
              <td><b>${escapeHtml(l.nombre)}</b>${badge}${dim}</td>
              <td class="num">${l.cantidad}${l.unidad ? ` ${escapeHtml(l.unidad)}` : ""}</td>
              <td class="num">${l.devueltaPrevia}</td>
              <td class="num"><b>${l.disponible}</b></td>
              <td class="num">${formatCOP(l.precioUnitario)}</td>
              <td class="num">
                <input type="number" class="input num" min="0" max="${l.disponible}" step="${step}" value="0" data-dev-qty="${escapeHtml(l.lineKey)}" ${l.disponible <= 0 ? "disabled" : ""} style="width:80px; padding:.2rem .4rem; font-size:.8rem">
              </td>
              <td>
                ${
                  esTemp
                    ? `<span class="text-muted" style="font-size:.76rem">No aplica</span>`
                    : `<select class="select" data-dev-apto="${escapeHtml(l.lineKey)}" ${l.disponible <= 0 ? "disabled" : ""} style="padding:.2rem .4rem; font-size:.78rem">
                        <option value="si">Apto (reintegrar)</option>
                        <option value="no">Dañado (no reintegrar)</option>
                      </select>`
                }
              </td>
            </tr>
          `;
        })
        .join("");
    }
    recalcularResumenDevolucionModal();
    $("#modal-devolucion-venta")?.classList.add("is-open");
  }

  function recalcularResumenDevolucionModal() {
    const v = ventas.find((x) => x.id === $("#dev-venta-id")?.value);
    if (!v) return;
    const devs = getCollection(COLLECTIONS.DEVOLUCIONES).filter((d) => d.ventaId === v.id);
    const disp = calcularDisponibilidadDevolucion(v, devs);
    const factorDesc =
      roundCOP(v.subtotal) > 0 && roundCOP(v.descuento || 0) > 0
        ? Math.max(0, roundCOP(v.subtotal) - roundCOP(v.descuento)) / roundCOP(v.subtotal)
        : 1;

    let totalDev = 0;
    root.querySelectorAll("[data-dev-qty]").forEach((inp) => {
      const qty = roundQty(inp.value || 0);
      if (!(qty > 0)) return;
      const linea = disp.find((l) => l.lineKey === inp.dataset.devQty);
      if (!linea) return;
      const costoAdicOrig = roundCOP(linea.costosAdicionales || 0);
      const costoAdicProp = costoAdicOrig > 0 && linea.cantidad > 0 ? roundCOP((costoAdicOrig * qty) / linea.cantidad) : 0;
      const bruto = roundCOP(qty * roundCOP(linea.precioUnitario) + costoAdicProp);
      totalDev = roundCOP(totalDev + roundCOP(bruto * factorDesc));
    });

    const saldo = calcularSaldoPendienteVenta(v);
    const reduccionCartera = Math.min(saldo, totalDev);
    const excedente = roundCOP(totalDev - reduccionCartera);

    if ($("#dev-res-total")) $("#dev-res-total").textContent = formatCOP(totalDev);
    if ($("#dev-res-cartera")) $("#dev-res-cartera").textContent = formatCOP(reduccionCartera);
    if ($("#dev-res-reembolsable")) $("#dev-res-reembolsable").textContent = formatCOP(excedente);
    $("#field-dev-tipo-reembolso")?.classList.toggle("hidden", excedente <= 0);
    $("#field-dev-referencia")?.classList.toggle("hidden", excedente <= 0);
  }

  $("#tbody-devolucion-lineas")?.addEventListener("input", (e) => {
    if (e.target.closest("[data-dev-qty]")) recalcularResumenDevolucionModal();
  });

  let isProcessingDevolucion = false;
  $("#form-devolucion-venta")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isProcessingDevolucion) return;
    const errEl = $("#dev-error");
    const btn = $("#btn-confirmar-devolucion");
    if (errEl) errEl.classList.add("hidden");
    isProcessingDevolucion = true;
    if (btn) btn.disabled = true;

    try {
      const ventaId = $("#dev-venta-id")?.value;
      const itemsDevueltos = [];
      root.querySelectorAll("[data-dev-qty]").forEach((inp) => {
        const cant = roundQty(inp.value || 0);
        if (cant > 0) {
          const lineKey = inp.dataset.devQty;
          const aptoSel = root.querySelector(`[data-dev-apto="${CSS.escape(lineKey)}"]`);
          itemsDevueltos.push({
            lineKey,
            cantidad: cant,
            aptoInventario: aptoSel ? aptoSel.value === "si" : true
          });
        }
      });

      const dev = await registrarDevolucionVenta(
        {
          ventaId,
          itemsDevueltos,
          motivo: $("#dev-motivo")?.value,
          reintegrarStock: true,
          tipoReembolso: $("#dev-tipo-reembolso")?.value,
          referenciaReembolso: $("#dev-referencia-reembolso")?.value || "",
          idempotencyKey: `dev-${ventaId}-${Date.now()}`
        },
        getCurrentUser()
      );
      $("#modal-devolucion-venta")?.classList.remove("is-open");
      showFeedback(
        `Devolución registrada sobre ${dev.numeroVenta} por ${formatCOP(dev.totalDevuelto)} (${dev.tipoReembolso}).`,
        "info"
      );
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    } finally {
      isProcessingDevolucion = false;
      if (btn) btn.disabled = false;
    }
  });

  $("#form-anular-venta")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#anular-error");
    if (errEl) errEl.classList.add("hidden");
    try {
      const ventaId = $("#anular-venta-id")?.value;
      const tipoOp = $("#anular-tipo-operacion")?.value || "Anular";
      const reintegrar = ($("#anular-reintegrar")?.value || "si") === "si";
      const motivo = $("#anular-motivo")?.value;
      const ventaOrig = ventas.find((x) => x.id === ventaId);

      if (tipoOp === "Anular") {
        await anularVenta({ ventaId, motivo, reintegrarInventario: reintegrar }, getCurrentUser());
        showFeedback(`Venta ${ventaOrig?.numero || ""} anulada con registro de auditoría.`, "info");
      } else {
        await registrarDevolucionVenta(
          {
            ventaId,
            itemsDevueltos: (ventaOrig?.items || []).map((i) => ({
              productoId: i.productoId,
              cantidad: i.cantidad,
              aptoInventario: reintegrar
            })),
            motivo,
            reintegrarStock: reintegrar,
            reembolsoEfectivo: true
          },
          getCurrentUser()
        );
        showFeedback(`Devolución registrada sobre la venta ${ventaOrig?.numero || ""}.`, "info");
      }
      $("#modal-anular-venta")?.classList.remove("is-open");
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    }
  });

  $("#pago-saldo-favor")?.addEventListener("input", renderCarrito);
  $("#btn-usar-todo-saldo")?.addEventListener("click", () => {
    const cliId = $("#pos-cliente")?.value || "cli-consumidor";
    const cliObj = clientes.find((c) => c.id === cliId);
    const disp = cliId !== "cli-consumidor" && !cliObj?.esConsumidorFinal ? roundCOP(cliObj?.saldoAFavorDisponible || 0) : 0;
    const descOpts = obtenerDescuentoFormulario();
    const total = cart.length ? calcularTotalesVenta(cart, descOpts).total : 0;
    if ($("#pago-saldo-favor")) {
      $("#pago-saldo-favor").value = formatMontoInput(Math.min(disp, roundCOP(total)));
    }
    renderCarrito();
  });

  $("#btn-imprimir-comprobante")?.addEventListener("click", () => {
    window.print();
  });

  $("#btn-ver-historial-caja")?.addEventListener("click", () => {
    renderHistorialVentas();
    $("#modal-historial-caja")?.classList.add("is-open");
  });

  function abrirModalCatalogoCompleto() {
    renderCatalogoModal();
    renderResumenLateralCatalogo();
    $("#modal-catalogo-completo")?.classList.add("is-open");
    setTimeout(() => $("#buscar-catalogo-modal")?.focus(), 40);
  }

  $("#btn-ver-todo-catalogo")?.addEventListener("click", abrirModalCatalogoCompleto);
  $("#btn-ver-catalogo-inferior")?.addEventListener("click", abrirModalCatalogoCompleto);

  $("#buscar-catalogo-modal")?.addEventListener("input", renderCatalogoModal);
  $("#btn-limpiar-buscar-catalogo")?.addEventListener("click", () => {
    if ($("#buscar-catalogo-modal")) $("#buscar-catalogo-modal").value = "";
    renderCatalogoModal();
    $("#buscar-catalogo-modal")?.focus();
  });

  $("#modal-product-grid")?.addEventListener("click", (e) => {
    const btnAdd = e.target.closest("[data-add-prod]");
    if (!btnAdd || btnAdd.disabled) return;
    const prodId = btnAdd.dataset.addProd;
    const prod = productos.find((p) => p.id === prodId);
    if (!prod) return;
    if (!exigirClienteAntesDeAgregar()) {
      $("#modal-catalogo-completo")?.classList.remove("is-open");
      return;
    }
    if (prod.unidad === "m²") {
      abrirModalMedidas(prod.id);
      return;
    }
    agregarProductoAlCarrito(prod.id, 1);
  });

  $("#modal-cat-cart-list")?.addEventListener("click", (e) => {
    const dec = e.target.closest("[data-qty-dec]");
    if (dec) {
      const item = cart.find((i) => i.lineId === dec.dataset.qtyDec);
      if (!item) return;
      const actual = item.dimensiones ? item.dimensiones.piezas : item.cantidad;
      const next = roundQty(actual - 1);
      if (next <= 0) eliminarLineaCarrito(item.lineId);
      else actualizarCantidadLinea(item.lineId, next);
      return;
    }
    const inc = e.target.closest("[data-qty-inc]");
    if (inc) {
      const item = cart.find((i) => i.lineId === inc.dataset.qtyInc);
      if (!item) return;
      const actual = item.dimensiones ? item.dimensiones.piezas : item.cantidad;
      actualizarCantidadLinea(item.lineId, roundQty(actual + 1));
      return;
    }
    const del = e.target.closest("[data-line-del]");
    if (del) {
      eliminarLineaCarrito(del.dataset.lineDel);
    }
  });

  $("#btn-modal-cat-elegir-cliente")?.addEventListener("click", () => {
    $("#modal-catalogo-completo")?.classList.remove("is-open");
    $("#box-buscar-cliente")?.classList.remove("hidden");
    $("#pos-cliente-buscar")?.focus();
  });

  $("#btn-cerrar-catalogo-ir-cobro")?.addEventListener("click", () => {
    $("#modal-catalogo-completo")?.classList.remove("is-open");
  });

  $("#modal-catalogo-completo")?.addEventListener("click", (e) => {
    if (e.target.closest(".modal-close")) {
      e.preventDefault();
      $("#modal-catalogo-completo")?.classList.remove("is-open");
    }
  });

  $("#modal-historial-caja")?.addEventListener("click", (e) => {
    if (e.target.closest(".modal-close") || e.target.closest('a[href="#"]')) {
      e.preventDefault();
      $("#modal-historial-caja")?.classList.remove("is-open");
    }
  });

  $("#btn-compartir-comprobante")?.addEventListener("click", async () => {
    const texto = $("#comprobante-body")?.innerText?.trim() || "Comprobante interno de venta — Vidrios y Aluminios El Carmen";
    try {
      if (navigator.share) {
        await navigator.share({ title: "Comprobante interno de venta", text: texto });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(texto);
        showFeedback("Comprobante copiado al portapapeles para compartir.", "info");
      }
    } catch {
      // Cancelado por el usuario
    }
  });

  $("#comprobante-body")?.addEventListener("click", (e) => {
    const btnConv = e.target.closest("[data-convert-temp-nombre]");
    if (!btnConv) return;
    $("#modal-comprobante")?.classList.remove("is-open");
    $("#btn-agregar-producto-concepto")?.click();
    $("#tab-modo-permanente")?.click();
    if ($("#pos-prod-nombre")) $("#pos-prod-nombre").value = btnConv.dataset.convertTempNombre || "";
    if ($("#pos-prod-unidad")) $("#pos-prod-unidad").value = btnConv.dataset.convertTempUnidad || "";
    if ($("#pos-prod-precio")) $("#pos-prod-precio").value = btnConv.dataset.convertTempPrecio || "0";
  });

  // Eventos de Cuentas por cobrar, Historial de cliente y Abonos (Fase 3)
  $("#cartera-buscar")?.addEventListener("input", renderCarteraClientes);

  $("#tbody-cartera-clientes")?.addEventListener("click", (e) => {
    const btnDet = e.target.closest("[data-ver-cartera]");
    if (btnDet) {
      clienteCarteraDetalleId = btnDet.dataset.verCartera;
      renderDetalleCarteraCliente(clienteCarteraDetalleId);
      return;
    }
    const btnHist = e.target.closest("[data-ver-hist-cli]");
    if (btnHist) {
      abrirModalHistorialCliente(btnHist.dataset.verHistCli);
    }
  });

  $("#btn-cerrar-detalle-cartera")?.addEventListener("click", () => {
    clienteCarteraDetalleId = null;
    $("#cartera-detalle-panel")?.classList.add("hidden");
  });

  $("#tbody-cartera-detalle")?.addEventListener("click", (e) => {
    const btnComp = e.target.closest("[data-ver-comprobante]");
    if (btnComp) {
      const v = ventas.find((x) => x.id === btnComp.dataset.verComprobante);
      if (v) mostrarModalComprobante(v);
      return;
    }
    const btnAbono = e.target.closest("[data-abrir-abono]");
    if (btnAbono) {
      abrirModalRegistrarAbono(btnAbono.dataset.abrirAbono);
    }
  });

  ["#hist-cli-desde", "#hist-cli-hasta"].forEach((sel) => {
    $(sel)?.addEventListener("change", renderModalHistorialCliente);
  });
  $("#btn-hist-cli-limpiar")?.addEventListener("click", () => {
    if ($("#hist-cli-desde")) $("#hist-cli-desde").value = "";
    if ($("#hist-cli-hasta")) $("#hist-cli-hasta").value = "";
    renderModalHistorialCliente();
  });
  $("#tbody-historial-cliente")?.addEventListener("click", (e) => {
    const btnComp = e.target.closest("[data-ver-comprobante]");
    if (btnComp) {
      const v = ventas.find((x) => x.id === btnComp.dataset.verComprobante);
      if (v) mostrarModalComprobante(v);
      return;
    }
    const btnAbono = e.target.closest("[data-abrir-abono]");
    if (btnAbono) {
      abrirModalRegistrarAbono(btnAbono.dataset.abrirAbono);
    }
  });

  $("#abono-importe")?.addEventListener("input", () => {
    const v = ventas.find((x) => x.id === $("#abono-venta-id")?.value);
    if (!v) return;
    const saldo = calcularSaldoPendienteVenta(v);
    const imp = parseMontoInput($("#abono-importe")?.value);
    const restante = Math.max(0, roundCOP(saldo - imp));
    if ($("#abono-nuevo-saldo")) $("#abono-nuevo-saldo").textContent = formatCOP(restante);
  });

  let isProcessingAbono = false;
  $("#form-registrar-abono")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isProcessingAbono) return;
    const errEl = $("#abono-error");
    const btn = $("#btn-confirmar-abono");
    if (errEl) errEl.classList.add("hidden");
    isProcessingAbono = true;
    if (btn) btn.disabled = true;

    try {
      const ventaId = $("#abono-venta-id")?.value;
      const importe = parseMontoInput($("#abono-importe")?.value);
      const metodoPago = $("#abono-metodo")?.value || "Efectivo";
      const referencia = $("#abono-referencia")?.value || "";
      const res = await registrarAbonoVenta(
        {
          ventaId,
          importe,
          metodoPago,
          referencia,
          cajaId: cajaAbierta?.id || null,
          idempotencyKey: `abn-${ventaId}-${Date.now()}`
        },
        getCurrentUser()
      );
      $("#modal-registrar-abono")?.classList.remove("is-open");
      if (clienteHistorialId) renderModalHistorialCliente();
      showFeedback(
        `Abono de ${formatCOP(res.abono.importe)} (${res.abono.metodo}) registrado en ${res.venta.numero}. Saldo restante: ${formatCOP(res.venta.saldoPendiente)}.`,
        "info"
      );
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    } finally {
      isProcessingAbono = false;
      if (btn) btn.disabled = false;
    }
  });

  // Modal unificado: Agregar producto permanente o concepto temporal
  function setModoProductoConcepto(modo) {
    const esPermanente = modo === "permanente";
    root.querySelectorAll("[data-modo-item]").forEach((btn) => {
      const activo = btn.dataset.modoItem === modo;
      btn.classList.toggle("btn-primary", activo);
      btn.classList.toggle("btn-ghost", !activo);
    });
    $("#form-item-temporal")?.classList.toggle("hidden", esPermanente);
    $("#form-item-permanente")?.classList.toggle("hidden", !esPermanente);
  }

  function syncPosProdDecimalField() {
    const u = $("#pos-prod-unidad")?.value || "";
    const field = $("#field-pos-prod-decimal");
    const chk = $("#pos-prod-decimal");
    if (u === "m" || u === "m²") {
      if (chk) chk.checked = true;
      field?.classList.add("hidden");
    } else {
      field?.classList.remove("hidden");
    }
  }

  $("#btn-agregar-producto-concepto")?.addEventListener("click", () => {
    if (!exigirClienteAntesDeAgregar()) return;
    $("#form-item-temporal")?.reset();
    $("#form-item-permanente")?.reset();
    $("#temp-error")?.classList.add("hidden");
    $("#pos-prod-error")?.classList.add("hidden");
    if ($("#temp-cantidad")) $("#temp-cantidad").value = "1";
    if ($("#pos-prod-agregar-carrito")) $("#pos-prod-agregar-carrito").checked = true;
    syncPosProdDecimalField();
    setModoProductoConcepto("temporal");
    $("#modal-producto-concepto")?.classList.add("is-open");
  });

  root.querySelectorAll("[data-modo-item]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("#temp-error")?.classList.add("hidden");
      $("#pos-prod-error")?.classList.add("hidden");
      setModoProductoConcepto(btn.dataset.modoItem);
    });
  });

  $("#pos-prod-unidad")?.addEventListener("change", syncPosProdDecimalField);

  $("#form-item-temporal")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const errEl = $("#temp-error");
    if (errEl) errEl.classList.add("hidden");
    try {
      const nombre = String($("#temp-nombre")?.value || "").trim();
      const cantidad = Number($("#temp-cantidad")?.value);
      const precioUnitario = parseMontoInput($("#temp-precio")?.value);
      const unidad = String($("#temp-unidad")?.value || "").trim();
      const observacion = String($("#temp-observacion")?.value || "").trim();

      if (!nombre) throw new Error("Ingresa el nombre o descripción del concepto.");
      if (!(cantidad > 0)) throw new Error("La cantidad debe ser mayor a cero.");
      if (Number.isNaN(precioUnitario) || precioUnitario < 0) {
        throw new Error("El precio unitario debe ser mayor o igual a cero.");
      }

      agregarConceptoTemporalAlCarrito({
        nombre,
        cantidad,
        precioUnitario,
        unidad,
        observacion
      });
      $("#modal-producto-concepto")?.classList.remove("is-open");
      showFeedback(`Concepto temporal "${nombre}" agregado solo a esta venta.`, "info");
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    }
  });

  $("#form-item-permanente")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#pos-prod-error");
    if (errEl) errEl.classList.add("hidden");
    const btn = $("#btn-confirmar-pos-prod");
    if (btn) btn.disabled = true;
    try {
      const unidad = $("#pos-prod-unidad")?.value ?? "";
      const permiteDecimal =
        unidad === "m" || unidad === "m²" ? true : Boolean($("#pos-prod-decimal")?.checked);
      const stockVal = $("#pos-prod-stock")?.value;
      const stock = stockVal === "" || stockVal === undefined ? 0 : Number(stockVal);
      const compraVal = $("#pos-prod-compra")?.value;
      const precioCompra = compraVal === "" || compraVal === undefined ? 0 : parseMontoInput(compraVal);

      const creado = await crearProducto(
        {
          nombre: $("#pos-prod-nombre")?.value,
          categoria: $("#pos-prod-categoria")?.value,
          codigo: $("#pos-prod-codigo")?.value,
          unidad,
          permiteDecimal,
          precioCompra,
          precio: parseMontoInput($("#pos-prod-precio")?.value),
          stock,
          stockMinimo: 0,
          descripcion: $("#pos-prod-descripcion")?.value
        },
        getCurrentUser()
      );

      const agregarAlCarrito = Boolean($("#pos-prod-agregar-carrito")?.checked);
      $("#modal-producto-concepto")?.classList.remove("is-open");

      if (agregarAlCarrito) {
        if (roundQty(creado.stock) > 0) {
          cart.push({
            lineId: generarLineId(),
            esTemporal: false,
            productoId: creado.id,
            codigo: creado.codigo,
            nombre: creado.nombre,
            unidad: creado.unidad,
            permiteDecimal: creado.permiteDecimal,
            cantidad: 1,
            precioUnitario: roundCOP(creado.precio),
            precioMaterial: roundCOP(creado.precio),
            costosAdicionales: 0,
            subtotal: roundCOP(creado.precio)
          });
          renderCarrito();
          showFeedback(`Producto permanente "${creado.nombre}" creado y agregado al carrito.`, "success");
        } else {
          showFeedback(
            `Producto "${creado.nombre}" creado en el catálogo con stock 0. Registra existencias en Inventario antes de venderlo.`,
            "info"
          );
        }
      } else {
        showFeedback(`Producto permanente "${creado.nombre}" creado en el catálogo.`, "success");
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // -------------------------------------------------------------------------
  // 6. SUSCRIPCIONES EN TIEMPO REAL
  // -------------------------------------------------------------------------
  const unsubProd = watchProductos((lista) => {
    productos = lista;
    renderCatalogo();
    renderCarrito();
  });

  const unsubCli = watchClientes((lista) => {
    clientes = lista;
    renderSelectorClientes();
    renderCarteraClientes();
  });

  const unsubCajas = watchCajas(({ cajaAbierta: abierta }) => {
    cajaAbierta = abierta;
    renderEstadoCaja();
  });

  const unsubVentas = watchVentas((lista) => {
    ventas = lista;
    renderEstadoCaja();
    renderHistorialVentas();
    renderSelectorClientes();
    renderCarteraClientes();
    if (clienteHistorialId) renderModalHistorialCliente();
  });

  const unsubBilletera = watchMovimientosBilletera((lista) => {
    movimientosBilletera = lista;
    renderSelectorClientes();
    if (clienteHistorialId) renderModalHistorialCliente();
  });

  restaurarBorradorPOS();

  const onPosKeyDown = (e) => {
    if (e.key === "F2") {
      e.preventDefault();
      $("#buscar-producto")?.focus();
    } else if (e.key === "F4") {
      e.preventDefault();
      $("#btn-agregar-producto-concepto")?.click();
    } else if (e.key === "F9") {
      const btn = $("#btn-cobrar");
      if (btn && !btn.disabled) {
        e.preventDefault();
        btn.click();
      }
    }
  };
  document.addEventListener("keydown", onPosKeyDown);

  return () => {
    document.removeEventListener("keydown", onPosKeyDown);
    unsubProd();
    unsubCli();
    unsubCajas();
    unsubVentas();
    unsubBilletera();
  };
}

