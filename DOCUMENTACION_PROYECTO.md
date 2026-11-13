# Documentación General y Lógica del Sistema — Vidrios y Aluminios El Carmen

## 1. ¿Qué es este proyecto?

El **Sistema de Gestión de Caja, Inventario y Control Administrativo — Vidrios y Aluminios El Carmen** es una aplicación web administrativa tipo **SPA (Single Page Application)** diseñada a la medida de las operaciones reales de una vidriería y taller de aluminio.

Su propósito es permitir al propietario/administrador y a sus empleados controlar en un solo lugar y en tiempo real:
1. **El dinero físico en caja y la facturación en el punto de venta (POS)** (incluyendo cálculo de vidrios a la medida por ancho × alto en m², metros lineales o unidades).
2. **Las existencias reales de bodega (Kardex)** de láminas de vidrio, espejos, perfiles de aluminio, herrajes e insumos.
3. **La contabilidad administrativa básica**, pensada con lenguaje claro y accesible para controlar el dinero que entra, el dinero que sale, los anticipos de pedidos, las cuentas bancarias y la ganancia o pérdida real del negocio.
4. **Los reportes gerenciales y operativos** (11 reportes obligatorios exportables a CSV).
5. **El control de acceso por roles y auditoría** de cada operación sensible.

---

## 2. Tecnologías y Arquitectura

- **Frontend:** HTML5 semántico, CSS3 modular (`css/base.css`, `css/layout.css`, `css/components.css`, `css/modules.css`, `css/login.css`, `css/print.css`) y JavaScript moderno (ES Modules nativos).
- **Base de datos en tiempo real:** **Firebase Cloud Firestore** (`projectId: inventario-10d9e`), con sincronización reactiva (`onSnapshot`) y escritura atómica por lotes (`writeBatch`).
- **Autenticación y Seguridad:** **Firebase Authentication** integrado con control de permisos por rol (`js/auth.js`) y reglas de seguridad en el servidor (`firestore.rules`).
- **Despliegue preparado:** Configuración lista para **Netlify** (`netlify.toml`).

---

## 3. Estructura de Archivos del Proyecto

- **`index.html`:** Contenedor principal de la aplicación SPA (incluye la vista de inicio de sesión y las 6 vistas integradas para navegación instantánea sin recargar la página).
- **`html/`:** Vistas modulares de cada sección (`dashboard.html`, `caja.html`, `inventario.html`, `contabilidad.html`, `reportes.html`, `usuarios.html`).
- **`js/`:**
  - `app.js`: Inicializador general, control de sesión, barra lateral y estado de Firebase.
  - `router.js`: Navegación SPA mediante rutas `#/<modulo>`.
  - `auth.js`: Matriz de roles (`Administrador`, `Cajero`, `Inventario`, `Contabilidad`, `Empleado`) y verificación de permisos.
  - `firebase-config.js`: Configuración centralizada del proyecto Firebase `inventario-10d9e`.
- **`js/services/`:**
  - `store.js`: Motor de transacciones atómicas (`runAtomicTransaction`), candados contra operaciones simultáneas conflictivas y caché reactiva.
  - `firebase-service.js`: Comunicación con Cloud Firestore, esquema de las 9 colecciones y traducción de errores técnicos a español claro.
  - `caja-service.js`: Lógica de apertura/cierre de caja, arqueo, ventas, pagos mixtos, anulaciones y devoluciones.
  - `inventario-service.js`: Catálogo de productos, cálculo de área en m² y cortes a medida, entradas por compra y kardex.
  - `contabilidad-service.js`: Ingresos, gastos, traslados entre caja y bancos, anticipos de clientes y reversión con auditoría.
  - `reportes-service.js`: Motor de los 11 reportes cruzados y exportación CSV.
  - `usuarios-service.js` y `clientes-service.js`: Gestión de cuentas de usuario y directorio de clientes.

---

## 4. Lógica Detallada de Cada Módulo y Cómo se Conectan

