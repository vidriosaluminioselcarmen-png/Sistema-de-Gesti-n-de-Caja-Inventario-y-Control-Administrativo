// Controladores reactivos para Dashboard, Inventario, Contabilidad, Reportes y Usuarios.
// Cumple las Secciones 3, 5, 7, 8, 9, 10, 13 y 14:
// - Ningún indicador ni tabla utiliza cifras de demostración estáticas.
// - Cuando no existen registros, muestra estados vacíos reales ("No hay ventas registradas", etc.).
// - Sincroniza todas las vistas con las colecciones transaccionales en tiempo real.

import { getCurrentUser, hasPermission, canAccessRoute } from "../auth.js";
import { getFirebaseStatus } from "../firebase-config.js";
import {
  watchProductos,
  watchMovimientosInventario,
  getEstadoStock,
  obtenerAlertasInventario,
  formatCOP,
  roundCOP,
  crearProducto,
  actualizarProducto,
  cambiarEstadoProducto,
  registrarMovimientoBodega,
  inferirModalidadProducto,
  etiquetaModalidad,
  calcularAreaLaminas,
  calcularResumenInventario
} from "../services/inventario-service.js";
import {
  watchMovimientosContables,
  calcularResumenContable,
  filtrarMovimientosContables,
  generarInformeFinancieroContable,
  obtenerRangoPeriodo,
  registrarMovimientoContable,
  registrarTrasladoInterno,
  revertirMovimientoContable,
  pagarCuentaPorPagar,
  normalizarCuentaContable,
  exportarContabilidadCSV,
  TIPOS_CONTABLE
} from "../services/contabilidad-service.js";
import {
  watchCajas,
  watchVentas,
  registrarAbonoVenta
} from "../services/caja-service.js";
import { calcularSaldoPendienteVenta, listarCarteraClientes } from "../services/clientes-service.js";
import {
  generarReportesConsolidados,
  generarCSVReporte
} from "../services/reportes-service.js";
import {
  watchUsuarios,
  watchAuditoria,
  crearUsuario,
  actualizarUsuario
} from "../services/usuarios-service.js";

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

function formatShortDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("es-CO");
  } catch {
    return iso;
  }
}

function formatShortTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
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

function bindMoneyInputs(root) {
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
}