### Módulo 1: Dashboard (`html/dashboard.html`)
Es el panel de control en tiempo real del negocio. Escucha directamente las colecciones de Ventas, Cajas, Inventario y Contabilidad y muestra:
- **Ventas del día** y cantidad de facturas emitidas hoy.
- **Estado actual de la caja** (Abierta o Cerrada) y **efectivo esperado en gaveta**.
- **Alertas de stock bajo o agotado** en bodega.
- **Resultado contable del período** (Ingresos menos Gastos) y tabla de las últimas operaciones registradas.

### Módulo 2: Caja y Ventas — Punto de Venta POS (`js/services/caja-service.js`)
Controla todo el ciclo del turno de facturación y la gaveta de efectivo:
1. **Regla de Caja Única:** Solo puede existir una caja abierta a la vez y no se permite facturar con la caja cerrada. El monto inicial de apertura suma al efectivo físico esperado en gaveta, pero nunca se contabiliza como ingreso por ventas.
2. **Cálculo de Productos y Cortes a la Medida:** Soporta unidades (`u`), metros lineales (`m`) y metros cuadrados (`m²` = Ancho × Alto × Piezas), además de cotización de trabajos de vidrio personalizado con mano de obra e instalación.
3. **Transacción Atómica al Confirmar una Venta (`registrarVenta`):** En un solo paso indivisible verifica stock, descuenta de `productos`, registra la salida en `movimientos_inventario`, guarda la factura en `ventas`, crea el ingreso en `movimientos_contables` según el método de pago y escribe en `auditoria`.
4. **Arqueo y Cierre de Caja:** Separa el efectivo físico en gaveta de los pagos por transferencia o tarjeta. Al cerrar caja compara el efectivo esperado contra el efectivo contado y registra si hubo cuadre exacto, sobrante o faltante.
5. **Anulaciones y Devoluciones:** Exclusivas para Administrador con motivo obligatorio; devuelven el stock a bodega y ajustan caja y contabilidad automáticamente.

### Módulo 3: Inventario y Bodega (`js/services/inventario-service.js`)
- Administra el catálogo de vidrios, espejos, perfiles, herrajes e insumos.
- Editar datos maestros (nombre, precio, stock mínimo) no altera las existencias; todo cambio de stock exige un movimiento de Kardex (`Entrada por compra`, `Ajuste`, `Salida por merma/rotura`, etc.).
- Permite conectar una **Entrada por compra** directamente con **Contabilidad** para registrar el gasto de compra en el mismo paso.

### Módulo 4: Contabilidad Básica Accesible (`js/services/contabilidad-service.js`)
- Muestra 4 indicadores claros: **Total de ingresos (Dinero que entra)**, **Total de gastos (Dinero que sale)**, **Resultado del período (Ganancia o Pérdida)** y **Dinero disponible (Efectivo en caja vs. Bancos)**.
- Gestiona **Anticipos de clientes** calculando automáticamente el saldo pendiente del pedido.
- Soporta **Traslados internos** entre caja y banco sin inflar ingresos ni gastos.
- Impide borrar movimientos sin rastro: cualquier corrección se hace mediante **Reversión/Anulación** con motivo obligatorio y auditoría.

### Módulo 5: Consultas y Reportes (`js/services/reportes-service.js`)
Genera en tiempo real los 11 reportes del negocio (ventas por período, detalle de ventas, más vendidos, inventario valorizado, stock crítico, kardex, ingresos/gastos por categoría, métodos de pago, cierres de caja, diferencias de efectivo y anulaciones/devoluciones) con exportación a CSV.

### Módulo 6: Usuarios, Roles y Auditoría (`js/services/usuarios-service.js`)
- Gestiona 5 roles (`Administrador`, `Cajero`, `Inventario`, `Contabilidad`, `Empleado`).
- Nunca guarda contraseñas en Firestore.
- Bloquea el acceso y los permisos de cuentas inactivas e impide desactivar al único Administrador activo.