function confirmarAccionModal({
  titulo = "Confirmar acción",
  pregunta = "¿Desea continuar?",
  detallesHtml = "",
  textoConfirmar = "Confirmar",
  claseBoton = "btn-primary"
} = {}) {
  return new Promise((resolve) => {
    let modal = document.getElementById("modal-confirmacion-global");
    if (!modal) {
      modal = document.createElement("div");
      modal.className = "modal-overlay";
      modal.id = "modal-confirmacion-global";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "mcg-titulo");
      modal.style.zIndex = "1200";
      modal.innerHTML = `
        <div class="modal" style="max-width:480px">
          <div class="modal-header">
            <h3 id="mcg-titulo">Confirmar</h3>
            <button type="button" class="modal-close" data-mcg-cancel aria-label="Cerrar">&times;</button>
          </div>
          <div class="modal-body">
            <p id="mcg-pregunta" style="font-size:1.08rem;font-weight:700;margin:0 0 .75rem"></p>
            <div id="mcg-detalles" style="background:var(--bg-subtle);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:.85rem 1rem;display:grid;gap:.35rem"></div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline" data-mcg-cancel style="min-height:46px">Cancelar</button>
            <button type="button" class="btn btn-primary" id="mcg-confirmar" style="min-height:46px">Confirmar</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    const tituloEl = modal.querySelector("#mcg-titulo");
    const pregEl = modal.querySelector("#mcg-pregunta");
    const detEl = modal.querySelector("#mcg-detalles");
    const btnOk = modal.querySelector("#mcg-confirmar");

    if (tituloEl) tituloEl.textContent = titulo;
    if (pregEl) pregEl.textContent = pregunta;
    if (detEl) {
      detEl.innerHTML = detallesHtml || "";
      detEl.style.display = detallesHtml ? "grid" : "none";
    }
    if (btnOk) {
      btnOk.textContent = textoConfirmar;
      btnOk.className = `btn ${claseBoton}`;
    }

    let settled = false;
    const cerrar = (resultado) => {
      if (settled) return;
      settled = true;
      modal.classList.remove("is-open");
      modal.removeEventListener("click", onClickModal);
      document.removeEventListener("keydown", onKeyDown);
      resolve(resultado);
    };

    const onClickModal = (e) => {
      if (e.target.closest("[data-mcg-cancel]")) {
        cerrar(false);
        return;
      }
      if (e.target.closest("#mcg-confirmar")) {
        cerrar(true);
      }
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") cerrar(false);
    };

    modal.addEventListener("click", onClickModal);
    document.addEventListener("keydown", onKeyDown);
    modal.classList.add("is-open");
    btnOk?.focus();
  });
}

// ---------------------------------------------------------------------------
// 1. VISTA DE INVENTARIO (Sección 7)
// ---------------------------------------------------------------------------
export function mountInventarioView(root) {
  const $ = (sel) => root.querySelector(sel);
  let productos = [];
  let kardex = [];
  // Filtro por estado activado desde las tarjetas del panel ("todos" = sin filtro)
  let estadoFiltroKpi = "todos";
  let modalEstadoFiltro = "todos";
  let kardexQuickFilter = "Todos";
  let kardexUltimosFiltrados = [];

  bindMoneyInputs(root);

  const ETIQUETAS_ESTADO = {
    disponible: "Disponibles",
    bajo: "Stock bajo",
    agotado: "Agotados",
    inactivo: "Inactivos"
  };

  // Presentación del estado en Inventario: inactivo en gris (no altera getEstadoStock usado por Caja)
  function presentarEstado(p) {
    const est = getEstadoStock(p);
    if (est.codigo === "inactivo") {
      return { ...est, claseBadge: "stock-inactive", claseFila: "row-inactive" };
    }
    return est;
  }

  const feedbackEl = $("#inv-feedback");
  function showFeedback(msg, isError = false) {
    if (!feedbackEl) return;
    feedbackEl.textContent = msg;
    feedbackEl.className = `alert ${isError ? "alert-danger" : "alert-info"}`;
    feedbackEl.classList.remove("hidden");
  }

  function renderFilaProductoHTML(p, puedeGestionar) {
    const est = presentarEstado(p);
    const esActivo = p.activo !== false;
    const mod = inferirModalidadProducto(p);
    return `
      <tr class="${est.claseFila}" data-detalle-prod="${escapeHtml(p.id)}" title="Haga clic para ver el detalle">
        <td><b>${escapeHtml(p.codigo)}</b></td>
        <td>
          ${escapeHtml(p.nombre)}
          ${p.descripcion ? `<br><small class="text-muted">${escapeHtml(p.descripcion)}</small>` : ""}
        </td>
        <td>${escapeHtml(p.categoria)}</td>
        <td>${escapeHtml(etiquetaModalidad(mod))}${p.unidad ? ` · <b>${escapeHtml(p.unidad)}</b>` : ""}</td>
        <td class="num">${formatCOP(p.precioCompra || 0)}</td>
        <td class="num"><b>${formatCOP(p.precio)}</b>${p.unidad ? ` / ${escapeHtml(p.unidad)}` : ""}</td>
        <td class="num"><b>${p.stock}${p.unidad ? ` ${escapeHtml(p.unidad)}` : ""}</b></td>
        <td class="num">${p.stockMinimo}${p.unidad ? ` ${escapeHtml(p.unidad)}` : ""}</td>
        <td><span class="badge ${est.claseBadge}">${est.etiqueta}</span></td>
        <td class="text-right" style="white-space:nowrap">
          <button type="button" class="btn btn-outline btn-xs" data-kardex-prod="${escapeHtml(p.id)}">Kardex</button>
          ${
            puedeGestionar
              ? `
                <button type="button" class="btn btn-outline btn-xs" data-edit-prod="${escapeHtml(p.id)}">Editar</button>
                <button type="button" class="btn btn-outline btn-xs" data-toggle-prod="${escapeHtml(p.id)}">${esActivo ? "Desactivar" : "Activar"}</button>
              `
              : ""
          }
        </td>
      </tr>
    `;
  }

  function renderTablaInventario() {
    const tbody = root.querySelector("#tabla-productos tbody");
    if (!tbody) return;
    const q = ($("#buscar-inventario")?.value || "").trim().toLowerCase();
    const catFiltro = $("#inv-filtro-categoria")?.value || "Todos";
    const modFiltro = $("#inv-filtro-modalidad")?.value || "Todas";
    const soloBajo = Boolean($("#solo-bajo")?.checked);
    const mostrarInactivos = Boolean($("#mostrar-inactivos")?.checked) || estadoFiltroKpi === "inactivo";
    const puedeGestionar = hasPermission("inventario.gestionar", getCurrentUser());

    if ($("#inv-ver-todo-count")) $("#inv-ver-todo-count").textContent = String(productos.length);

    const filtrados = productos.filter((p) => {
      if (!mostrarInactivos && p.activo === false) return false;
      if (catFiltro !== "Todos" && p.categoria !== catFiltro) return false;
      const mod = inferirModalidadProducto(p);
      if (modFiltro !== "Todas" && mod !== modFiltro) return false;
      const matchQ =
        !q ||
        String(p.nombre || "").toLowerCase().includes(q) ||
        String(p.codigo || "").toLowerCase().includes(q) ||
        String(p.descripcion || "").toLowerCase().includes(q) ||
        String(p.categoria || "").toLowerCase().includes(q);
      const est = getEstadoStock(p);
      const matchBajo = !soloBajo || est.codigo === "agotado" || est.codigo === "bajo";
      const matchKpi = estadoFiltroKpi === "todos" || est.codigo === estadoFiltroKpi;
      return matchQ && matchBajo && matchKpi;
    });

    const visibles = !q && filtrados.length > 12 ? filtrados.slice(0, 12) : filtrados;
    const footerEl = $("#inv-tabla-footer");
    if (footerEl) {
      footerEl.classList.toggle("hidden", Boolean(q) || filtrados.length <= 12);
      if ($("#inv-tabla-footer-texto")) {
        $("#inv-tabla-footer-texto").textContent = `Mostrando ${visibles.length} de ${filtrados.length} productos`;
      }
      if ($("#inv-inferior-count")) $("#inv-inferior-count").textContent = String(filtrados.length);
    }

    tbody.innerHTML = visibles.length
      ? visibles.map((p) => renderFilaProductoHTML(p, puedeGestionar)).join("")
      : `<tr><td colspan="10" style="text-align:center; padding:1.5rem" class="text-muted">No hay productos disponibles.</td></tr>`;

    // Poblar selects de entrada y salida solo con productos activos
    const activos = productos.filter((p) => p.activo !== false);
    const opts = activos.length
      ? activos
          .map(
            (p) =>
              `<option value="${escapeHtml(p.id)}">${escapeHtml(p.nombre)} (${escapeHtml(p.codigo)} · Disp: ${p.stock}${p.unidad ? ` ${escapeHtml(p.unidad)}` : ""})</option>`
          )
          .join("")
      : `<option value="">No hay productos disponibles</option>`;
    if ($("#ent-producto")) $("#ent-producto").innerHTML = opts;
    if ($("#sal-producto")) $("#sal-producto").innerHTML = opts;
    syncDimensionesMovimiento("ent");
    syncDimensionesMovimiento("sal");
  }

  // -------------------------------------------------------------------------
  // Panel de indicadores y gráficos del inventario (SVG propio, datos reales)
  // -------------------------------------------------------------------------
  const COLOR_ESTADO = {
    disponible: { clase: "inv-c-ok", stroke: "var(--success)" },
    bajo: { clase: "inv-c-low", stroke: "var(--warning)" },
    agotado: { clase: "inv-c-out", stroke: "var(--danger)" },
    inactivo: { clase: "inv-c-inactive", stroke: "var(--border-strong)" }
  };
  const COLORES_SERIES = ["var(--accent)", "var(--success)", "var(--warning)", "var(--danger)", "var(--text-secondary)"];

  function diaCorto(dia) {
    const [y, m, d] = String(dia).split("-");
    return d && m ? `${d}/${m}` : String(dia || "");
  }

  function vacioHtml(msg) {
    return `<div class="inv-chart-empty">${escapeHtml(msg)}</div>`;
  }

  function leerFiltrosDashboard() {
    return {
      desde: $("#inv-dash-desde")?.value || "",
      hasta: $("#inv-dash-hasta")?.value || "",
      categoria: $("#inv-dash-categoria")?.value || "Todos"
    };
  }

  function renderGraficoDistribucion(resumen) {
    const cont = $("#inv-chart-distribucion");
    if (!cont) return;
    const datos = resumen.distribucionEstados.filter((d) => d.valor > 0);
    const total = datos.reduce((s, d) => s + d.valor, 0);
    if (!total) {
      cont.innerHTML = vacioHtml("Todavía no hay productos registrados para mostrar.");
      return;
    }
    const r = 60;
    const circ = 2 * Math.PI * r;
    let offset = 0;
    const arcos = datos
      .map((d) => {
        const largo = (d.valor / total) * circ;
        const arco = `<circle cx="90" cy="90" r="${r}" fill="none" stroke="${COLOR_ESTADO[d.codigo].stroke}" stroke-width="28"
          stroke-dasharray="${largo} ${circ - largo}" stroke-dashoffset="${-offset}" transform="rotate(-90 90 90)"
          data-inv-click="estado" data-valor="${d.codigo}" role="button" tabindex="0"
          aria-label="${escapeHtml(d.etiqueta)}: ${d.valor} productos"><title>${escapeHtml(d.etiqueta)}: ${d.valor}</title></circle>`;
        offset += largo;
        return arco;
      })
      .join("");
    const leyenda = resumen.distribucionEstados
      .map((d) => {
        const pct = total ? Math.round((d.valor / total) * 100) : 0;
        return `<li><button type="button" data-inv-click="estado" data-valor="${d.codigo}">
          <span class="inv-swatch ${COLOR_ESTADO[d.codigo].clase}"></span>${escapeHtml(d.etiqueta)}: <b class="num">${d.valor}</b> (${pct} %)
        </button></li>`;
      })
      .join("");
    cont.innerHTML = `
      <div style="display:flex; flex-wrap:wrap; align-items:center; gap:1rem">
        <svg class="inv-chart-svg" viewBox="0 0 180 180" style="max-width:190px" role="img" aria-label="Distribución del inventario por estado">
          ${arcos}
          <text x="90" y="86" text-anchor="middle" style="font-size:24px; font-weight:800; fill:var(--text-primary)">${total}</text>
          <text x="90" y="106" text-anchor="middle">productos</text>
        </svg>
        <ul class="inv-legend" style="flex-direction:column; flex:1; min-width:180px">${leyenda}</ul>
      </div>`;
  }

  function renderGraficoEntradasSalidas(resumen) {
    const cont = $("#inv-chart-entradas-salidas");
    if (!cont) return;
    const datos = resumen.entradasSalidasPorDia.slice(-14);
    if (!datos.length) {
      cont.innerHTML = vacioHtml("No hay entradas ni salidas registradas en el período seleccionado.");
      return;
    }
    const W = 520, H = 220, padL = 34, padB = 30, padT = 10;
    const maxV = Math.max(1, ...datos.map((d) => Math.max(d.entradas, d.salidas)));
    const altoUtil = H - padB - padT;
    const anchoGrupo = (W - padL) / datos.length;
    const barW = Math.min(22, anchoGrupo / 2.6);
    const lineas = [0, 0.5, 1]
      .map((f) => {
        const y = padT + altoUtil * (1 - f);
        return `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y}" y2="${y}"/><text x="${padL - 6}" y="${y + 4}" text-anchor="end">${Math.round(maxV * f)}</text>`;
      })
      .join("");
    const barras = datos
      .map((d, i) => {
        const cx = padL + anchoGrupo * i + anchoGrupo / 2;
        const hE = (d.entradas / maxV) * altoUtil;
        const hS = (d.salidas / maxV) * altoUtil;
        return `
          <rect class="inv-c-in" x="${cx - barW - 1}" y="${padT + altoUtil - hE}" width="${barW}" height="${hE}" rx="3"
            data-inv-click="dia" data-valor="${d.dia}"><title>${diaCorto(d.dia)} · Entradas: ${d.entradas}</title></rect>
          <rect class="inv-c-outmov" x="${cx + 1}" y="${padT + altoUtil - hS}" width="${barW}" height="${hS}" rx="3"
            data-inv-click="dia" data-valor="${d.dia}"><title>${diaCorto(d.dia)} · Salidas: ${d.salidas}</title></rect>
          <text x="${cx}" y="${H - 10}" text-anchor="middle">${diaCorto(d.dia)}</text>`;
      })
      .join("");
    cont.innerHTML = `
      <svg class="inv-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Entradas y salidas por día">
        ${lineas}<line class="axis" x1="${padL}" x2="${W}" y1="${padT + altoUtil}" y2="${padT + altoUtil}"/>${barras}
      </svg>
      <ul class="inv-legend">
        <li><span class="inv-swatch inv-c-in"></span>Entradas: <b class="num">${resumen.totalEntradas}</b></li>
        <li><span class="inv-swatch inv-c-outmov"></span>Salidas: <b class="num">${resumen.totalSalidas}</b></li>
        <li class="help">N° de movimientos por día. Haga clic en una barra para ver ese día en el historial.</li>
      </ul>`;
  }

  function renderGraficoEvolucion(resumen) {
    const cont = $("#inv-chart-evolucion");
    if (!cont) return;
    const series = resumen.evolucionExistencias.filter((s) => s.puntos.length > 0);
    if (!series.length) {
      cont.innerHTML = vacioHtml("No hay movimientos en el período seleccionado para mostrar la evolución.");
      return;
    }
    const dias = [...new Set(series.flatMap((s) => s.puntos.map((p) => p.dia)))].sort();
    const W = 520, H = 220, padL = 44, padB = 30, padT = 12;
    const altoUtil = H - padB - padT;
    const maxV = Math.max(1, ...series.flatMap((s) => s.puntos.map((p) => p.existencias)));
    const xDe = (dia) => (dias.length === 1 ? padL + (W - padL) / 2 : padL + ((W - padL - 10) * dias.indexOf(dia)) / (dias.length - 1));
    const yDe = (v) => padT + altoUtil * (1 - v / maxV);
    const paso = Math.max(1, Math.ceil(dias.length / 7));
    const etiquetasX = dias
      .map((d, i) => (i % paso === 0 || i === dias.length - 1 ? `<text x="${xDe(d)}" y="${H - 10}" text-anchor="middle">${diaCorto(d)}</text>` : ""))
      .join("");
    const lineasGuia = [0, 0.5, 1]
      .map((f) => `<line class="grid-line" x1="${padL}" x2="${W}" y1="${yDe(maxV * f)}" y2="${yDe(maxV * f)}"/><text x="${padL - 6}" y="${yDe(maxV * f) + 4}" text-anchor="end">${roundCOP(maxV * f)}</text>`)
      .join("");
    const trazos = series
      .map((s, idx) => {
        const color = COLORES_SERIES[idx % COLORES_SERIES.length];
        const pts = s.puntos.map((p) => `${xDe(p.dia)},${yDe(p.existencias)}`).join(" ");
        const marcas = s.puntos
          .map((p) => `<circle cx="${xDe(p.dia)}" cy="${yDe(p.existencias)}" r="4" fill="${color}"><title>${diaCorto(p.dia)} · ${p.existencias} ${escapeHtml(s.unidad)}</title></circle>`)
          .join("");
        return `<polyline fill="none" stroke="${color}" stroke-width="2.5" points="${pts}"/>${marcas}`;
      })
      .join("");
    const leyenda = series
      .map((s, idx) => {
        const ultimo = s.puntos[s.puntos.length - 1];
        return `<li><span class="inv-swatch" style="background:${COLORES_SERIES[idx % COLORES_SERIES.length]}"></span>Total en ${escapeHtml(s.unidad)}: <b class="num">${ultimo.existencias}</b></li>`;
      })
      .join("");
    cont.innerHTML = `
      <svg class="inv-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución de existencias por unidad de medida">
        ${lineasGuia}<line class="axis" x1="${padL}" x2="${W}" y1="${padT + altoUtil}" y2="${padT + altoUtil}"/>${trazos}${etiquetasX}
      </svg>
      <ul class="inv-legend">${leyenda}<li class="help">Cada unidad de medida se muestra por separado.</li></ul>`;
  }

  function renderGraficoCategorias(resumen, categoriaSel) {
    const cont = $("#inv-chart-categorias");
    if (!cont) return;
    if (!resumen.porCategoria.length) {
      cont.innerHTML = vacioHtml("Todavía no hay productos activos por categoría.");
      return;
    }
    const maxP = Math.max(1, ...resumen.porCategoria.map((c) => c.productos));
    cont.innerHTML = `
      <div class="inv-cat-list">
        ${resumen.porCategoria
          .map((c) => {
            const pct = (n) => (n / maxP) * 100;
            return `
              <button type="button" class="inv-cat-row ${categoriaSel === c.categoria ? "is-active" : ""}" data-inv-click="categoria" data-valor="${escapeHtml(c.categoria)}">
                <span class="inv-cat-head"><span>${escapeHtml(c.categoria)}</span><span class="num">${c.productos} productos</span></span>
                <span class="inv-cat-track" aria-hidden="true">
                  <span class="inv-c-ok" style="width:${pct(c.disponibles)}%"></span>
                  <span class="inv-c-low" style="width:${pct(c.stockBajo)}%"></span>
                  <span class="inv-c-out" style="width:${pct(c.agotados)}%"></span>
                </span>
                <span class="help">Disponibles: ${c.disponibles} · Stock bajo: ${c.stockBajo} · Agotados: ${c.agotados}</span>
              </button>`;
          })
          .join("")}
      </div>
      <ul class="inv-legend">
        <li><span class="inv-swatch inv-c-ok"></span>Disponible</li>
        <li><span class="inv-swatch inv-c-low"></span>Stock bajo</li>
        <li><span class="inv-swatch inv-c-out"></span>Agotado</li>
      </ul>`;
  }

  function actualizarIndicadorFiltroEstado() {
    const box = $("#inv-filtro-estado-activo");
    const txt = $("#inv-filtro-estado-texto");
    root.querySelectorAll("[data-inv-kpi]").forEach((b) => {
      const activo = b.dataset.invKpi === estadoFiltroKpi;
      b.classList.toggle("active", activo);
      b.classList.toggle("btn-primary", activo);
      b.classList.toggle("btn-outline", !activo);
      b.setAttribute("aria-pressed", activo ? "true" : "false");
      b.textContent = activo ? "Viendo ✓" : "Ver";
      b.closest(".inv-kpi")?.classList.toggle("is-active", activo);
    });
    if (!box) return;
    if (estadoFiltroKpi === "todos") {
      box.classList.add("hidden");
      return;
    }
    if (txt) txt.textContent = `Mostrando solo productos en estado: ${ETIQUETAS_ESTADO[estadoFiltroKpi] || estadoFiltroKpi}.`;
    box.classList.remove("hidden");
  }

  function renderDashboardInventario() {
    const filtros = leerFiltrosDashboard();
    const resumen = calcularResumenInventario(productos, kardex, filtros);
    const setTxt = (sel, v) => {
      const el = $(sel);
      if (el) el.textContent = String(v);
    };
    setTxt("#inv-kpi-total", resumen.conteo.total);
    setTxt("#inv-kpi-disponibles", resumen.conteo.disponibles);
    setTxt("#inv-kpi-bajo", resumen.conteo.stockBajo);
    setTxt("#inv-kpi-agotados", resumen.conteo.agotados);
    renderGraficoDistribucion(resumen);
    renderGraficoEntradasSalidas(resumen);
    renderGraficoEvolucion(resumen);
    renderGraficoCategorias(resumen, filtros.categoria);
  }

  function irATablaProductos() {
    $("#tabla-productos")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function aplicarFiltroEstado(codigo) {
    estadoFiltroKpi = codigo || "todos";
    if (estadoFiltroKpi !== "todos" && $("#solo-bajo")) $("#solo-bajo").checked = false;
    actualizarIndicadorFiltroEstado();
    renderTablaInventario();
    irATablaProductos();
  }

  function abrirDetalleProducto(prodId) {
    const prod = productos.find((p) => p.id === prodId);
    const body = $("#detalle-producto-inv-body");
    if (!prod || !body) return;
    const est = presentarEstado(prod);
    const unidad = prod.unidad ? ` ${escapeHtml(prod.unidad)}` : "";
    const movs = kardex.filter((m) => m.productoId === prod.id).slice(0, 10);
    const titulo = $("#titulo-detalle-inv");
    if (titulo) titulo.textContent = `${prod.nombre} · ${prod.codigo}`;
    body.innerHTML = `
      <div class="inv-detalle-grid">
        <div><span>Estado</span><b><span class="badge ${est.claseBadge}">${escapeHtml(est.etiqueta)}</span></b></div>
        <div><span>Categoría</span><b>${escapeHtml(prod.categoria || "—")}</b></div>
        <div><span>Modalidad</span><b>${escapeHtml(etiquetaModalidad(inferirModalidadProducto(prod)))}</b></div>
        <div><span>Existencia actual</span><b class="num">${prod.stock}${unidad}</b></div>
        <div><span>Stock mínimo</span><b class="num">${prod.stockMinimo}${unidad}</b></div>
        <div><span>Precio de venta</span><b class="num">${formatCOP(prod.precio)}</b></div>
        <div><span>Precio de compra</span><b class="num">${formatCOP(prod.precioCompra || 0)}</b></div>
        <div><span>Descripción</span><b>${escapeHtml(prod.descripcion || "—")}</b></div>
      </div>
      <h4 style="margin:.5rem 0">Últimos movimientos</h4>
      ${
        movs.length
          ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Fecha</th><th>Tipo</th><th class="num">Cantidad</th><th class="num">Stock nuevo</th><th>Motivo</th></tr></thead>
              <tbody>${movs
                .map(
                  (m) => `<tr>
                    <td>${formatDateTime(m.fecha)}</td>
                    <td><span class="badge ${m.tipo === "Entrada" ? "badge-success" : "badge-warning"}">${escapeHtml(m.tipo)}</span></td>
                    <td class="num">${m.tipo === "Entrada" ? "+" : "−"} ${m.cantidad}${unidad}</td>
                    <td class="num">${m.stockNuevo ?? "—"}</td>
                    <td>${escapeHtml(m.motivo || m.origen || "—")}</td>
                  </tr>`
                )
                .join("")}</tbody></table></div>`
          : `<p class="text-muted">Este producto todavía no tiene movimientos registrados.</p>`
      }`;
    $("#modal-detalle-producto-inv")?.classList.add("is-open");
  }

  function syncDimensionesMovimiento(prefijo) {
    const prodId = $(`#${prefijo}-producto`)?.value;
    const prod = productos.find((p) => p.id === prodId);
    const esM2 = prod && inferirModalidadProducto(prod) === "m2";
    $(`#${prefijo}-calc-dim-box`)?.classList.toggle("hidden", !esM2);
  }

  function recalcularAreaMovimiento(prefijo) {
    const laminas = Number($(`#${prefijo}-laminas`)?.value || 0);
    const ancho = Number($(`#${prefijo}-ancho`)?.value || 0);
    const alto = Number($(`#${prefijo}-alto`)?.value || 0);
    const prevEl = $(`#${prefijo}-area-preview`);
    if (ancho > 0 && alto > 0 && laminas > 0) {
      const area = calcularAreaLaminas({ ancho, alto, laminas });
      if ($(`#${prefijo}-cantidad`)) $(`#${prefijo}-cantidad`).value = String(area);
      if (prevEl) prevEl.textContent = `Área calculada: ${area} m² (${laminas} × ${ancho} m × ${alto} m).`;
    } else if (prevEl) {
      prevEl.textContent = "Área calculada: 0 m²";
    }
  }

  function poblarSelectProductoKardex() {
    const sel = $("#kardex-filtro-producto");
    if (!sel) return;
    const prev = sel.value || "Todos";
    const ordenados = [...productos].sort((a, b) =>
      String(a.nombre || "").localeCompare(String(b.nombre || ""), "es")
    );
    sel.innerHTML =
      `<option value="Todos">Todos los productos</option>` +
      ordenados
        .map(
          (p) =>
            `<option value="${escapeHtml(p.id)}">${escapeHtml(p.nombre)} (${escapeHtml(p.codigo || "—")})</option>`
        )
        .join("");
    const existe = ordenados.some((p) => p.id === prev);
    sel.value = existe ? prev : "Todos";
  }

  function formatCantidadKardex(val) {
    const n = Math.round((Number(val) || 0) * 100) / 100;
    return n.toLocaleString("es-CO", { maximumFractionDigits: 2 });
  }

  function renderKardex() {
    const badgeTotal = $("#inv-kardex-total-badge");
    if (badgeTotal) badgeTotal.textContent = String(kardex.length);

    const tbody = root.querySelector("#tabla-kardex-inventario tbody");
    const countEl = $("#inv-kardex-count");
    const tituloEl = $("#titulo-kardex-inv");
    const prodFiltro = $("#kardex-filtro-producto")?.value || "Todos";
    const qK = ($("#kardex-buscar")?.value || "").trim().toLowerCase();
    const desde = $("#kardex-desde")?.value || "";
    const hasta = $("#kardex-hasta")?.value || "";

    const prodSel = prodFiltro !== "Todos" ? productos.find((p) => p.id === prodFiltro) : null;
    if (tituloEl) {
      tituloEl.textContent = prodSel
        ? `Kardex del producto: ${prodSel.nombre} (${prodSel.codigo})`
        : "Kardex general de inventario";
    }

    const listaFiltrada = kardex.filter((m) => {
      if (prodFiltro !== "Todos" && m.productoId !== prodFiltro) return false;
      const origenLow = String(m.origen || "").toLowerCase();
      if (kardexQuickFilter === "Entrada" && m.tipo !== "Entrada") return false;
      if (kardexQuickFilter === "Salida" && m.tipo !== "Salida") return false;
      if (kardexQuickFilter === "Venta" && !origenLow.includes("venta")) return false;
      if (
        kardexQuickFilter === "Baja" &&
        !origenLow.includes("pérdida") &&
        !origenLow.includes("perdida") &&
        !origenLow.includes("daño") &&
        !origenLow.includes("dano") &&
        !origenLow.includes("baja")
      ) {
        return false;
      }

      const dia = String(m.fecha || "").slice(0, 10);
      if (desde && dia < desde) return false;
      if (hasta && dia > hasta) return false;

      if (!qK) return true;
      return (
        String(m.productoNombre || "").toLowerCase().includes(qK) ||
        String(m.codigo || "").toLowerCase().includes(qK) ||
        String(m.referenciaId || "").toLowerCase().includes(qK) ||
        String(m.origen || "").toLowerCase().includes(qK) ||
        String(m.motivo || "").toLowerCase().includes(qK) ||
        String(m.proveedor || "").toLowerCase().includes(qK) ||
        String(m.usuario || "").toLowerCase().includes(qK)
      );
    });

    kardexUltimosFiltrados = listaFiltrada;
    if (countEl) {
      countEl.textContent =
        listaFiltrada.length === 1
          ? "1 movimiento encontrado"
          : `${listaFiltrada.length} movimientos encontrados`;
    }

    let totalEntradas = 0;
    let totalSalidas = 0;
    for (const m of listaFiltrada) {
      const c = Number(m.cantidad) || 0;
      if (m.tipo === "Entrada") totalEntradas += c;
      else if (m.tipo === "Salida") totalSalidas += c;
    }
    const unitSuffix = prodSel?.unidad ? ` ${prodSel.unidad}` : "";
    if ($("#kardex-res-total")) $("#kardex-res-total").textContent = String(listaFiltrada.length);
    if ($("#kardex-res-entradas")) {
      $("#kardex-res-entradas").textContent = `+ ${formatCantidadKardex(totalEntradas)}${unitSuffix}`;
    }
    if ($("#kardex-res-salidas")) {
      $("#kardex-res-salidas").textContent = `− ${formatCantidadKardex(totalSalidas)}${unitSuffix}`;
    }

    const fichaEl = $("#kardex-prod-ficha");
    if (fichaEl) {
      if (prodSel) {
        const est = presentarEstado(prodSel);
        const u = prodSel.unidad ? ` ${escapeHtml(prodSel.unidad)}` : "";
        fichaEl.classList.remove("hidden");
        fichaEl.innerHTML = `
          <div class="kardex-prod-card-head">
            <div>
              <div class="kardex-prod-card-title">${escapeHtml(prodSel.nombre)}</div>
              <small class="text-muted">Código: <b>${escapeHtml(prodSel.codigo || "—")}</b></small>
            </div>
            <span class="badge ${est.claseBadge}">${escapeHtml(est.etiqueta)}</span>
          </div>
          <div class="kardex-prod-card-grid">
            <div><span>Existencia actual</span><b class="num">${prodSel.stock}${u}</b></div>
            <div><span>Stock mínimo</span><b class="num">${prodSel.stockMinimo ?? 0}${u}</b></div>
            <div><span>Costo unitario</span><b class="num">${formatCOP(prodSel.precioCompra || 0)}</b></div>
            <div><span>Precio de venta</span><b class="num">${formatCOP(prodSel.precio || 0)}</b></div>
          </div>
        `;
      } else {
        fichaEl.classList.add("hidden");
        fichaEl.innerHTML = "";
      }
    }

    if (!tbody) return;

    tbody.innerHTML = listaFiltrada.length
      ? listaFiltrada
          .map((m) => {
            const esEntrada = m.tipo === "Entrada";
            const u = m.unidad ? ` ${escapeHtml(m.unidad)}` : "";
            const costoVal =
              m.costoTotal != null && m.costoTotal !== ""
                ? formatCOP(m.costoTotal)
                : m.precioCompra != null && m.precioCompra !== ""
                  ? formatCOP(m.precioCompra)
                  : "—";
            const refPart = m.referenciaId ? ` · Ref: <b>${escapeHtml(m.referenciaId)}</b>` : "";
            const provPart = m.proveedor ? ` · Prov: ${escapeHtml(m.proveedor)}` : "";
            return `
              <tr data-dia="${escapeHtml(String(m.fecha || "").slice(0, 10))}">
                <td style="white-space:nowrap">${formatDateTime(m.fecha)}</td>
                <td>
                  <b>${escapeHtml(m.productoNombre || "—")}</b>
                  <br><small class="text-muted">${escapeHtml(m.codigo || "—")}</small>
                </td>
                <td>
                  <div class="kardex-tipo-stack">
                    <span class="badge ${esEntrada ? "badge-success" : "badge-danger"}">${esEntrada ? "+ Entrada" : "− Salida"}</span>
                    <span class="kardex-origen-txt">${escapeHtml(m.origen || "—")}</span>
                  </div>
                </td>
                <td class="num">${m.stockAnterior ?? "—"}${m.stockAnterior != null ? u : ""}</td>
                <td class="num ${esEntrada ? "text-income" : "text-expense"}"><b>${esEntrada ? "+ " : "− "}${m.cantidad}${u}</b></td>
                <td class="num"><b>${m.stockNuevo ?? "—"}${m.stockNuevo != null ? u : ""}</b></td>
                <td class="num">${costoVal}</td>
                <td>
                  <span>${escapeHtml(m.motivo || "—")}${refPart}${provPart}</span>
                  <br><small class="text-muted">${escapeHtml(m.usuario || "—")}</small>
                </td>
              </tr>
            `;
          })
          .join("")
      : `<tr><td colspan="8" style="text-align:center; padding:1.5rem" class="text-muted">No hay movimientos de inventario que coincidan con los filtros.</td></tr>`;
  }

  function abrirModalKardex(productoId = "Todos") {
    poblarSelectProductoKardex();
    const sel = $("#kardex-filtro-producto");
    if (sel) sel.value = productoId || "Todos";
    renderKardex();
    $("#modal-kardex-inventario")?.classList.add("is-open");
  }

  function exportarKardexCSV() {
    const csvCell = (val) => `"${String(val ?? "").replace(/"/g, '""')}"`;
    const headers = [
      "Fecha",
      "Código",
      "Producto",
      "Tipo",
      "Origen",
      "Stock Anterior",
      "Cantidad",
      "Unidad",
      "Stock Nuevo",
      "Costo Unitario",
      "Motivo/Proveedor",
      "Usuario"
    ];
    const rows = kardexUltimosFiltrados.map((m) => {
      const motivoProv = [m.motivo, m.referenciaId ? `Ref: ${m.referenciaId}` : "", m.proveedor ? `Prov: ${m.proveedor}` : ""]
        .filter(Boolean)
        .join(" | ");
      return [
        formatDateTime(m.fecha),
        m.codigo || "",
        m.productoNombre || "",
        m.tipo || "",
        m.origen || "",
        m.stockAnterior ?? "",
        m.cantidad ?? "",
        m.unidad || "",
        m.stockNuevo ?? "",
        m.precioCompra ?? m.costoTotal ?? "",
        motivoProv,
        m.usuario || ""
      ]
        .map(csvCell)
        .join(",");
    });
    const csvContent = "\uFEFF" + [headers.map(csvCell).join(","), ...rows].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `kardex_inventario_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  let unidadTocadaManualmente = false;

  function syncCampoDecimalProducto() {
    const uVal = $("#prod-unidad")?.value ?? "";
    const fieldDec = $("#field-prod-decimal");
    const chkDec = $("#prod-permite-decimal");
    if (fieldDec) fieldDec.classList.toggle("hidden", uVal !== "");
    if (chkDec && (uVal === "m" || uVal === "m²")) chkDec.checked = true;
    else if (chkDec && uVal === "u") chkDec.checked = false;
  }

  function abrirModalProducto(prod = null) {
    const errEl = $("#prod-error");
    if (errEl) errEl.classList.add("hidden");

    const titulo = $("#titulo-producto");
    const fieldStockInicial = $("#field-prod-stock-inicial");

    if (prod) {
      unidadTocadaManualmente = true;
      if (titulo) titulo.textContent = `Editar producto · ${prod.codigo}`;
      if ($("#prod-id")) $("#prod-id").value = prod.id;
      if ($("#prod-nombre")) $("#prod-nombre").value = prod.nombre;
      if ($("#prod-codigo")) $("#prod-codigo").value = prod.codigo;
      if ($("#prod-categoria")) $("#prod-categoria").value = prod.categoria;
      if ($("#prod-modalidad")) $("#prod-modalidad").value = inferirModalidadProducto(prod);
      if ($("#prod-unidad")) $("#prod-unidad").value = prod.unidad ?? "";
      if ($("#prod-permite-decimal")) $("#prod-permite-decimal").checked = Boolean(prod.permiteDecimal);
      if ($("#prod-precio-compra")) $("#prod-precio-compra").value = formatMontoInput(prod.precioCompra ?? 0) || "0";
      if ($("#prod-precio")) $("#prod-precio").value = formatMontoInput(prod.precio);
      if ($("#prod-minimo")) $("#prod-minimo").value = prod.stockMinimo ?? 0;
      if ($("#prod-descripcion")) $("#prod-descripcion").value = prod.descripcion || "";
      if (fieldStockInicial) fieldStockInicial.classList.add("hidden");
    } else {
      unidadTocadaManualmente = false;
      if (titulo) titulo.textContent = "Nuevo producto";
      $("#form-producto")?.reset();
      if ($("#prod-id")) $("#prod-id").value = "";
      if ($("#prod-permite-decimal")) $("#prod-permite-decimal").checked = false;
      if (fieldStockInicial) fieldStockInicial.classList.remove("hidden");
    }

    syncCampoDecimalProducto();
    $("#modal-producto")?.classList.add("is-open");
  }

  function renderInventarioModal() {
    const tbody = root.querySelector("#tabla-productos-modal tbody");
    const countEl = $("#modal-inv-contador");
    if (!tbody) return;

    const q = ($("#buscar-inventario-modal")?.value || "").trim().toLowerCase();
    const puedeGestionar = hasPermission("inventario.gestionar", getCurrentUser());

    const filtrados = productos.filter((p) => {
      const est = getEstadoStock(p);
      if (modalEstadoFiltro !== "todos" && est.codigo !== modalEstadoFiltro) return false;
      if (!q) return true;
      return (
        String(p.nombre || "").toLowerCase().includes(q) ||
        String(p.codigo || "").toLowerCase().includes(q) ||
        String(p.categoria || "").toLowerCase().includes(q) ||
        String(est.etiqueta || "").toLowerCase().includes(q)
      );
    });

    if (countEl) countEl.textContent = `Mostrando ${filtrados.length} productos`;
    tbody.innerHTML = filtrados.length
      ? filtrados.map((p) => renderFilaProductoHTML(p, puedeGestionar)).join("")
      : `<tr><td colspan="10" style="text-align:center; padding:1.5rem" class="text-muted">No hay productos que coincidan con la búsqueda.</td></tr>`;

    let disp = 0;
    let bajo = 0;
    let agot = 0;
    let valCosto = 0;
    let valVenta = 0;
    for (const p of filtrados) {
      const est = getEstadoStock(p);
      if (est.codigo === "disponible") disp += 1;
      else if (est.codigo === "bajo") bajo += 1;
      else if (est.codigo === "agotado") agot += 1;
      const stk = Number(p.stock) || 0;
      if (p.activo !== false && stk > 0) {
        valCosto += roundCOP(stk * (Number(p.precioCompra) || 0));
        valVenta += roundCOP(stk * (Number(p.precio) || 0));
      }
    }
    const setTxt = (s, v) => {
      const el = $(s);
      if (el) el.textContent = v;
    };
    setTxt("#modal-inv-res-total", String(filtrados.length));
    setTxt("#modal-inv-res-disp", String(disp));
    setTxt("#modal-inv-res-bajo", String(bajo));
    setTxt("#modal-inv-res-agot", String(agot));
    setTxt("#modal-inv-res-costo", formatCOP(valCosto));
    setTxt("#modal-inv-res-venta", formatCOP(valVenta));
  }

  function abrirModalInventarioCompleto() {
    renderInventarioModal();
    $("#modal-inventario-completo")?.classList.add("is-open");
    setTimeout(() => $("#buscar-inventario-modal")?.focus(), 40);
  }

  $("#btn-nuevo-producto")?.addEventListener("click", () => abrirModalProducto(null));
  $("#btn-abrir-entrada")?.addEventListener("click", () => $("#modal-entrada-inv")?.classList.add("is-open"));
  $("#btn-abrir-salida")?.addEventListener("click", () => $("#modal-salida-inv")?.classList.add("is-open"));
  $("#btn-ver-todo-inventario")?.addEventListener("click", abrirModalInventarioCompleto);
  $("#btn-ver-inventario-inferior")?.addEventListener("click", abrirModalInventarioCompleto);
  $("#buscar-inventario-modal")?.addEventListener("input", renderInventarioModal);
  root.querySelectorAll("[data-modal-inv-estado]").forEach((btn) => {
    btn.addEventListener("click", () => {
      modalEstadoFiltro = btn.dataset.modalInvEstado || "todos";
      root.querySelectorAll("[data-modal-inv-estado]").forEach((b) =>
        b.classList.toggle("active", b.dataset.modalInvEstado === modalEstadoFiltro)
      );
      renderInventarioModal();
    });
  });
  $("#btn-modal-inv-nuevo")?.addEventListener("click", () => abrirModalProducto(null));
  $("#btn-modal-inv-entrada")?.addEventListener("click", () => $("#modal-entrada-inv")?.classList.add("is-open"));
  $("#btn-modal-inv-salida")?.addEventListener("click", () => $("#modal-salida-inv")?.classList.add("is-open"));
  $("#btn-modal-inv-kardex")?.addEventListener("click", () => abrirModalKardex("Todos"));
  $("#btn-abrir-kardex")?.addEventListener("click", () => abrirModalKardex("Todos"));
  root.querySelectorAll("[data-close-kardex]").forEach((btn) =>
    btn.addEventListener("click", () => $("#modal-kardex-inventario")?.classList.remove("is-open"))
  );
  root.querySelectorAll("[data-kardex-q]").forEach((chip) => {
    chip.addEventListener("click", () => {
      kardexQuickFilter = chip.dataset.kardexQ || "Todos";
      root.querySelectorAll("[data-kardex-q]").forEach((c) =>
        c.classList.toggle("active", c.dataset.kardexQ === kardexQuickFilter)
      );
      renderKardex();
    });
  });
  $("#kardex-filtro-producto")?.addEventListener("change", renderKardex);
  $("#kardex-desde")?.addEventListener("change", renderKardex);
  $("#kardex-hasta")?.addEventListener("change", renderKardex);
  $("#btn-limpiar-kardex")?.addEventListener("click", () => {
    kardexQuickFilter = "Todos";
    root.querySelectorAll("[data-kardex-q]").forEach((c) =>
      c.classList.toggle("active", c.dataset.kardexQ === "Todos")
    );
    if ($("#kardex-filtro-producto")) $("#kardex-filtro-producto").value = "Todos";
    if ($("#kardex-buscar")) $("#kardex-buscar").value = "";
    if ($("#kardex-desde")) $("#kardex-desde").value = "";
    if ($("#kardex-hasta")) $("#kardex-hasta").value = "";
    renderKardex();
  });
  $("#btn-exportar-kardex-csv")?.addEventListener("click", exportarKardexCSV);
  $("#btn-kardex-entrada")?.addEventListener("click", () => {
    const prodFiltro = $("#kardex-filtro-producto")?.value || "Todos";
    const entSel = $("#ent-producto");
    if (entSel && prodFiltro !== "Todos" && [...entSel.options].some((o) => o.value === prodFiltro)) {
      entSel.value = prodFiltro;
      syncDimensionesMovimiento("ent");
    }
    $("#modal-entrada-inv")?.classList.add("is-open");
  });
  $("#btn-kardex-salida")?.addEventListener("click", () => {
    const prodFiltro = $("#kardex-filtro-producto")?.value || "Todos";
    const salSel = $("#sal-producto");
    if (salSel && prodFiltro !== "Todos" && [...salSel.options].some((o) => o.value === prodFiltro)) {
      salSel.value = prodFiltro;
      syncDimensionesMovimiento("sal");
    }
    $("#modal-salida-inv")?.classList.add("is-open");
  });
  $("#modal-inventario-completo")?.addEventListener("click", (e) => {
    if (e.target.closest(".modal-close")) {
      e.preventDefault();
      $("#modal-inventario-completo")?.classList.remove("is-open");
    }
  });
  $("#buscar-inventario")?.addEventListener("input", renderTablaInventario);
  $("#inv-filtro-categoria")?.addEventListener("change", renderTablaInventario);
  $("#inv-filtro-modalidad")?.addEventListener("change", renderTablaInventario);
  $("#solo-bajo")?.addEventListener("change", renderTablaInventario);
  $("#mostrar-inactivos")?.addEventListener("change", renderTablaInventario);
  $("#kardex-buscar")?.addEventListener("input", renderKardex);

  // Botones "Ver" dentro de las tarjetas KPI: filtran la tabla de productos por estado
  root.querySelectorAll("[data-inv-kpi]").forEach((btn) =>
    btn.addEventListener("click", () => aplicarFiltroEstado(btn.dataset.invKpi))
  );
  $("#inv-quitar-filtro-estado")?.addEventListener("click", () => aplicarFiltroEstado("todos"));
  actualizarIndicadorFiltroEstado();

  const hoyIso = new Date().toISOString().slice(0, 10);
  if ($("#ent-fecha") && !$("#ent-fecha").value) $("#ent-fecha").value = hoyIso;
  if ($("#sal-fecha") && !$("#sal-fecha").value) $("#sal-fecha").value = hoyIso;

  $("#ent-producto")?.addEventListener("change", () => syncDimensionesMovimiento("ent"));
  $("#sal-producto")?.addEventListener("change", () => syncDimensionesMovimiento("sal"));
  ["#ent-laminas", "#ent-ancho", "#ent-alto"].forEach((sel) =>
    $(sel)?.addEventListener("input", () => recalcularAreaMovimiento("ent"))
  );
  ["#sal-laminas", "#sal-ancho", "#sal-alto"].forEach((sel) =>
    $(sel)?.addEventListener("input", () => recalcularAreaMovimiento("sal"))
  );

  $("#prod-modalidad")?.addEventListener("change", () => {
    const mod = $("#prod-modalidad")?.value;
    const uEl = $("#prod-unidad");
    if (uEl) {
      uEl.value = mod === "m2" ? "m²" : mod === "m" ? "m" : "u";
      syncCampoDecimalProducto();
    }
  });

  $("#prod-unidad")?.addEventListener("change", () => {
    unidadTocadaManualmente = true;
    syncCampoDecimalProducto();
  });

  $("#prod-categoria")?.addEventListener("change", () => {
    const cat = $("#prod-categoria")?.value;
    const uEl = $("#prod-unidad");
    if (uEl && !$("#prod-id")?.value && !unidadTocadaManualmente) {
      uEl.value = cat === "Vidrios" ? "m²" : cat === "Perfiles" ? "m" : "u";
      syncCampoDecimalProducto();
    }
  });

  $("#ent-registrar-gasto")?.addEventListener("change", (e) => {
    const checked = e.target.checked;
    $("#box-ent-metodo")?.classList.toggle("hidden", !checked);
    $("#box-ent-costo")?.classList.toggle("hidden", !checked);
  });

  async function manejarClickTablaProductos(e) {
    const kardexBtn = e.target.closest("[data-kardex-prod]");
    if (kardexBtn) {
      abrirModalKardex(kardexBtn.dataset.kardexProd);
      return;
    }
    const editBtn = e.target.closest("[data-edit-prod]");
    if (editBtn) {
      const prod = productos.find((p) => p.id === editBtn.dataset.editProd);
      if (prod) abrirModalProducto(prod);
      return;
    }
    const toggleBtn = e.target.closest("[data-toggle-prod]");
    if (toggleBtn) {
      const prod = productos.find((p) => p.id === toggleBtn.dataset.toggleProd);
      if (!prod) return;
      const nuevoEstado = prod.activo === false;
      const accionTxt = nuevoEstado ? "activar" : "desactivar";
      const confirmado = await confirmarAccionModal({
        titulo: `${nuevoEstado ? "Activar" : "Desactivar"} producto`,
        pregunta: `¿Desea ${accionTxt} el producto "${prod.nombre}"?`,
        textoConfirmar: `Sí, ${accionTxt}`,
        claseBoton: nuevoEstado ? "btn-primary" : "btn-danger"
      });
      if (!confirmado) return;
      try {
        await cambiarEstadoProducto(prod.id, nuevoEstado, getCurrentUser());
        showFeedback(
          `Producto "${prod.nombre}" ${nuevoEstado ? "activado" : "desactivado"} correctamente.`
        );
      } catch (err) {
        showFeedback(err.message, true);
      }
      return;
    }
    // Clic en cualquier otra parte de la fila: mostrar detalle del producto
    const fila = e.target.closest("[data-detalle-prod]");
    if (fila && !e.target.closest("button, a, input, select")) {
      abrirDetalleProducto(fila.dataset.detalleProd);
    }
  }

  root.querySelector("#tabla-productos")?.addEventListener("click", manejarClickTablaProductos);
  root.querySelector("#tabla-productos-modal")?.addEventListener("click", manejarClickTablaProductos);

  $("#form-producto")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#prod-error");
    if (errEl) errEl.classList.add("hidden");
    try {
      const id = $("#prod-id")?.value;
      const unidadSel = $("#prod-unidad")?.value ?? "";
      const payload = {
        nombre: $("#prod-nombre")?.value,
        codigo: $("#prod-codigo")?.value,
        categoria: $("#prod-categoria")?.value,
        modalidad: $("#prod-modalidad")?.value,
        unidad: unidadSel,
        permiteDecimal:
          unidadSel === "m" || unidadSel === "m²"
            ? true
            : unidadSel === "u"
              ? false
              : Boolean($("#prod-permite-decimal")?.checked),
        precioCompra: parseMontoInput($("#prod-precio-compra")?.value),
        precio: parseMontoInput($("#prod-precio")?.value),
        stock: $("#prod-stock")?.value,
        stockMinimo: $("#prod-minimo")?.value,
        descripcion: $("#prod-descripcion")?.value
      };

      if (id) {
        await actualizarProducto(id, payload, getCurrentUser());
        showFeedback(`Producto "${payload.nombre}" actualizado correctamente.`);
      } else {
        await crearProducto(payload, getCurrentUser());
        showFeedback(`Producto "${payload.nombre}" registrado en el catálogo.`);
      }
      $("#form-producto").reset();
      $("#modal-producto")?.classList.remove("is-open");
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    }
  });

  $("#form-entrada")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const mov = await registrarMovimientoBodega(
        {
          productoId: $("#ent-producto")?.value,
          tipo: "Entrada",
          origen: $("#ent-origen")?.value || "Entrada por compra",
          cantidad: $("#ent-cantidad")?.value,
          ancho: $("#ent-ancho")?.value,
          alto: $("#ent-alto")?.value,
          laminas: $("#ent-laminas")?.value || 1,
          precioCompra: $("#ent-precio-compra")?.value?.trim() ? parseMontoInput($("#ent-precio-compra")?.value) : null,
          proveedor: $("#ent-proveedor")?.value,
          fecha: $("#ent-fecha")?.value,
          motivo: $("#ent-motivo")?.value,
          registrarGastoCompra: Boolean($("#ent-registrar-gasto")?.checked),
          metodoPagoCompra: $("#ent-metodo-pago")?.value || "Transferencia",
          costoTotalCompra: $("#ent-costo-total")?.value
        },
        getCurrentUser()
      );
      $("#ent-cantidad").value = "";
      $("#ent-motivo").value = "";
      if ($("#ent-precio-compra")) $("#ent-precio-compra").value = "";
      if ($("#ent-proveedor")) $("#ent-proveedor").value = "";
      if ($("#ent-costo-total")) $("#ent-costo-total").value = "";
      $("#modal-entrada-inv")?.classList.remove("is-open");
      showFeedback(
        `Entrada registrada: +${mov.cantidad} ${mov.unidad} de "${mov.productoNombre}" (nuevo stock: ${mov.stockNuevo} ${mov.unidad}).`
      );
    } catch (err) {
      showFeedback(err.message, true);
    }
  });

  $("#form-salida")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const prodSel = productos.find((p) => p.id === $("#sal-producto")?.value);
    const origenTxt = $("#sal-origen")?.value || "Pérdida o daño";
    const cantTxt = $("#sal-cantidad")?.value || "0";
    const motivoTxt = ($("#sal-motivo")?.value || "").trim() || "Sin motivo especificado";
    const confirmado = await confirmarAccionModal({
      titulo: "Confirmar salida de inventario",
      pregunta: "¿Desea registrar esta salida / baja de inventario?",
      detallesHtml: `
        <div><strong>Producto:</strong> ${escapeHtml(prodSel ? `${prodSel.nombre} (${prodSel.codigo})` : "Producto seleccionado")}</div>
        <div><strong>Tipo de salida:</strong> ${escapeHtml(origenTxt)}</div>
        <div><strong>Cantidad / medida:</strong> ${escapeHtml(cantTxt)}${prodSel?.unidad ? ` ${escapeHtml(prodSel.unidad)}` : ""}</div>
        <div><strong>Motivo:</strong> ${escapeHtml(motivoTxt)}</div>
      `,
      textoConfirmar: "Confirmar salida",
      claseBoton: "btn-danger"
    });
    if (!confirmado) return;
    try {
      const mov = await registrarMovimientoBodega(
        {
          productoId: $("#sal-producto")?.value,
          tipo: "Salida",
          origen: $("#sal-origen")?.value || "Pérdida o daño",
          cantidad: $("#sal-cantidad")?.value,
          ancho: $("#sal-ancho")?.value,
          alto: $("#sal-alto")?.value,
          laminas: $("#sal-laminas")?.value || 1,
          fecha: $("#sal-fecha")?.value,
          motivo: $("#sal-motivo")?.value
        },
        getCurrentUser()
      );
      $("#sal-cantidad").value = "";
      $("#sal-motivo").value = "";
      $("#modal-salida-inv")?.classList.remove("is-open");
      showFeedback(
        `Salida registrada: −${mov.cantidad} ${mov.unidad} de "${mov.productoNombre}" (nuevo stock: ${mov.stockNuevo} ${mov.unidad}).`
      );
    } catch (err) {
      showFeedback(err.message, true);
    }
  });

  const unsubProd = watchProductos(
    (lista) => {
      productos = lista;
      renderTablaInventario();
      renderDashboardInventario();
      poblarSelectProductoKardex();
      if ($("#modal-inventario-completo")?.classList.contains("is-open")) {
        renderInventarioModal();
      }
      if ($("#modal-kardex-inventario")?.classList.contains("is-open")) {
        renderKardex();
      }
    },
    { incluirInactivos: true }
  );

  const unsubKardex = watchMovimientosInventario((lista) => {
    kardex = lista;
    renderKardex();
    renderDashboardInventario();
  });

  return () => {
    unsubProd();
    unsubKardex();
  };
}

// ---------------------------------------------------------------------------
// 2. VISTA DE CONTABILIDAD BÁSICA ACCESIBLE (Secciones 1 a 17)
// ---------------------------------------------------------------------------
export function mountContabilidadView(root) {
  const $ = (sel) => root.querySelector(sel);
  let movimientos = [];
  let cajaAbierta = null;
  let ventas = [];
  let ultimosFiltrados = [];
  let accionPendienteConfirmar = null;
  let movimientoDetalleActualId = null;
  let modalQFilter = "Todos";

  bindMoneyInputs(root);

  const feedbackEl = $("#contab-feedback-banner");
  function showFeedback(msg, isError = false) {
    if (!feedbackEl) return;
    feedbackEl.textContent = msg;
    feedbackEl.className = `alert ${isError ? "alert-danger" : "alert-success"} mb-3`;
    feedbackEl.style.display = "block";
    feedbackEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const hoyIso = new Date().toISOString().slice(0, 10);
  const currentUser = getCurrentUser();
  if ($("#ing-fecha") && !$("#ing-fecha").value) $("#ing-fecha").value = hoyIso;
  if ($("#gas-fecha") && !$("#gas-fecha").value) $("#gas-fecha").value = hoyIso;
  if ($("#tras-fecha") && !$("#tras-fecha").value) $("#tras-fecha").value = hoyIso;
  if ($("#ing-responsable")) $("#ing-responsable").value = currentUser.name || currentUser.email;
  if ($("#gas-responsable")) $("#gas-responsable").value = currentUser.name || currentUser.email;

  // Pestañas principales de Contabilidad (Resumen, Movimientos, Cartera, Caja y Bancos, Cuentas por pagar)
  function cambiarPestanaContable(tabName = "resumen") {
    root.querySelectorAll("[data-contab-view]").forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.contabView === tabName)
    );
    ["resumen", "movimientos", "cartera", "bancos", "por_pagar"].forEach((name) => {
      $(`#contab-view-${name}`)?.classList.toggle("hidden", name !== tabName);
    });
  }
  root.querySelectorAll("[data-contab-view]").forEach((btn) =>
    btn.addEventListener("click", () => cambiarPestanaContable(btn.dataset.contabView || "resumen"))
  );
  $("#btn-ir-a-movimientos")?.addEventListener("click", () => cambiarPestanaContable("movimientos"));

  // Cambio entre los 3 botones grandes dentro del modal + Nuevo movimiento
  const tabBtns = [
    { btn: "#tab-btn-ingreso", panel: "#panel-ingreso", key: "ingreso" },
    { btn: "#tab-btn-gasto", panel: "#panel-gasto", key: "gasto" },
    { btn: "#tab-btn-traslado", panel: "#panel-traslado", key: "traslado" }
  ];
  function activarTabModalNuevoMov(key = "ingreso") {
    tabBtns.forEach((t) => {
      $(t.btn)?.classList.toggle("active", t.key === key);
      const p = $(t.panel);
      if (p) p.style.display = t.key === key ? "block" : "none";
    });
    if (feedbackEl) feedbackEl.style.display = "none";
  }
  tabBtns.forEach(({ btn, key }) => {
    $(btn)?.addEventListener("click", () => activarTabModalNuevoMov(key));
  });

  function abrirModalNuevoMov(tab = "ingreso", { gastoPendiente = false } = {}) {
    activarTabModalNuevoMov(tab);
    if (tab === "gasto" && $("#gas-estado-pago")) {
      $("#gas-estado-pago").value = gastoPendiente ? "Pendiente" : "Pagado";
    }
    sincronizarVisibilidadCajaEfectivo();
    $("#modal-nuevo-mov-contable")?.classList.add("is-open");
  }
  $("#btn-abrir-nuevo-mov-contable")?.addEventListener("click", () => abrirModalNuevoMov("ingreso"));
  $("#btn-abrir-nuevo-mov-contable-2")?.addEventListener("click", () => abrirModalNuevoMov("ingreso"));
  $("#btn-nuevo-traslado-bancos")?.addEventListener("click", () => abrirModalNuevoMov("traslado"));
  $("#btn-nueva-cxp")?.addEventListener("click", () => abrirModalNuevoMov("gasto", { gastoPendiente: true }));
  root.querySelectorAll('[data-close-modal="modal-nuevo-mov-contable"]').forEach((btn) =>
    btn.addEventListener("click", () => $("#modal-nuevo-mov-contable")?.classList.remove("is-open"))
  );
  root.querySelectorAll('[data-close-modal="modal-abono-cartera"]').forEach((btn) =>
    btn.addEventListener("click", () => $("#modal-abono-cartera")?.classList.remove("is-open"))
  );
  root.querySelectorAll('[data-close-modal="modal-pagar-cxp"]').forEach((btn) =>
    btn.addEventListener("click", () => $("#modal-pagar-cxp")?.classList.remove("is-open"))
  );

  // Sincronizar casilla de efectivo en caja según el método de pago y estado de pago
  function sincronizarVisibilidadCajaEfectivo() {
    const ingEsEfectivo = ($("#ing-metodo")?.value || "Efectivo") === "Efectivo";
    const gasEstado = $("#gas-estado-pago")?.value || "Pagado";
    const gasEsPendiente = gasEstado === "Pendiente";
    const gasEsEfectivo = ($("#gas-metodo")?.value || "Efectivo") === "Efectivo" && !gasEsPendiente;

    const chkIng = $("#ing-afecta-caja");
    const boxIng = $("#ing-wrap-afecta-caja");
    const helpIng = $("#ing-afecta-caja-help");
    if (chkIng && boxIng) {
      if (!ingEsEfectivo) chkIng.checked = false;
      chkIng.disabled = !ingEsEfectivo;
      boxIng.style.opacity = ingEsEfectivo ? "1" : "0.6";
      if (helpIng) {
        helpIng.textContent = ingEsEfectivo
          ? "Si está marcada, este dinero se sumará al efectivo esperado al cerrar la caja del turno."
          : "Como el pago es por transferencia o billetera digital, NO suma billetes al efectivo físico de la caja.";
      }
    }

    const chkGas = $("#gas-afecta-caja");
    const boxGas = $("#gas-wrap-afecta-caja");
    const helpGas = $("#gas-afecta-caja-help");
    if (chkGas && boxGas) {
      if (!gasEsEfectivo) chkGas.checked = false;
      chkGas.disabled = !gasEsEfectivo;
      boxGas.style.opacity = gasEsEfectivo ? "1" : "0.6";
      if (helpGas) {
        helpGas.textContent = gasEsPendiente
          ? "Al quedar como Cuenta por pagar pendiente, no descuenta dinero de Caja ni Banco hasta que se pague."
          : gasEsEfectivo
            ? "Si el gasto se pagó con billetes de la caja abierta, déjela marcada para descontarlo del efectivo esperado."
            : "Como el pago se hizo por transferencia o billetera digital, NO modifica el efectivo físico de la caja.";
      }
    }
  }

  $("#ing-metodo")?.addEventListener("change", sincronizarVisibilidadCajaEfectivo);
  $("#gas-metodo")?.addEventListener("change", sincronizarVisibilidadCajaEfectivo);
  $("#gas-estado-pago")?.addEventListener("change", sincronizarVisibilidadCajaEfectivo);
  sincronizarVisibilidadCajaEfectivo();

  // Modal de confirmación antes de guardar una operación importante
  function solicitarConfirmacion({ pregunta, detallesHtml, textoBoton = "Sí, registrar", claseBoton = "btn-primary", onConfirm }) {
    const modal = $("#modal-confirmar-contable");
    const pregEl = $("#confirm-contable-pregunta");
    const resEl = $("#confirm-contable-resumen");
    const btnSi = $("#btn-confirmar-si-contable");
    if (!modal || !pregEl || !resEl || !btnSi) {
      onConfirm();
      return;
    }
    pregEl.textContent = pregunta;
    resEl.innerHTML = detallesHtml;
    btnSi.textContent = textoBoton;
    btnSi.className = `btn ${claseBoton}`;
    accionPendienteConfirmar = onConfirm;
    modal.classList.add("is-open");
  }

  function cerrarModalConfirmacion() {
    const modal = $("#modal-confirmar-contable");
    if (modal) modal.classList.remove("is-open");
    accionPendienteConfirmar = null;
  }

  $("#btn-confirmar-no-contable")?.addEventListener("click", cerrarModalConfirmacion);
  $("#btn-cerrar-confirmar-contable")?.addEventListener("click", cerrarModalConfirmacion);
  $("#btn-confirmar-si-contable")?.addEventListener("click", async () => {
    const fn = accionPendienteConfirmar;
    cerrarModalConfirmacion();
    if (typeof fn === "function") {
      await fn();
    }
  });

  $("#contab-periodo-resumen")?.addEventListener("change", () => {
    const per = $("#contab-periodo-resumen")?.value || "todos";
    const { desde, hasta } = obtenerRangoPeriodo(per);
    if ($("#contab-filter-desde")) $("#contab-filter-desde").value = desde || "";
    if ($("#contab-filter-hasta")) $("#contab-filter-hasta").value = hasta || "";
    renderContabilidad();
  });

  function renderFilaMovimientoHTML(m) {
    const esIng = m.tipo === TIPOS_CONTABLE.INGRESO;
    const esGas = m.tipo === TIPOS_CONTABLE.GASTO;
    const revertido = Boolean(m.anulado || m.estado === "Revertido");
    const tipoLegible = esIng
      ? "Ingreso (Entra)"
      : esGas
      ? "Gasto (Sale)"
      : m.tipo;
    const badgeTipoCls = esIng ? "badge-success" : esGas ? "badge-danger" : "badge-warning";
    const montoCls = revertido ? "text-muted" : esIng ? "text-success" : esGas ? "text-danger" : "";
    const prefijo = esIng ? "+ " : esGas ? "− " : "⇄ ";
    const metodoInfo = `${escapeHtml(m.metodoPago || "Efectivo")}${m.afectaCajaFisica ? " (Caja)" : ""}`;

    return `
      <tr style="${revertido ? "opacity:0.65" : ""}">
        <td><b>${formatShortDate(m.fechaEfectiva || m.fecha)}</b></td>
        <td><span class="badge ${badgeTipoCls}">${escapeHtml(tipoLegible)}</span></td>
        <td>
          <b>${escapeHtml(m.concepto)}</b>
          ${revertido ? ' <span class="badge badge-danger" style="font-size:.74rem">Revertido</span>' : ""}
          ${m.observaciones || m.nota ? `<br><small class="text-muted">${escapeHtml(m.observaciones || m.nota)}</small>` : ""}
        </td>
        <td>${escapeHtml(m.categoria)}</td>
        <td><span class="badge badge-neutral">${metodoInfo}</span></td>
        <td class="text-right num ${montoCls}" style="white-space:nowrap"><b>${prefijo}${formatCOP(m.valor ?? m.monto)}</b></td>
        <td class="text-right" style="white-space:nowrap">
          <button type="button" class="btn btn-secondary" style="padding:.4rem .85rem;font-size:.88rem;font-weight:700" data-ver-detalle-cont="${escapeHtml(m.id)}">Ver detalle</button>
        </td>
      </tr>
    `;
  }

  function resolverFiltrosRapidos(qf) {
    if (qf === "Ingresos") return { tipo: "Ingresos", metodoPago: "Todos" };
    if (qf === "Gastos") return { tipo: "Gastos", metodoPago: "Todos" };
    if (qf === "Efectivo") return { tipo: "Todos", metodoPago: "Efectivo" };
    if (qf === "Transferencias") return { tipo: "Todos", metodoPago: "Transferencia bancaria" };
    return { tipo: "Todos", metodoPago: "Todos" };
  }

  function renderModalContabilidadCompleto() {
    const tbodyModal = $("#contab-table-body-modal");
    if (!tbodyModal) return;

    const { tipo, metodoPago } = resolverFiltrosRapidos(modalQFilter);
    const filtradosModal = filtrarMovimientosContables(movimientos, {
      tipo,
      metodoPago,
      desde: $("#modal-contab-desde")?.value || "",
      hasta: $("#modal-contab-hasta")?.value || "",
      busqueda: $("#buscar-contabilidad-modal")?.value || ""
    });

    if ($("#modal-contab-contador")) {
      $("#modal-contab-contador").textContent = `${filtradosModal.length} movimiento(s) encontrado(s)`;
    }

    tbodyModal.innerHTML = filtradosModal.length
      ? filtradosModal.map((m) => renderFilaMovimientoHTML(m)).join("")
      : `<tr><td colspan="7" style="text-align:center; padding:1.75rem" class="text-muted">No se encontraron movimientos.</td></tr>`;

    let sumIng = 0;
    let sumGas = 0;
    filtradosModal.forEach((m) => {
      if (m.anulado || m.estado === "Revertido") return;
      const val = Number(m.valor ?? m.monto ?? 0);
      if (m.tipo === TIPOS_CONTABLE.INGRESO) sumIng += val;
      else if (m.tipo === TIPOS_CONTABLE.GASTO) sumGas += val;
    });
    const resNeto = sumIng - sumGas;
    if ($("#modal-contab-res-total")) $("#modal-contab-res-total").textContent = String(filtradosModal.length);
    if ($("#modal-contab-res-ingresos")) $("#modal-contab-res-ingresos").textContent = formatCOP(sumIng);
    if ($("#modal-contab-res-gastos")) $("#modal-contab-res-gastos").textContent = formatCOP(sumGas);
    if ($("#modal-contab-res-resultado")) {
      $("#modal-contab-res-resultado").textContent = `${resNeto > 0 ? "+ " : ""}${formatCOP(resNeto)}`;
      $("#modal-contab-res-resultado").className = `num ${resNeto >= 0 ? "text-success" : "text-danger"}`;
    }
  }

  function abrirModalContabilidadCompleto() {
    const modal = $("#modal-contabilidad-completo");
    if (!modal) return;
    if ($("#buscar-contabilidad-modal")) $("#buscar-contabilidad-modal").value = $("#contab-search")?.value || "";
    if ($("#modal-contab-desde")) $("#modal-contab-desde").value = $("#contab-filter-desde")?.value || "";
    if ($("#modal-contab-hasta")) $("#modal-contab-hasta").value = $("#contab-filter-hasta")?.value || "";
    const activePill = $("#contab-quick-filter-bar .contab-pill-btn.active");
    modalQFilter = activePill?.dataset?.qfilter || "Todos";
    root.querySelectorAll("[data-modal-contab-qfilter]").forEach((b) =>
      b.classList.toggle("active", b.dataset.modalContabQfilter === modalQFilter)
    );
    renderModalContabilidadCompleto();
    modal.classList.add("is-open");
    $("#buscar-contabilidad-modal")?.focus();
  }

  function renderMovimientosRecientes() {
    const listEl = $("#contab-recientes-list");
    if (!listEl) return;
    const recientes = [...movimientos]
      .filter((m) => !m.anulado && m.estado !== "Revertido" && m.tipo !== TIPOS_CONTABLE.REVERSION)
      .sort((a, b) => String(b.fechaRegistro || b.fecha || "").localeCompare(String(a.fechaRegistro || a.fecha || "")))
      .slice(0, 6);

    if (!recientes.length) {
      listEl.innerHTML = `<div class="text-muted" style="text-align:center;padding:1.5rem">Aún no hay movimientos contables registrados.</div>`;
      return;
    }

    listEl.innerHTML = recientes
      .map((m) => {
        const esIng = m.tipo === TIPOS_CONTABLE.INGRESO;
        const esTras = m.tipo === TIPOS_CONTABLE.TRASLADO;
        const esDev = m.tipo === TIPOS_CONTABLE.DEVOLUCION;
        const esGas = m.tipo === TIPOS_CONTABLE.GASTO;
        const montoMostrar = esDev ? roundCOP(m.montoReembolsado ?? m.valor ?? m.monto) : roundCOP(m.valor ?? m.monto);
        const signo = esIng ? "+" : esTras ? "⇄ " : "−";
        const cls = esIng ? "text-success" : esTras ? "" : "text-danger";
        const fechaTxt = formatShortDate(m.fechaEfectiva || m.fecha);
        const cuentaTxt = esTras
          ? `${m.cuentaOrigen || "Caja"} → ${m.cuentaDestino || "Banco"}`
          : `${m.metodoPago || "Efectivo"} · ${normalizarCuentaContable(m.metodoPago || "Efectivo") === "Caja física" ? "Caja" : normalizarCuentaContable(m.metodoPago)}`;
        const estadoTag = m.estadoPago === "Pendiente" || m.estado === "Por pagar" ? ' <span class="badge badge-warning" style="font-size:.72rem">Por pagar</span>' : "";
        return `
          <button type="button" class="contab-reciente-row" data-ver-detalle-cont="${escapeHtml(m.id)}">
            <div class="contab-reciente-left">
              <div class="contab-reciente-title">${escapeHtml(m.concepto || m.categoria || m.tipo)}${estadoTag}</div>
              <div class="contab-reciente-meta">${escapeHtml(fechaTxt)} · ${escapeHtml(cuentaTxt)}</div>
            </div>
            <div class="contab-reciente-monto ${cls}">${signo}${formatCOP(montoMostrar)}</div>
          </button>
        `;
      })
      .join("");
  }

  function renderCarteraContable() {
    const tbody = $("#contab-cartera-body");
    const badgeTotal = $("#contab-cartera-total-badge");
    const subEl = $("#contab-cartera-sub");
    if (!tbody) return;

    const ventasPendientes = ventas
      .filter((v) => v.estado !== "Anulada" && calcularSaldoPendienteVenta(v) > 0)
      .sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")));

    const totalCartera = ventasPendientes.reduce((acc, v) => acc + calcularSaldoPendienteVenta(v), 0);
    if (badgeTotal) badgeTotal.textContent = `Total por cobrar: ${formatCOP(totalCartera)}`;
    if (subEl) {
      subEl.textContent = ventasPendientes.length
        ? `${ventasPendientes.length} ${ventasPendientes.length === 1 ? "venta activa con saldo pendiente" : "ventas activas con saldo pendiente"}`
        : "No hay ventas con saldo pendiente por cobrar";
    }

    if (!ventasPendientes.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-muted" style="text-align:center;padding:1.5rem">No hay clientes con saldo pendiente.</td></tr>`;
      return;
    }

    tbody.innerHTML = ventasPendientes
      .map((v) => {
        const saldo = calcularSaldoPendienteVenta(v);
        const abonado = Math.max(0, roundCOP((v.total || 0) - saldo));
        const cli = v.cliente || {};
        const docTel = [cli.documento, cli.telefono].filter(Boolean).join(" · ") || "—";
        return `
          <tr>
            <td><b>${escapeHtml(cli.nombre || "Consumidor Final")}</b></td>
            <td>${escapeHtml(docTel)}</td>
            <td><b>${escapeHtml(v.numero || v.id)}</b><br><small class="text-muted">${formatShortDate(v.fecha)}</small></td>
            <td class="num">${formatCOP(v.total || 0)}</td>
            <td class="num text-success">${formatCOP(abonado)}</td>
            <td class="num text-danger"><b>${formatCOP(saldo)}</b></td>
            <td class="text-right" style="white-space:nowrap">
              <button type="button" class="btn btn-primary btn-xs" data-abono-venta="${escapeHtml(v.id)}">Registrar abono</button>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function renderCajaYBancos(resGlobal) {
    const saldos = resGlobal.saldosPorCuenta || {};
    if ($("#contab-cuenta-caja")) $("#contab-cuenta-caja").textContent = formatCOP(resGlobal.disponibleCaja ?? saldos["Caja física"] ?? 0);
    if ($("#contab-cuenta-banco")) $("#contab-cuenta-banco").textContent = formatCOP(saldos["Transferencia bancaria"] || 0);
    if ($("#contab-cuenta-nequi")) $("#contab-cuenta-nequi").textContent = formatCOP(saldos.Nequi || 0);
    if ($("#contab-cuenta-daviplata")) $("#contab-cuenta-daviplata").textContent = formatCOP(saldos.Daviplata || 0);
    if ($("#contab-bancos-caja-badge")) {
      $("#contab-bancos-caja-badge").textContent = cajaAbierta
        ? `Caja abierta por ${cajaAbierta.usuarioApertura} · Base inicial: ${formatCOP(cajaAbierta.baseInicial || 0)}`
        : "No hay turno de caja abierto";
    }

    const tbody = $("#contab-bancos-body");
    if (!tbody) return;
    const movsCuentas = [...movimientos]
      .filter(
        (m) =>
          !m.anulado &&
          m.estado !== "Revertido" &&
          m.tipo !== TIPOS_CONTABLE.REVERSION &&
          m.estadoPago !== "Pendiente" &&
          m.estado !== "Por pagar" &&
          m.tipo !== TIPOS_CONTABLE.BILLETERA_REDENCION &&
          m.metodoPago !== "Saldo a favor"
      )
      .slice(0, 25);

    tbody.innerHTML = movsCuentas.length
      ? movsCuentas
          .map((m) => {
            const esTras = m.tipo === TIPOS_CONTABLE.TRASLADO;
            const esIng = m.tipo === TIPOS_CONTABLE.INGRESO;
            const cuentaTxt = esTras
              ? `${m.cuentaOrigen || "Caja física"} → ${m.cuentaDestino || "Transferencia bancaria"}`
              : normalizarCuentaContable(m.metodoPago || "Efectivo");
            const signo = esIng ? "+ " : esTras ? "⇄ " : "− ";
            const cls = esIng ? "text-success" : esTras ? "" : "text-danger";
            const montoVal = m.tipo === TIPOS_CONTABLE.DEVOLUCION ? roundCOP(m.montoReembolsado ?? 0) : roundCOP(m.valor ?? m.monto);
            return `
              <tr>
                <td><b>${formatShortDate(m.fechaEfectiva || m.fecha)}</b></td>
                <td><span class="badge badge-neutral">${escapeHtml(cuentaTxt)}</span></td>
                <td>${escapeHtml(m.tipo)}</td>
                <td>${escapeHtml(m.concepto || "—")}</td>
                <td class="text-right num ${cls}"><b>${signo}${formatCOP(montoVal)}</b></td>
                <td class="text-right"><button type="button" class="btn btn-outline btn-xs" data-ver-detalle-cont="${escapeHtml(m.id)}">Ver</button></td>
              </tr>
            `;
          })
          .join("")
      : `<tr><td colspan="6" class="text-muted" style="text-align:center;padding:1.5rem">Sin movimientos registrados en cuentas.</td></tr>`;
  }

  function renderCuentasPorPagar() {
    const tbody = $("#contab-cxp-body");
    const badgeTotal = $("#contab-cxp-total-badge");
    if (!tbody) return;
    const pendientes = movimientos.filter(
      (m) =>
        !m.anulado &&
        m.estado !== "Revertido" &&
        m.tipo === TIPOS_CONTABLE.GASTO &&
        (m.estadoPago === "Pendiente" || m.estado === "Por pagar")
    );
    const totalPorPagar = pendientes.reduce((acc, m) => acc + roundCOP(m.valor ?? m.monto), 0);
    if (badgeTotal) badgeTotal.textContent = `Total por pagar: ${formatCOP(totalPorPagar)}`;

    if (!pendientes.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-muted" style="text-align:center;padding:1.5rem">No hay cuentas por pagar pendientes.</td></tr>`;
      return;
    }

    tbody.innerHTML = pendientes
      .map(
        (m) => `
          <tr>
            <td><b>${formatShortDate(m.fechaEfectiva || m.fecha)}</b></td>
            <td>${escapeHtml(m.proveedor || "Proveedor no especificado")}</td>
            <td><b>${escapeHtml(m.concepto || "—")}</b><br><small class="text-muted">${escapeHtml(m.categoria || "—")}</small></td>
            <td class="num text-danger"><b>${formatCOP(m.valor ?? m.monto)}</b></td>
            <td><span class="badge badge-warning">Pendiente</span></td>
            <td class="text-right" style="white-space:nowrap">
              <button type="button" class="btn btn-primary btn-xs" data-pagar-cxp="${escapeHtml(m.id)}">Registrar pago a proveedor</button>
            </td>
          </tr>
        `
      )
      .join("");
  }

  function renderContabilidad() {
    const periodoSel = $("#contab-periodo-resumen")?.value || "todos";
    const desde = $("#contab-filter-desde")?.value || "";
    const hasta = $("#contab-filter-hasta")?.value || "";
    const informe = generarInformeFinancieroContable(movimientos, {
      periodo: desde || hasta ? "personalizado" : periodoSel,
      desde,
      hasta
    });
    const resGlobal = calcularResumenContable(movimientos, {
      cajas: cajaAbierta ? [cajaAbierta] : [],
      ventas
    });
    const resPeriodo = informe.resumen;

    if ($("#contab-kpi-ingresos")) {
      $("#contab-kpi-ingresos").textContent = formatCOP(resPeriodo.recaudos ?? resPeriodo.ingresos);
    }
    if ($("#contab-kpi-ingresos-sub")) {
      $("#contab-kpi-ingresos-sub").textContent = `${resPeriodo.countIngresos} registros · Efectivo: ${formatCOP(resPeriodo.ingresosEfectivo)} · Bancos: ${formatCOP(resPeriodo.ingresosBancos)}`;
    }

    if ($("#contab-kpi-gastos")) {
      $("#contab-kpi-gastos").textContent = formatCOP(resPeriodo.gastos);
    }
    if ($("#contab-kpi-gastos-sub")) {
      $("#contab-kpi-gastos-sub").textContent = `${resPeriodo.countGastos} registros · Gastos: ${formatCOP(resPeriodo.gastosOperativos)} · Compras: ${formatCOP(resPeriodo.comprasInventario)}`;
    }

    if ($("#contab-kpi-disponible")) {
      $("#contab-kpi-disponible").textContent = formatCOP(resGlobal.disponibleTotal ?? 0);
    }
    if ($("#contab-kpi-disponible-sub")) {
      $("#contab-kpi-disponible-sub").textContent = `Caja: ${formatCOP(resGlobal.disponibleCaja ?? 0)} · Bancos/Digital: ${formatCOP(resGlobal.disponibleBancos ?? 0)}`;
    }

    if ($("#contab-kpi-por-cobrar")) {
      $("#contab-kpi-por-cobrar").textContent = formatCOP(resGlobal.porCobrar ?? resGlobal.cuentasPorCobrar ?? 0);
    }
    if ($("#contab-kpi-por-cobrar-sub")) {
      const cntPend = ventas.filter((v) => v.estado !== "Anulada" && calcularSaldoPendienteVenta(v) > 0).length;
      $("#contab-kpi-por-cobrar-sub").textContent = cntPend > 0
        ? `${cntPend} ${cntPend === 1 ? "venta con saldo pendiente" : "ventas con saldo pendiente"}`
        : "Clientes con saldo pendiente";
    }

    renderMovimientosRecientes();
    renderCarteraContable();
    renderCajaYBancos(resGlobal);
    renderCuentasPorPagar();

    // Tabla limpia de 7 columnas (máximo 12 filas en la vista Movimientos)
    const tbody = $("#contab-table-body");
    if (!tbody) return;

    const filtrados = filtrarMovimientosContables(movimientos, {
      tipo: $("#contab-filter-tipo")?.value || "Todos",
      metodoPago: $("#contab-filter-metodo")?.value || "Todos",
      desde,
      hasta,
      busqueda: $("#contab-search")?.value || ""
    });
    ultimosFiltrados = filtrados;

    if ($("#contab-history-count")) {
      $("#contab-history-count").textContent = `${filtrados.length} movimientos encontrados`;
    }
    if ($("#contab-ver-todo-count")) {
      $("#contab-ver-todo-count").textContent = String(filtrados.length);
    }
    if ($("#contab-inferior-count")) {
      $("#contab-inferior-count").textContent = String(filtrados.length);
    }

    const visibles = filtrados.slice(0, 12);
    const footer = $("#contab-tabla-footer");
    if (footer) {
      const hayMas = filtrados.length > 12;
      footer.classList.toggle("hidden", !hayMas);
      if ($("#contab-tabla-footer-texto")) {
        $("#contab-tabla-footer-texto").textContent = `Mostrando ${visibles.length} de ${filtrados.length} movimientos`;
      }
    }

    tbody.innerHTML = visibles.length
      ? visibles.map((m) => renderFilaMovimientoHTML(m)).join("")
      : `<tr><td colspan="7" style="text-align:center; padding:1.75rem; font-size:1rem" class="text-muted">No se encontraron movimientos con los filtros seleccionados.</td></tr>`;

    if ($("#modal-contabilidad-completo")?.classList.contains("is-open")) {
      renderModalContabilidadCompleto();
    }
  }

  // Botones rápidos de filtro en el Historial (Todos, Ingresos, Gastos, Efectivo, Transferencias)
  root.querySelectorAll("#contab-quick-filter-bar [data-qfilter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      root.querySelectorAll("#contab-quick-filter-bar [data-qfilter]").forEach((b) =>
        b.classList.toggle("active", b === btn)
      );
      const { tipo, metodoPago } = resolverFiltrosRapidos(btn.dataset.qfilter);
      if ($("#contab-filter-tipo")) $("#contab-filter-tipo").value = tipo;
      if ($("#contab-filter-metodo")) $("#contab-filter-metodo").value = metodoPago;
      renderContabilidad();
    });
  });

  $("#btn-ver-todo-contabilidad")?.addEventListener("click", abrirModalContabilidadCompleto);
  $("#btn-ver-contabilidad-inferior")?.addEventListener("click", abrirModalContabilidadCompleto);
  root.querySelectorAll('[data-close-modal="modal-contabilidad-completo"]').forEach((btn) =>
    btn.addEventListener("click", () => $("#modal-contabilidad-completo")?.classList.remove("is-open"))
  );
  $("#buscar-contabilidad-modal")?.addEventListener("input", renderModalContabilidadCompleto);
  ["#modal-contab-desde", "#modal-contab-hasta"].forEach((sel) => {
    $(sel)?.addEventListener("input", renderModalContabilidadCompleto);
    $(sel)?.addEventListener("change", renderModalContabilidadCompleto);
  });
  ["#contab-filter-desde", "#contab-filter-hasta"].forEach((sel) => {
    $(sel)?.addEventListener("input", renderContabilidad);
    $(sel)?.addEventListener("change", renderContabilidad);
  });
  $("#btn-limpiar-filtros-contable")?.addEventListener("click", () => {
    if ($("#contab-search")) $("#contab-search").value = "";
    if ($("#contab-filter-desde")) $("#contab-filter-desde").value = "";
    if ($("#contab-filter-hasta")) $("#contab-filter-hasta").value = "";
    if ($("#contab-filter-tipo")) $("#contab-filter-tipo").value = "Todos";
    if ($("#contab-filter-metodo")) $("#contab-filter-metodo").value = "Todos";
    if ($("#contab-periodo-resumen")) $("#contab-periodo-resumen").value = "todos";
    root.querySelectorAll("#contab-quick-filter-bar [data-qfilter]").forEach((b) =>
      b.classList.toggle("active", b.dataset.qfilter === "Todos")
    );
    renderContabilidad();
  });
  root.querySelectorAll("[data-modal-contab-qfilter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      modalQFilter = btn.dataset.modalContabQfilter || "Todos";
      root.querySelectorAll("[data-modal-contab-qfilter]").forEach((b) =>
        b.classList.toggle("active", b === btn)
      );
      renderModalContabilidadCompleto();
    });
  });

  // Modal de detalle completo y corrección/reversión autorizada (Modo Claro y Modo Oscuro)
  function abrirModalDetalleMovimiento(mov) {
    const modal = $("#modal-detalle-contable");
    const body = $("#detalle-contable-contenido");
    const revBox = $("#detalle-contable-reversion-box");
    if (!modal || !body) return;

    movimientoDetalleActualId = mov.id;
    const revertido = Boolean(mov.anulado || mov.estado === "Revertido");
    const estadoTxt = revertido ? "Revertido" : mov.estado || "Confirmado";

    body.innerHTML = `
      <div style="display:grid;gap:.55rem;background:var(--bg-subtle);padding:1rem 1.15rem;border-radius:var(--radius-sm);border:1px solid var(--border-color)">
        <div class="flex justify-between gap-2"><span>Identificador:</span><b>${escapeHtml(mov.id)}</b></div>
        <div class="flex justify-between gap-2"><span>Tipo de movimiento:</span><b>${escapeHtml(mov.tipo)}</b></div>
        <div class="flex justify-between gap-2"><span>Categoría:</span><b>${escapeHtml(mov.categoria)}</b></div>
        <div class="flex justify-between gap-2"><span>Concepto:</span><b>${escapeHtml(mov.concepto)}</b></div>
        <div class="flex justify-between gap-2"><span>Valor en pesos:</span><b class="num" style="font-size:1.15rem">${formatCOP(mov.valor ?? mov.monto)}</b></div>
        <div class="flex justify-between gap-2"><span>Fecha del movimiento:</span><span>${escapeHtml(mov.fechaEfectiva || formatShortDate(mov.fecha))}</span></div>
        <div class="flex justify-between gap-2"><span>Fecha y hora de registro:</span><span>${formatDateTime(mov.fechaRegistro || mov.fecha)}</span></div>
        <div class="flex justify-between gap-2"><span>Método de pago:</span><span><b>${escapeHtml(mov.metodoPago || "Efectivo")}</b> (${mov.afectaCajaFisica ? "Afectó efectivo de caja" : "No afectó efectivo de caja"})</span></div>
        ${mov.clienteRelacionado ? `<div class="flex justify-between gap-2"><span>Cliente:</span><span>${escapeHtml(mov.clienteRelacionado)}</span></div>` : ""}
        ${mov.proveedor ? `<div class="flex justify-between gap-2"><span>Proveedor:</span><span>${escapeHtml(mov.proveedor)}</span></div>` : ""}
        ${mov.pedidoRelacionado ? `<div class="flex justify-between gap-2"><span>Pedido relacionado:</span><span>${escapeHtml(mov.pedidoRelacionado)}${mov.saldoPendientePedido > 0 ? ` (Saldo pendiente: ${formatCOP(mov.saldoPendientePedido)})` : ""}</span></div>` : ""}
        <div class="flex justify-between gap-2"><span>Comprobante / Referencia:</span><span>${escapeHtml(mov.referencia || mov.soporteReferencia || mov.numeroVenta || "—")}</span></div>
        <div class="flex justify-between gap-2"><span>Responsable:</span><span>${escapeHtml(mov.responsable || mov.usuario || "—")}</span></div>
        <div class="flex justify-between gap-2"><span>Estado:</span><span class="badge ${revertido ? "badge-danger" : "badge-success"}">${escapeHtml(estadoTxt)}</span></div>
        <div class="flex justify-between gap-2"><span>Observaciones:</span><span>${escapeHtml(mov.observaciones || mov.nota || "Sin observaciones")}</span></div>
        ${
          revertido
            ? `
              <div class="flex justify-between gap-2"><span>Motivo de reversión:</span><b class="text-danger">${escapeHtml(mov.motivoReversion || "Ajuste autorizado")}</b></div>
              <div class="flex justify-between gap-2"><span>Revertido por:</span><span>${escapeHtml(mov.revertidoPor || "Administrador")} (${formatDateTime(mov.fechaReversion)})</span></div>
            `
            : ""
        }
      </div>
    `;

    const puedeRevertir =
      hasPermission("contabilidad.revertir", getCurrentUser()) &&
      !revertido &&
      mov.origen !== "Venta POS";

    if (revBox) {
      revBox.style.display = puedeRevertir ? "block" : "none";
      if ($("#rev-contable-motivo")) $("#rev-contable-motivo").value = "";
    }

    modal.classList.add("is-open");
  }

  function cerrarModalDetalle() {
    const modal = $("#modal-detalle-contable");
    if (modal) modal.classList.remove("is-open");
    movimientoDetalleActualId = null;
  }

  $("#btn-cerrar-detalle-contable")?.addEventListener("click", cerrarModalDetalle);
  $("#btn-cerrar-detalle-contable-2")?.addEventListener("click", cerrarModalDetalle);

  $("#contab-search")?.addEventListener("input", renderContabilidad);

  function manejarClickDetalleContable(e) {
    const btn = e.target.closest("[data-ver-detalle-cont]");
    if (!btn) return;
    const mov = movimientos.find((m) => m.id === btn.dataset.verDetalleCont);
    if (mov) abrirModalDetalleMovimiento(mov);
  }
  $("#contab-table-body")?.addEventListener("click", manejarClickDetalleContable);
  $("#contab-table-body-modal")?.addEventListener("click", manejarClickDetalleContable);
  $("#contab-recientes-list")?.addEventListener("click", manejarClickDetalleContable);
  $("#contab-bancos-body")?.addEventListener("click", manejarClickDetalleContable);

  // Cartera: abrir modal de abono y registrar abono
  $("#contab-cartera-body")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-abono-venta]");
    if (!btn) return;
    const venta = ventas.find((v) => v.id === btn.dataset.abonoVenta);
    if (!venta) return;
    const saldo = calcularSaldoPendienteVenta(venta);
    if ($("#abono-cartera-venta-id")) $("#abono-cartera-venta-id").value = venta.id;
    if ($("#abono-cartera-monto")) $("#abono-cartera-monto").value = formatMontoInput(saldo);
    if ($("#abono-cartera-ref")) $("#abono-cartera-ref").value = "";
    if ($("#abono-cartera-resumen")) {
      $("#abono-cartera-resumen").innerHTML = `
        <div><strong>Cliente:</strong> ${escapeHtml(venta.cliente?.nombre || "Consumidor Final")}</div>
        <div><strong>Venta:</strong> ${escapeHtml(venta.numero || venta.id)}</div>
        <div><strong>Saldo pendiente:</strong> <b class="text-danger">${formatCOP(saldo)}</b></div>
      `;
    }
    $("#modal-abono-cartera")?.classList.add("is-open");
  });

  $("#form-abono-cartera")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ventaId = $("#abono-cartera-venta-id")?.value;
    const monto = parseMontoInput($("#abono-cartera-monto")?.value);
    const metodoPago = $("#abono-cartera-metodo")?.value || "Efectivo";
    const referencia = $("#abono-cartera-ref")?.value || "";
    try {
      await registrarAbonoVenta({ ventaId, monto, metodoPago, referencia }, getCurrentUser());
      $("#modal-abono-cartera")?.classList.remove("is-open");
      showFeedback(`Abono de ${formatCOP(monto)} registrado correctamente.`);
    } catch (err) {
      showFeedback(err.message, true);
    }
  });

  // Cuentas por pagar: abrir modal de pago a proveedor y liquidar
  $("#contab-cxp-body")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pagar-cxp]");
    if (!btn) return;
    const mov = movimientos.find((m) => m.id === btn.dataset.pagarCxp);
    if (!mov) return;
    if ($("#cxp-mov-id")) $("#cxp-mov-id").value = mov.id;
    if ($("#cxp-fecha")) $("#cxp-fecha").value = hoyIso;
    if ($("#cxp-ref")) $("#cxp-ref").value = mov.referencia || "";
    if ($("#cxp-resumen-box")) {
      $("#cxp-resumen-box").innerHTML = `
        <div><strong>Proveedor:</strong> ${escapeHtml(mov.proveedor || "No especificado")}</div>
        <div><strong>Concepto:</strong> ${escapeHtml(mov.concepto || "—")}</div>
        <div><strong>Valor a pagar:</strong> <b class="text-danger">${formatCOP(mov.valor ?? mov.monto)}</b></div>
      `;
    }
    $("#modal-pagar-cxp")?.classList.add("is-open");
  });

  $("#form-pagar-cxp")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const movimientoId = $("#cxp-mov-id")?.value;
    const metodoPago = $("#cxp-metodo")?.value || "Efectivo";
    const fecha = $("#cxp-fecha")?.value || hoyIso;
    const referencia = $("#cxp-ref")?.value || "";
    try {
      const pagado = await pagarCuentaPorPagar({ movimientoId, metodoPago, fecha, referencia }, getCurrentUser());
      $("#modal-pagar-cxp")?.classList.remove("is-open");
      showFeedback(`Pago a proveedor registrado (${pagado.concepto} por ${formatCOP(pagado.monto)}).`);
    } catch (err) {
      showFeedback(err.message, true);
    }
  });

  $("#btn-confirmar-reversion-contable")?.addEventListener("click", async () => {
    if (!movimientoDetalleActualId) return;
    try {
      const motivo = $("#rev-contable-motivo")?.value;
      const rev = await revertirMovimientoContable(
        { movimientoId: movimientoDetalleActualId, motivo },
        getCurrentUser()
      );
      cerrarModalDetalle();
      showFeedback(`El movimiento "${rev.concepto}" fue marcado como Revertido conservando el historial.`);
    } catch (err) {
      showFeedback(err.message, true);
    }
  });

  // Formulario 1: Guardar Ingreso con Confirmación Previa
  $("#form-ingreso-contable")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const concepto = String($("#ing-concepto")?.value || "").trim();
    const categoria = $("#ing-categoria")?.value || "Otros ingresos";
    const montoNum = parseMontoInput($("#ing-monto")?.value);
    const fechaEfectiva = $("#ing-fecha")?.value || hoyIso;
    const metodoPago = $("#ing-metodo")?.value || "Efectivo";

    if (!concepto) {
      showFeedback("Por favor escriba el concepto indicando de dónde viene el dinero.", true);
      $("#ing-concepto")?.focus();
      return;
    }
    if (!(montoNum > 0)) {
      showFeedback("Por favor escriba un valor en pesos mayor que cero.", true);
      $("#ing-monto")?.focus();
      return;
    }

    solicitarConfirmacion({
      pregunta: `¿Desea registrar este ingreso por ${formatCOP(montoNum)}?`,
      detallesHtml: `
        <div><strong>Concepto:</strong> ${escapeHtml(concepto)}</div>
        <div><strong>Categoría:</strong> ${escapeHtml(categoria)}</div>
        <div><strong>Método de pago:</strong> ${escapeHtml(metodoPago)}</div>
        <div><strong>Fecha:</strong> ${escapeHtml(fechaEfectiva)}</div>
      `,
      textoBoton: "Sí, registrar",
      claseBoton: "btn-success",
      onConfirm: async () => {
        try {
          const mov = await registrarMovimientoContable(
            {
              tipo: TIPOS_CONTABLE.INGRESO,
              concepto,
              categoria,
              monto: montoNum,
              fechaEfectiva,
              metodoPago,
              afectaCajaFisica: Boolean($("#ing-afecta-caja")?.checked),
              observaciones: $("#ing-nota")?.value || ""
            },
            getCurrentUser()
          );
          $("#form-ingreso-contable").reset();
          if ($("#ing-fecha")) $("#ing-fecha").value = hoyIso;
          if ($("#ing-responsable")) $("#ing-responsable").value = currentUser.name || currentUser.email;
          sincronizarVisibilidadCajaEfectivo();
          $("#modal-nuevo-mov-contable")?.classList.remove("is-open");
          showFeedback(`El ingreso se registró correctamente (${mov.concepto} por ${formatCOP(mov.monto)}).`);
        } catch (err) {
          showFeedback(err.message, true);
        }
      }
    });
  });

  // Formulario 2: Guardar Gasto con Confirmación Previa
  $("#form-gasto-contable")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const concepto = String($("#gas-concepto")?.value || "").trim();
    const categoria = $("#gas-categoria")?.value || "Otros gastos";
    const montoNum = parseMontoInput($("#gas-monto")?.value);
    const fechaEfectiva = $("#gas-fecha")?.value || hoyIso;
    const metodoPago = $("#gas-metodo")?.value || "Efectivo";
    const estadoPago = $("#gas-estado-pago")?.value || "Pagado";
    const proveedor = String($("#gas-proveedor")?.value || "").trim();

    if (!concepto) {
      showFeedback("Por favor escriba el concepto indicando en qué se gastó el dinero.", true);
      $("#gas-concepto")?.focus();
      return;
    }
    if (!(montoNum > 0)) {
      showFeedback("Por favor escriba un valor del gasto mayor que cero.", true);
      $("#gas-monto")?.focus();
      return;
    }

    solicitarConfirmacion({
      pregunta: `¿Desea registrar este gasto por ${formatCOP(montoNum)}?`,
      detallesHtml: `
        <div><strong>Concepto del gasto:</strong> ${escapeHtml(concepto)}</div>
        <div><strong>Categoría:</strong> ${escapeHtml(categoria)}</div>
        <div><strong>Estado del pago:</strong> ${escapeHtml(estadoPago === "Pendiente" ? "Pendiente por pagar (Cuenta por pagar)" : "Pagado")}</div>
        <div><strong>Método de pago:</strong> ${escapeHtml(metodoPago)}</div>
        ${proveedor ? `<div><strong>Proveedor:</strong> ${escapeHtml(proveedor)}</div>` : ""}
        <div><strong>Fecha:</strong> ${escapeHtml(fechaEfectiva)}</div>
      `,
      textoBoton: "Sí, registrar",
      claseBoton: "btn-danger",
      onConfirm: async () => {
        try {
          await registrarMovimientoContable(
            {
              tipo: TIPOS_CONTABLE.GASTO,
              concepto,
              categoria,
              monto: montoNum,
              fechaEfectiva,
              metodoPago,
              estadoPago,
              proveedor,
              afectaCajaFisica: estadoPago === "Pagado" && Boolean($("#gas-afecta-caja")?.checked),
              observaciones: $("#gas-nota")?.value || ""
            },
            getCurrentUser()
          );
          $("#form-gasto-contable").reset();
          if ($("#gas-fecha")) $("#gas-fecha").value = hoyIso;
          if ($("#gas-responsable")) $("#gas-responsable").value = currentUser.name || currentUser.email;
          sincronizarVisibilidadCajaEfectivo();
          $("#modal-nuevo-mov-contable")?.classList.remove("is-open");
          showFeedback(
            estadoPago === "Pendiente"
              ? "Cuenta por pagar a proveedor registrada correctamente."
              : "El gasto se registró correctamente."
          );
        } catch (err) {
          showFeedback(err.message, true);
        }
      }
    });
  });

  // Formulario 3: Guardar Traslado Interno con Confirmación Previa
  $("#form-traslado-contable")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const cuentaOrigen = $("#tras-origen")?.value || "Caja física";
    const cuentaDestino = $("#tras-destino")?.value || "Cuenta bancaria";
    const montoNum = parseMontoInput($("#tras-monto")?.value);
    const fecha = $("#tras-fecha")?.value || hoyIso;

    if (cuentaOrigen === cuentaDestino) {
      showFeedback("La cuenta de donde sale el dinero y la cuenta a donde entra deben ser diferentes.", true);
      return;
    }
    if (!(montoNum > 0)) {
      showFeedback("Por favor escriba un valor a trasladar mayor que cero.", true);
      $("#tras-monto")?.focus();
      return;
    }

    solicitarConfirmacion({
      pregunta: `¿Desea registrar este traslado por ${formatCOP(montoNum)}?`,
      detallesHtml: `
        <div><strong>Sale de:</strong> ${escapeHtml(cuentaOrigen)}</div>
        <div><strong>Entra a:</strong> ${escapeHtml(cuentaDestino)}</div>
        <div><strong>Fecha:</strong> ${escapeHtml(fecha)}</div>
      `,
      textoBoton: "Sí, registrar",
      claseBoton: "btn-primary",
      onConfirm: async () => {
        try {
          const tr = await registrarTrasladoInterno(
            {
              cuentaOrigen,
              cuentaDestino,
              monto: montoNum,
              fecha,
              observaciones: $("#tras-nota")?.value || "",
              afectaCajaFisica: true
            },
            getCurrentUser()
          );
          $("#form-traslado-contable").reset();
          if ($("#tras-fecha")) $("#tras-fecha").value = hoyIso;
          $("#modal-nuevo-mov-contable")?.classList.remove("is-open");
          showFeedback(`El traslado entre cuentas se registró correctamente (${tr.concepto} por ${formatCOP(tr.monto)}).`);
        } catch (err) {
          showFeedback(err.message, true);
        }
      }
    });
  });

  // Exportar CSV e Imprimir
  $("#btn-exportar-contable-csv")?.addEventListener("click", () => {
    const csv = exportarContabilidadCSV(ultimosFiltrados);
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `contabilidad-movimientos-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  $("#btn-imprimir-contable")?.addEventListener("click", () => {
    window.print();
  });

  const u1 = watchMovimientosContables((lista) => {
    movimientos = lista;
    renderContabilidad();
  });
  const u2 = watchCajas(({ cajaAbierta: c }) => {
    cajaAbierta = c;
    renderContabilidad();
  });
  const u3 = watchVentas((lista) => {
    ventas = lista;
    renderContabilidad();
  });

  return () => {
    u1();
    u2();
    u3();
  };
}

// ---------------------------------------------------------------------------
// 3. VISTA DE DASHBOARD OPERATIVO EN TIEMPO REAL (Sección 5)
// ---------------------------------------------------------------------------
export function mountDashboardView(root) {
  const $ = (sel) => root.querySelector(sel);
  let productos = [];
  let ventas = [];
  let cajaAbierta = null;
  let movsContables = [];
  let periodoActual = "hoy";

  const ETIQUETAS_PERIODO = {
    hoy: "Hoy",
    semana: "Esta semana",
    mes: "Este mes"
  };

  function setTxt(sel, val) {
    const el = $(sel);
    if (el) el.textContent = val;
  }

  function fechaEnRango(iso, desde, hasta) {
    const d = String(iso || "").slice(0, 10);
    if (!d) return false;
    if (desde && d < desde) return false;
    if (hasta && d > hasta) return false;
    return true;
  }

  function renderGraficaVentas(ventasPeriodo, desde, hasta) {
    const wrap = $("#dash-chart-wrap");
    if (!wrap) return;

    if (!ventasPeriodo.length) {
      wrap.innerHTML = `<div class="dash-chart-empty">No hay ventas registradas en este período</div>`;
      return;
    }

    // Construir puntos según el período
    let puntos = [];
    if (periodoActual === "hoy") {
      const porHora = new Map();
      ventasPeriodo
        .slice()
        .sort((a, b) => String(a.fecha || "").localeCompare(String(b.fecha || "")))
        .forEach((v) => {
          const dt = new Date(v.fecha);
          const hora = Number.isNaN(dt.getTime())
            ? "Hoy"
            : `${String(dt.getHours()).padStart(2, "0")}:00`;
          const cur = porHora.get(hora) || { label: hora, total: 0, count: 0 };
          cur.total = roundCOP(cur.total + roundCOP(v.total));
          cur.count += 1;
          porHora.set(hora, cur);
        });
      puntos = [...porHora.values()];
    } else {
      const porDia = new Map();
      ventasPeriodo.forEach((v) => {
        const iso = String(v.fecha || "").slice(0, 10);
        if (!iso) return;
        const cur = porDia.get(iso) || { iso, label: `${iso.slice(8, 10)}/${iso.slice(5, 7)}`, total: 0, count: 0 };
        cur.total = roundCOP(cur.total + roundCOP(v.total));
        cur.count += 1;
        porDia.set(iso, cur);
      });
      puntos = [...porDia.values()].sort((a, b) => a.iso.localeCompare(b.iso));
    }

    const W = 640;
    const H = 230;
    const padL = 58;
    const padR = 18;
    const padT = 22;
    const padB = 34;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxVal = Math.max(1, ...puntos.map((p) => p.total));
    const step = plotW / Math.max(1, puntos.length);
    const barW = Math.min(44, Math.max(14, step * 0.56));

    const gridLines = [0, 0.5, 1].map((f) => {
      const y = padT + plotH * (1 - f);
      const val = roundCOP(maxVal * f);
      return `
        <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--border-color)" stroke-dasharray="3 3" />
        <text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--text-secondary)" font-size="11">${val >= 1000 ? `$${Math.round(val / 1000)}k` : `$${val}`}</text>
      `;
    }).join("");

    const bars = puntos.map((p, idx) => {
      const xCenter = padL + step * idx + step / 2;
      const h = Math.max(4, (p.total / maxVal) * plotH);
      const y = padT + plotH - h;
      const x = xCenter - barW / 2;
      const mostrarLabel = puntos.length <= 12 || idx % Math.ceil(puntos.length / 8) === 0 || idx === puntos.length - 1;
      const tooltipTxt = `${p.label}: ${formatCOP(p.total)} (${p.count} ${p.count === 1 ? "venta" : "ventas"})`;
      return `
        <g class="dash-bar-group">
          <title>${escapeHtml(tooltipTxt)}</title>
          <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="6" fill="var(--accent)" opacity="0.9" />
          ${puntos.length <= 8 ? `<text x="${xCenter.toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" fill="var(--text-primary)" font-size="10.5" font-weight="700">${p.total >= 1000 ? `$${Math.round(p.total / 1000)}k` : formatCOP(p.total)}</text>` : ""}
          ${mostrarLabel ? `<text x="${xCenter.toFixed(1)}" y="${H - 12}" text-anchor="middle" fill="var(--text-secondary)" font-size="11">${escapeHtml(p.label)}</text>` : ""}
        </g>
      `;
    }).join("");

    wrap.innerHTML = `
      <svg id="dash-chart-ventas" class="dash-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución de ventas">
        ${gridLines}
        ${bars}
      </svg>
    `;
  }

  function renderAlertas(user, totalPorCobrar, ventasPorCobrarCount) {
    const listEl = $("#dash-alertas-list");
    const badgeEl = $("#dash-alertas-badge");
    if (!listEl) return;

    const alertas = [];
    const alertasInv = obtenerAlertasInventario(productos);
    const puedeInv = canAccessRoute("inventario", user);
    const puedeCont = canAccessRoute("contabilidad", user);
    const puedeCaja = canAccessRoute("caja", user);

    if (alertasInv.agotados.length > 0) {
      const nombres = alertasInv.agotados.slice(0, 2).map((p) => p.nombre).join(", ");
      const extra = alertasInv.agotados.length > 2 ? ` y ${alertasInv.agotados.length - 2} más` : "";
      alertas.push({
        clase: "alert-item-danger",
        titulo: `${alertasInv.agotados.length} ${alertasInv.agotados.length === 1 ? "producto agotado" : "productos agotados"}`,
        detalle: `${nombres}${extra}.`,
        ruta: puedeInv ? "inventario" : null,
        btnTexto: "Ver Inventario"
      });
    }

    if (alertasInv.stockBajo.length > 0) {
      const nombres = alertasInv.stockBajo.slice(0, 2).map((p) => p.nombre).join(", ");
      const extra = alertasInv.stockBajo.length > 2 ? ` y ${alertasInv.stockBajo.length - 2} más` : "";
      alertas.push({
        clase: "alert-item-warning",
        titulo: `${alertasInv.stockBajo.length} ${alertasInv.stockBajo.length === 1 ? "producto con stock bajo" : "productos con stock bajo"}`,
        detalle: `${nombres}${extra}.`,
        ruta: puedeInv ? "inventario" : null,
        btnTexto: "Ver Inventario"
      });
    }

    if (totalPorCobrar > 0) {
      alertas.push({
        clase: "alert-item-warning",
        titulo: "Cuentas por cobrar pendientes",
        detalle: `${ventasPorCobrarCount} ${ventasPorCobrarCount === 1 ? "venta" : "ventas"} con saldo pendiente por ${formatCOP(totalPorCobrar)}.`,
        ruta: puedeCont ? "contabilidad" : null,
        btnTexto: "Ver Contabilidad"
      });
    }

    if (!cajaAbierta) {
      alertas.push({
        clase: "alert-item-warning",
        titulo: "Turno de caja cerrado",
        detalle: "Abre un turno de caja para registrar ventas en mostrador.",
        ruta: puedeCaja ? "caja" : null,
        btnTexto: "Ir a Caja"
      });
    }

    const visibles = alertas.slice(0, 3);
    if (badgeEl) {
      badgeEl.textContent = `${visibles.length} ${visibles.length === 1 ? "alerta" : "alertas"}`;
      badgeEl.className = `badge ${visibles.some((a) => a.clase === "alert-item-danger") ? "badge-danger" : visibles.length > 0 ? "badge-warning" : "badge-success"}`;
    }

    if (!visibles.length) {
      listEl.innerHTML = `<div class="dash-alert-ok">✓ Todo está en orden. No hay alertas pendientes en este momento.</div>`;
      return;
    }

    listEl.innerHTML = visibles
      .map(
        (a) => `
          <div class="dash-alert-item ${a.clase}">
            <div>
              <strong>${escapeHtml(a.titulo)}</strong>
              <p>${escapeHtml(a.detalle)}</p>
            </div>
            ${
              a.ruta
                ? `<a class="btn btn-outline btn-sm" href="${escapeHtml(a.ruta)}.html" data-route="${escapeHtml(a.ruta)}">${escapeHtml(a.btnTexto)}</a>`
                : ""
            }
          </div>
        `
      )
      .join("");
  }

  function renderActividadReciente() {
    const tbody = $("#dash-actividad-body");
    if (!tbody) return;

    const opsVentas = ventas.map((v) => {
      const anulada = v.estado === "Anulada";
      const cantItems = Array.isArray(v.items) ? v.items.length : 0;
      return {
        fecha: v.fecha || "",
        tipo: anulada ? "Anulada" : "Venta",
        badgeCls: anulada ? "badge-danger" : "badge-success",
        desc: `Venta ${v.numero || ""} · Cliente: ${v.clienteNombre || "Mostrador"}${cantItems ? ` (${cantItems} prod.)` : ""}`,
        valorTxt: `${anulada ? "" : "+ "}${formatCOP(v.total)}`,
        valorCls: anulada ? "text-muted" : "text-success"
      };
    });

    const opsContables = movsContables
      .filter((m) => m.origen !== "Venta POS" && !m.anulado && m.estado !== "Revertido")
      .map((m) => {
        const esIng = m.tipo === TIPOS_CONTABLE.INGRESO;
        const esGas = m.tipo === TIPOS_CONTABLE.GASTO;
        return {
          fecha: m.fechaRegistro || m.fechaEfectiva || m.fecha || "",
          tipo: esIng ? "Ingreso" : esGas ? "Gasto" : "Traslado",
          badgeCls: esIng ? "badge-success" : esGas ? "badge-danger" : "badge-warning",
          desc: m.concepto || m.categoria || "Movimiento contable",
          valorTxt: `${esIng ? "+ " : esGas ? "− " : "⇄ "}${formatCOP(m.valor ?? m.monto)}`,
          valorCls: esIng ? "text-success" : esGas ? "text-danger" : ""
        };
      });

    const recientes = [...opsVentas, ...opsContables]
      .sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")))
      .slice(0, 5);

    tbody.innerHTML = recientes.length
      ? recientes
          .map(
            (op) => `
              <tr>
                <td style="white-space:nowrap">${formatDateTime(op.fecha)}</td>
                <td><span class="badge ${op.badgeCls}">${escapeHtml(op.tipo)}</span></td>
                <td>${escapeHtml(op.desc)}</td>
                <td class="text-right num ${op.valorCls}" style="white-space:nowrap"><b>${escapeHtml(op.valorTxt)}</b></td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="4" class="text-muted" style="text-align:center; padding:1.25rem">Aún no hay operaciones registradas.</td></tr>`;
  }

  function renderDashboard() {
    const user = getCurrentUser();
    const { desde, hasta } = obtenerRangoPeriodo(periodoActual);
    const etiquetaPer = ETIQUETAS_PERIODO[periodoActual] || "Hoy";
    setTxt("#dash-subtitulo-fecha", `Período activo: ${etiquetaPer}`);
    setTxt("#dash-grafica-badge", etiquetaPer);

    const ventasActivas = ventas.filter((v) => v.estado !== "Anulada");
    const ventasPeriodo = ventasActivas.filter((v) => fechaEnRango(v.fecha, desde, hasta));

    // 1. Ventas del período
    const totalVentasPer = ventasPeriodo.reduce((s, v) => s + roundCOP(v.total), 0);
    setTxt("#dash-kpi-ventas", formatCOP(totalVentasPer));
    setTxt(
      "#dash-kpi-ventas-sub",
      `${ventasPeriodo.length} ${ventasPeriodo.length === 1 ? "venta registrada" : "ventas registradas"}`
    );

    // 2. Dinero efectivamente recibido (pagado en ventas del período + ingresos contables manuales sin duplicar Venta POS)
    let recibidoEf = 0;
    let recibidoBan = 0;
    let totalRecibido = 0;

    ventasPeriodo.forEach((v) => {
      const pagado = Math.max(0, roundCOP(v.total) - calcularSaldoPendienteVenta(v));
      totalRecibido = roundCOP(totalRecibido + pagado);
      if (Array.isArray(v.pagos) && v.pagos.length) {
        let sumaEfVenta = 0;
        let sumaBanVenta = 0;
        v.pagos.forEach((p) => {
          if (p.metodo === "Saldo a favor") return;
          const mto = roundCOP(p.importeNeto ?? p.importe ?? 0);
          if ((p.metodo || "Efectivo") === "Efectivo") sumaEfVenta += mto;
          else sumaBanVenta += mto;
        });
        const dif = pagado - (sumaEfVenta + sumaBanVenta);
        recibidoEf = roundCOP(recibidoEf + Math.max(0, sumaEfVenta + (dif > 0 && sumaBanVenta === 0 ? dif : 0)));
        recibidoBan = roundCOP(recibidoBan + sumaBanVenta);
      } else if ((v.metodoPago || "Efectivo") === "Efectivo") {
        recibidoEf = roundCOP(recibidoEf + pagado);
      } else {
        recibidoBan = roundCOP(recibidoBan + pagado);
      }
    });

    const ingresosManuales = movsContables.filter(
      (m) =>
        m.tipo === TIPOS_CONTABLE.INGRESO &&
        !m.anulado &&
        m.estado !== "Revertido" &&
        m.origen !== "Venta POS" &&
        fechaEnRango(m.fechaEfectiva || m.fecha, desde, hasta)
    );
    ingresosManuales.forEach((m) => {
      const val = roundCOP(m.valor ?? m.monto);
      totalRecibido = roundCOP(totalRecibido + val);
      if ((m.metodoPago || "Efectivo") === "Efectivo") {
        recibidoEf = roundCOP(recibidoEf + val);
      } else {
        recibidoBan = roundCOP(recibidoBan + val);
      }
    });

    setTxt("#dash-kpi-recibido", formatCOP(totalRecibido));
    setTxt("#dash-kpi-recibido-sub", `Efectivo: ${formatCOP(recibidoEf)} · Bancos: ${formatCOP(recibidoBan)}`);

    // 3. Cuentas por cobrar reales
    const ventasPorCobrar = ventasActivas.filter((v) => calcularSaldoPendienteVenta(v) > 0);
    const totalPorCobrar = ventasPorCobrar.reduce((s, v) => s + calcularSaldoPendienteVenta(v), 0);
    setTxt("#dash-kpi-por-cobrar", formatCOP(totalPorCobrar));
    setTxt(
      "#dash-kpi-por-cobrar-sub",
      totalPorCobrar > 0
        ? `${ventasPorCobrar.length} ${ventasPorCobrar.length === 1 ? "venta con saldo pendiente" : "ventas con saldo pendiente"}`
        : "Sin saldos pendientes"
    );

    renderGraficaVentas(ventasPeriodo, desde, hasta);
    renderAlertas(user, totalPorCobrar, ventasPorCobrar.length);
    renderActividadReciente();
  }

  root.querySelectorAll("[data-dash-periodo]").forEach((btn) => {
    btn.addEventListener("click", () => {
      periodoActual = btn.dataset.dashPeriodo || "hoy";
      root.querySelectorAll("[data-dash-periodo]").forEach((b) => {
        const activo = b === btn;
        b.classList.toggle("btn-primary", activo);
        b.classList.toggle("btn-outline", !activo);
        b.classList.toggle("active", activo);
        b.setAttribute("aria-pressed", activo ? "true" : "false");
      });
      renderDashboard();
    });
  });

  const u1 = watchProductos((l) => { productos = l; renderDashboard(); });
  const u2 = watchVentas((l) => { ventas = l; renderDashboard(); });
  const u3 = watchCajas(({ cajaAbierta: c }) => { cajaAbierta = c; renderDashboard(); });
  const u4 = watchMovimientosContables((l) => { movsContables = l; renderDashboard(); });

  return () => { u1(); u2(); u3(); u4(); };
}

// ---------------------------------------------------------------------------
// 4. VISTA DE CONSULTAS Y LOS 11 REPORTES OBLIGATORIOS (Sección 9)
// ---------------------------------------------------------------------------
export function mountReportesView(root) {
  const $ = (sel) => root.querySelector(sel);
  let productos = [];
  let ventas = [];
  let cajas = [];
  let movsContables = [];
  let movsInventario = [];
  let ultimoConsolidado = null;
  const tablasReporteData = new Map();
  let modalTablaActualKey = null;

  function obtenerFiltrosActuales() {
    return {
      desde: $("#rep-desde")?.value || "",
      hasta: $("#rep-hasta")?.value || "",
      productoId: "Todos",
      categoria: "Todas",
      metodoPago: "Todos",
      estadoVenta: "Todos",
      usuario: "Todos"
    };
  }

  function renderModalReporteCompleto() {
    const tbodyModal = $("#modal-rep-tbody");
    const contadorEl = $("#modal-rep-contador");
    if (!tbodyModal || !modalTablaActualKey) return;
    const data = tablasReporteData.get(modalTablaActualKey);
    if (!data) return;

    const q = String($("#buscar-reporte-modal")?.value || "").trim().toLowerCase();
    const filtradas = q
      ? data.rowsHtml.filter((rowHtml) =>
          rowHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase().includes(q)
        )
      : data.rowsHtml;

    if (contadorEl) {
      contadorEl.textContent = `${filtradas.length} registro(s) encontrado(s)`;
    }
    tbodyModal.innerHTML = filtradas.length
      ? filtradas.join("")
      : `<tr><td colspan="${data.emptyColspan}" class="text-muted" style="text-align:center; padding:1.5rem">No se encontraron registros que coincidan con la búsqueda.</td></tr>`;
  }

  function abrirModalReporteCompleto(tablaKey) {
    const modal = $("#modal-reporte-completo");
    const data = tablasReporteData.get(tablaKey);
    if (!modal || !data) return;

    modalTablaActualKey = tablaKey;
    if ($("#modal-rep-titulo")) $("#modal-rep-titulo").textContent = `${data.titulo} — Todos los registros`;
    if ($("#modal-rep-thead")) $("#modal-rep-thead").innerHTML = data.theadHtml;
    if ($("#buscar-reporte-modal")) $("#buscar-reporte-modal").value = "";

    renderModalReporteCompleto();
    modal.classList.add("is-open");
    $("#buscar-reporte-modal")?.focus();
  }

  function cerrarModalReporteCompleto() {
    $("#modal-reporte-completo")?.classList.remove("is-open");
    modalTablaActualKey = null;
  }

  function renderTablaPaginada(tbodySel, rowsHtml, emptyColspan, emptyMsg, tablaKey) {
    const LIMITE_FILAS = 5;
    const tbody = $(tbodySel);
    if (!tbody) return;
    const card = tbody.closest(".card");
    const header = card?.querySelector(".card-header");
    const titulo = header?.querySelector("h3")?.textContent?.trim() || "Reporte";
    const theadHtml = tbody.closest("table")?.querySelector("thead")?.innerHTML || "";
    const total = rowsHtml.length;

    tablasReporteData.set(tablaKey, { titulo, theadHtml, rowsHtml, emptyColspan, emptyMsg });

    // Cabecera limpia: solo título h3 a la izquierda y botón Ver todo (total) a la derecha
    if (header) {
      header.querySelectorAll(".badge").forEach((b) => b.classList.add("hidden"));
      let headerBtn = header.querySelector(".rep-header-toggle");
      if (!headerBtn) {
        headerBtn = document.createElement("button");
        headerBtn.type = "button";
        header.appendChild(headerBtn);
      }
      delete headerBtn.dataset.repToggleTable;
      if (total > 0) {
        headerBtn.disabled = false;
        headerBtn.dataset.repOpenModal = tablaKey;
        headerBtn.className = "btn btn-primary btn-sm rep-header-toggle";
      } else {
        headerBtn.disabled = true;
        delete headerBtn.dataset.repOpenModal;
        headerBtn.className = "btn btn-outline btn-sm rep-header-toggle";
      }
      headerBtn.textContent = `Ver todo (${total})`;
    }

    if (!total) {
      tbody.innerHTML = `<tr><td colspan="${emptyColspan}" class="text-muted" style="text-align:center; padding:1.25rem">${escapeHtml(emptyMsg)}</td></tr>`;
      card?.querySelector(".rep-table-footer")?.remove();
      if (modalTablaActualKey === tablaKey && $("#modal-reporte-completo")?.classList.contains("is-open")) {
        renderModalReporteCompleto();
      }
      return;
    }

    const visibles = rowsHtml.slice(0, LIMITE_FILAS);
    tbody.innerHTML = visibles.join("");

    // Pie informativo discreto (sin botón repetido) únicamente cuando hay más de LIMITE_FILAS
    let footer = card?.querySelector(".rep-table-footer");
    if (total > LIMITE_FILAS) {
      if (!footer && card) {
        footer = document.createElement("div");
        footer.className = "card-footer rep-table-footer";
        card.appendChild(footer);
      }
      if (footer) {
        footer.innerHTML = `<span class="text-sm text-muted">Mostrando ${visibles.length} de ${total} registros</span>`;
      }
    } else if (footer) {
      footer.remove();
    }

    if (modalTablaActualKey === tablaKey && $("#modal-reporte-completo")?.classList.contains("is-open")) {
      renderModalReporteCompleto();
    }
  }

  function renderReportes() {
    const rep = generarReportesConsolidados(obtenerFiltrosActuales(), {
      productos,
      ventas,
      cajas,
      movsInventario,
      movsContables
    });
    ultimoConsolidado = rep;

    if ($("#rep-total-ventas")) $("#rep-total-ventas").textContent = formatCOP(rep.kpis.totalVentasPeriodo);
    if ($("#rep-note-ventas")) $("#rep-note-ventas").textContent = `${rep.kpis.cantidadVentasPeriodo} ventas efectivas`;
    if ($("#rep-total-ingresos")) $("#rep-total-ingresos").textContent = formatCOP(rep.kpis.ingresosPeriodo);
    if ($("#rep-note-ingresos")) $("#rep-note-ingresos").textContent = `${rep.kpis.countIngresosPeriodo} registros contables`;
    if ($("#rep-total-gastos")) $("#rep-total-gastos").textContent = formatCOP(rep.kpis.gastosPeriodo);
    if ($("#rep-note-gastos")) $("#rep-note-gastos").textContent = `${rep.kpis.countGastosPeriodo} registros contables`;
    if ($("#rep-valor-bodega")) $("#rep-valor-bodega").textContent = formatCOP(rep.kpis.valorBodegaVenta);
    if ($("#rep-note-bodega")) {
      $("#rep-note-bodega").textContent = `${rep.kpis.totalProductosActivos} productos activos (Costo: ${formatCOP(rep.kpis.valorBodegaCosto)})`;
    }

    // Ventas por día
    renderTablaPaginada(
      "#rep-tabla-ventas-periodo",
      rep.ventasPorPeriodo.map(
        (r) => `
          <tr>
            <td><b>${escapeHtml(r.fecha)}</b></td>
            <td class="num">${r.cantidadVentas}</td>
            <td class="num">${formatCOP(r.descuentos)}</td>
            <td class="num"><b>${formatCOP(r.totalVendido)}</b></td>
          </tr>
        `
      ),
      4,
      "No hay ventas registradas en el período seleccionado.",
      "ventas_periodo"
    );

    // Detalle de ventas
    if ($("#rep-detalle-count")) $("#rep-detalle-count").textContent = `${rep.detalleVentas.length} líneas`;
    renderTablaPaginada(
      "#rep-tabla-detalle-ventas",
      rep.detalleVentas.map((d) => {
        const med = d.dimensiones
          ? ` · ${d.dimensiones.ancho}×${d.dimensiones.largo} ${d.dimensiones.unidadDimension || "m"} (${d.dimensiones.piezas} pza)`
          : "";
        const descHtml = d.esTemporal
          ? `${escapeHtml(d.nombre)} <span class="badge-temp">SOLO ESTA VENTA</span>${d.observacion ? `<br><small class="text-muted">${escapeHtml(d.observacion)}</small>` : ""}`
          : `${escapeHtml(d.nombre)} <small class="text-muted">(${escapeHtml(d.codigo)}${escapeHtml(med)})</small>`;
        return `
          <tr>
            <td><b>${escapeHtml(d.numero)}</b></td>
            <td>${formatShortDate(d.fecha)}</td>
            <td>${escapeHtml(d.cliente)}</td>
            <td>${descHtml}</td>
            <td class="num">${d.cantidad}${d.unidad ? ` ${escapeHtml(d.unidad)}` : ""}</td>
            <td class="num">${formatCOP(d.subtotal)}</td>
            <td><span class="badge ${d.estado === "Completada" ? "badge-success" : "badge-danger"}">${escapeHtml(d.estado)}</span></td>
          </tr>
        `;
      }),
      7,
      "No hay detalle de ventas para mostrar.",
      "detalle_ventas"
    );

    // Productos más vendidos
    renderTablaPaginada(
      "#rep-tabla-mas-vendidos",
      rep.productosMasVendidos.map(
        (p) => `
          <tr>
            <td><b>${escapeHtml(p.nombre)}</b> <small class="text-muted">(${escapeHtml(p.codigo)})</small></td>
            <td>${escapeHtml(p.categoria)}</td>
            <td class="num">${p.cantidadVendida} ${escapeHtml(p.unidad)}</td>
            <td class="num"><b>${formatCOP(p.totalIngresos)}</b></td>
          </tr>
        `
      ),
      4,
      "No hay productos vendidos en el período.",
      "mas_vendidos"
    );

    // Inventario actual
    if ($("#rep-inv-count")) $("#rep-inv-count").textContent = `${rep.inventarioActual.length} productos`;
    renderTablaPaginada(
      "#rep-tabla-inventario",
      rep.inventarioActual.map(
        (p) => `
          <tr>
            <td><b>${escapeHtml(p.codigo)}</b></td>
            <td>${escapeHtml(p.nombre)}</td>
            <td class="num">${p.stock} ${escapeHtml(p.unidad)}</td>
            <td class="num">${formatCOP(p.precio)}</td>
            <td class="num"><b>${formatCOP(p.valorVentaTotal)}</b></td>
          </tr>
        `
      ),
      5,
      "No hay productos registrados.",
      "inventario_actual"
    );

    // Productos con stock bajo
    if ($("#rep-bajo-count")) $("#rep-bajo-count").textContent = `${rep.productosStockBajo.length} alertas`;
    renderTablaPaginada(
      "#rep-tabla-stock-bajo",
      rep.productosStockBajo.map(
        (p) => `
          <tr>
            <td><b>${escapeHtml(p.codigo)}</b></td>
            <td>${escapeHtml(p.nombre)}</td>
            <td class="num"><b>${p.stock} ${escapeHtml(p.unidad)}</b></td>
            <td class="num">${p.stockMinimo} ${escapeHtml(p.unidad)}</td>
            <td><span class="badge ${p.claseBadge}">${escapeHtml(p.estadoEtiqueta)}</span></td>
          </tr>
        `
      ),
      5,
      "No hay productos con stock bajo o agotado.",
      "stock_bajo"
    );

    // Movimientos de inventario (Kardex)
    if ($("#rep-mov-inv-count")) $("#rep-mov-inv-count").textContent = `${rep.movimientosInventario.length} movimientos`;
    renderTablaPaginada(
      "#rep-tabla-mov-inventario",
      rep.movimientosInventario.map(
        (m) => `
          <tr>
            <td>${formatShortDate(m.fecha)}</td>
            <td>${escapeHtml(m.productoNombre)}</td>
            <td><span class="badge ${m.tipo === "Entrada" ? "badge-success" : "badge-warning"}">${escapeHtml(m.tipo)}</span> · ${escapeHtml(m.origen || "")}</td>
            <td class="num">${m.tipo === "Entrada" ? "+ " : "− "}${m.cantidad} ${escapeHtml(m.unidad || "")}</td>
            <td class="num">${m.stockNuevo ?? "—"}</td>
            <td>${escapeHtml(m.motivo || "—")}</td>
            <td>${escapeHtml(m.usuario || "—")}</td>
          </tr>
        `
      ),
      7,
      "No hay movimientos de inventario en el período.",
      "movimientos_inventario"
    );

    // Ingresos y gastos por categoría
    renderTablaPaginada(
      "#rep-tabla-categorias",
      rep.ingresosYGastosPorCategoria.map(
        (g) => `
          <tr>
            <td>${escapeHtml(g.categoria)}</td>
            <td><span class="badge ${g.tipo === "Ingreso" ? "badge-success" : "badge-danger"}">${escapeHtml(g.tipo)}</span></td>
            <td class="num">${g.movimientos}</td>
            <td class="num ${g.tipo === "Ingreso" ? "text-income" : "text-expense"}">${g.tipo === "Ingreso" ? "+ " : "− "}${formatCOP(g.total)}</td>
          </tr>
        `
      ),
      4,
      "No hay movimientos contables en el período.",
      "ingresos_gastos"
    );

    // Métodos de pago
    const conMovimiento = rep.metodosDePago.filter((m) => m.operaciones > 0);
    renderTablaPaginada(
      "#rep-tabla-metodos",
      conMovimiento.length
        ? rep.metodosDePago.map(
            (m) => `
              <tr>
                <td><b>${escapeHtml(m.metodo)}</b></td>
                <td class="num">${m.operaciones}</td>
                <td class="num">${formatCOP(m.total)}</td>
                <td class="num">${m.porcentaje}%</td>
              </tr>
            `
          )
        : [],
      4,
      "Sin pagos registrados en el período.",
      "metodos_pago"
    );

    // Cierres de caja y diferencias
    if ($("#rep-cierres-count")) $("#rep-cierres-count").textContent = `${rep.cierresDeCaja.length} cierres`;
    renderTablaPaginada(
      "#rep-tabla-cierres",
      rep.cierresDeCaja.map((c) => {
        const dif = roundCOP(c.diferencia || 0);
        return `
          <tr>
            <td>${formatShortDate(c.fechaCierre)}</td>
            <td>${escapeHtml(c.usuarioCierre || c.usuarioApertura)}</td>
            <td class="num">${formatCOP(c.efectivoEsperado)}</td>
            <td class="num">${formatCOP(c.efectivoContado)}</td>
            <td class="num ${dif === 0 ? "text-income" : "text-expense"}">${formatCOP(dif)}</td>
          </tr>
        `;
      }),
      5,
      "No hay cierres de caja registrados.",
      "cierres_caja"
    );

    // Anulaciones y devoluciones
    if ($("#rep-anulaciones-count")) {
      $("#rep-anulaciones-count").textContent = `${rep.anulacionesYDevoluciones.length} registros`;
    }
    renderTablaPaginada(
      "#rep-tabla-anulaciones",
      rep.anulacionesYDevoluciones.map(
        (a) => `
          <tr>
            <td><span class="badge badge-danger">${escapeHtml(a.tipo)}</span></td>
            <td><b>${escapeHtml(a.referencia || "—")}</b></td>
            <td>${formatShortDate(a.fecha)}</td>
            <td class="num text-expense">${formatCOP(a.monto)}</td>
            <td>${escapeHtml(a.motivo)} <small class="text-muted">(${escapeHtml(a.usuario)})</small></td>
          </tr>
        `
      ),
      5,
      "No hay anulaciones ni devoluciones en el período.",
      "anulaciones_devoluciones"
    );
  }

  $("#form-filtro-reportes")?.addEventListener("submit", (e) => {
    e.preventDefault();
    renderReportes();
  });

  function actualizarReporteVisible(tipoSel) {
    const tipo = tipoSel || $("#rep-csv-tipo")?.value || "ventas_periodo";
    if ($("#rep-csv-tipo")) $("#rep-csv-tipo").value = tipo;
    root.querySelectorAll("[data-rep-btn]").forEach((btn) => {
      const activo = btn.dataset.repBtn === tipo;
      btn.classList.toggle("btn-primary", activo);
      btn.classList.toggle("btn-outline", !activo);
      btn.setAttribute("aria-pressed", activo ? "true" : "false");
    });
    root.querySelectorAll("[data-rep-panel]").forEach((panel) => {
      const keys = String(panel.dataset.repPanel || "").split(",");
      panel.classList.toggle("hidden", !keys.includes(tipo));
    });
  }

  root.querySelectorAll("[data-rep-btn]").forEach((btn) => {
    btn.addEventListener("click", () => actualizarReporteVisible(btn.dataset.repBtn));
  });
  actualizarReporteVisible("ventas_periodo");

  root.querySelectorAll("[data-rep-rango]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rango = btn.dataset.repRango || "todos";
      const { desde, hasta } = obtenerRangoPeriodo(rango);
      if ($("#rep-desde")) $("#rep-desde").value = desde || "";
      if ($("#rep-hasta")) $("#rep-hasta").value = hasta || "";
      root.querySelectorAll("[data-rep-rango]").forEach((b) => {
        const activo = b === btn;
        b.classList.toggle("btn-primary", activo);
        b.classList.toggle("btn-outline", !activo);
        b.classList.toggle("active", activo);
      });
      renderReportes();
    });
  });

  $("#btn-rep-limpiar-fechas")?.addEventListener("click", () => {
    if ($("#rep-desde")) $("#rep-desde").value = "";
    if ($("#rep-hasta")) $("#rep-hasta").value = "";
    root.querySelectorAll("[data-rep-rango]").forEach((b) => {
      const activo = b.dataset.repRango === "todos";
      b.classList.toggle("btn-primary", activo);
      b.classList.toggle("btn-outline", !activo);
      b.classList.toggle("active", activo);
    });
    renderReportes();
  });

  ["#rep-desde", "#rep-hasta"].forEach((sel) => {
    $(sel)?.addEventListener("change", () => {
      root.querySelectorAll("[data-rep-rango]").forEach((b) => {
        b.classList.remove("btn-primary", "active");
        b.classList.add("btn-outline");
      });
      renderReportes();
    });
  });

  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rep-open-modal], [data-rep-toggle-table]");
    if (btn) {
      const key = btn.dataset.repOpenModal || btn.dataset.repToggleTable;
      if (key) abrirModalReporteCompleto(key);
      return;
    }
    if (e.target.closest("[data-close-rep-modal]")) {
      cerrarModalReporteCompleto();
    }
  });
  $("#buscar-reporte-modal")?.addEventListener("input", renderModalReporteCompleto);
  const onEscapeModal = (e) => {
    if (e.key === "Escape" && $("#modal-reporte-completo")?.classList.contains("is-open")) {
      cerrarModalReporteCompleto();
    }
  };
  document.addEventListener("keydown", onEscapeModal);

  $("#btn-exportar-csv")?.addEventListener("click", () => {
    if (!ultimoConsolidado) renderReportes();
    const tipo = $("#rep-csv-tipo")?.value || "ventas_periodo";
    const csv = generarCSVReporte(tipo, ultimoConsolidado);
    if (!csv) return;
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reporte-${tipo}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  $("#btn-imprimir")?.addEventListener("click", () => {
    window.print();
  });

  const u1 = watchProductos(
    (l) => {
      productos = l;
      renderReportes();
    },
    { incluirInactivos: true }
  );
  const u2 = watchVentas((l) => { ventas = l; renderReportes(); });
  const u3 = watchCajas(({ historial }) => { cajas = historial; renderReportes(); });
  const u4 = watchMovimientosContables((l) => { movsContables = l; renderReportes(); });
  const u5 = watchMovimientosInventario((l) => { movsInventario = l; renderReportes(); });

  return () => {
    document.removeEventListener("keydown", onEscapeModal);
    u1();
    u2();
    u3();
    u4();
    u5();
  };
}

// ---------------------------------------------------------------------------
// 5. VISTA DE USUARIOS Y SEGURIDAD (Sección 10)
// ---------------------------------------------------------------------------
export function mountUsuariosView(root) {
  const $ = (sel) => root.querySelector(sel);
  let usuarios = [];
  let auditoria = [];

  const feedbackEl = $("#usr-feedback");
  function showFeedback(msg, isError = false) {
    if (!feedbackEl) return;
    feedbackEl.textContent = msg;
    feedbackEl.className = `alert ${isError ? "alert-danger" : "alert-info"}`;
    feedbackEl.classList.remove("hidden");
  }

  function renderUsuarios() {
    const tbody = root.querySelector("#tabla-usuarios tbody");
    if (!tbody) return;

    tbody.innerHTML = usuarios.length
      ? usuarios
          .map((u) => {
            const activo = u.activo !== false;
            const rolLegible = u.rol === "Administrador" ? "Administrador" : "Empleado general";
            return `
              <tr>
                <td><b>${escapeHtml(u.nombre)}</b></td>
                <td>${escapeHtml(u.email)}</td>
                <td><span class="badge ${u.rol === "Administrador" ? "" : "badge-warning"}">${escapeHtml(rolLegible)}</span></td>
                <td><span class="badge ${activo ? "badge-success" : "badge-danger"}">${activo ? "Activo" : "Inactivo"}</span></td>
                <td class="text-right" style="white-space:nowrap">
                  <button type="button" class="btn btn-outline" style="padding:.22rem .55rem; font-size:.76rem" data-edit-usr="${escapeHtml(u.id)}">Editar</button>
                  <button type="button" class="btn btn-outline" style="padding:.22rem .55rem; font-size:.76rem" data-toggle-usr="${escapeHtml(u.id)}">${activo ? "Desactivar" : "Activar"}</button>
                </td>
              </tr>
            `;
          })
          .join("")
      : `<tr><td colspan="5" style="text-align:center; padding:1.5rem" class="text-muted">No hay usuarios registrados.</td></tr>`;
  }

  function renderAuditoria() {
    const tbody = root.querySelector("#tabla-auditoria tbody");
    const countEl = $("#usr-auditoria-count");
    if (countEl) countEl.textContent = `${auditoria.length} eventos`;
    if (!tbody) return;

    tbody.innerHTML = auditoria.length
      ? auditoria
          .slice(0, 40)
          .map((a) => {
            const detalle =
              a.motivo ||
              a.concepto ||
              a.emailObjetivo ||
              a.numero ||
              (a.montoInicial !== undefined ? `Monto inicial: ${formatCOP(a.montoInicial)}` : "") ||
              (a.total !== undefined ? `Total: ${formatCOP(a.total)}` : "Operación auditada");
            return `
              <tr>
                <td>${formatDateTime(a.fecha)}</td>
                <td><span class="badge">${escapeHtml(a.accion)}</span></td>
                <td>${escapeHtml(a.usuario || "Sistema")}</td>
                <td>${escapeHtml(detalle)}</td>
              </tr>
            `;
          })
          .join("")
      : `<tr><td colspan="4" style="text-align:center; padding:1.5rem" class="text-muted">No hay eventos de auditoría registrados.</td></tr>`;
  }

  function abrirModalUsuario(usr = null) {
    const errEl = $("#usr-error");
    if (errEl) errEl.classList.add("hidden");
    const titulo = $("#titulo-usuario");
    const correoInput = $("#usr-correo");

    if (usr) {
      if (titulo) titulo.textContent = `Editar usuario · ${usr.nombre}`;
      if ($("#usr-id")) $("#usr-id").value = usr.id;
      if ($("#usr-nombre")) $("#usr-nombre").value = usr.nombre;
      if (correoInput) {
        correoInput.value = usr.email;
        correoInput.disabled = true;
      }
      if ($("#usr-rol")) $("#usr-rol").value = usr.rol === "Administrador" ? "Administrador" : "Empleado";
      if ($("#usr-estado")) $("#usr-estado").value = usr.activo === false ? "inactivo" : "activo";
      if ($("#usr-clave")) $("#usr-clave").value = "";
    } else {
      if (titulo) titulo.textContent = "Nuevo usuario autorizado";
      $("#form-usuario")?.reset();
      if ($("#usr-id")) $("#usr-id").value = "";
      if ($("#usr-rol")) $("#usr-rol").value = "Empleado";
      if (correoInput) correoInput.disabled = false;
      if ($("#usr-estado")) $("#usr-estado").value = "activo";
      if ($("#usr-clave")) $("#usr-clave").value = "";
    }

    $("#modal-usuario")?.classList.add("is-open");
  }

  $("#btn-nuevo-usuario")?.addEventListener("click", () => abrirModalUsuario(null));

  root.querySelector("#tabla-usuarios")?.addEventListener("click", async (e) => {
    const editBtn = e.target.closest("[data-edit-usr]");
    if (editBtn) {
      const usr = usuarios.find((u) => u.id === editBtn.dataset.editUsr);
      if (usr) abrirModalUsuario(usr);
      return;
    }
    const toggleBtn = e.target.closest("[data-toggle-usr]");
    if (toggleBtn) {
      const usr = usuarios.find((u) => u.id === toggleBtn.dataset.toggleUsr);
      if (!usr) return;
      try {
        const nuevoEstado = usr.activo === false;
        await actualizarUsuario({ id: usr.id, activo: nuevoEstado }, getCurrentUser());
        showFeedback(
          `Cuenta de "${usr.nombre}" ${nuevoEstado ? "activada" : "desactivada"} correctamente.`
        );
      } catch (err) {
        showFeedback(err.message, true);
      }
    }
  });

  $("#form-usuario")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#usr-error");
    if (errEl) errEl.classList.add("hidden");
    try {
      const id = $("#usr-id")?.value;
      const nombre = $("#usr-nombre")?.value;
      const email = $("#usr-correo")?.value;
      const rol = $("#usr-rol")?.value;
      const activo = ($("#usr-estado")?.value || "activo") === "activo";
      const clave = $("#usr-clave")?.value || "";

      if (id) {
        await actualizarUsuario({ id, nombre, rol, activo, clave }, getCurrentUser());
        showFeedback(`Usuario "${nombre}" actualizado correctamente.`);
      } else {
        await crearUsuario({ nombre, email, rol, clave }, getCurrentUser());
        showFeedback(`Usuario "${nombre}" (${rol}) registrado correctamente.`);
      }
      $("#modal-usuario")?.classList.remove("is-open");
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
      }
    }
  });

  const u1 = watchUsuarios((l) => { usuarios = l; renderUsuarios(); });
  const u2 = watchAuditoria((l) => { auditoria = l; renderAuditoria(); });

  return () => { u1(); u2(); };
}
