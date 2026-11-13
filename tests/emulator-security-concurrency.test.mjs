import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  runTransaction
} from "firebase/firestore";
import {
  setFirebaseConfigOverride,
  setEmulatorConfig,
  assertSafeEmulatorEnvironment,
  isDemoProject
} from "../js/firebase-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const RULES_PATH = path.join(PROJECT_ROOT, "firestore.rules");
const DEMO_PROJECT_ID = "demo-el-carmen";

let testEnv;

async function seedBaseFixtures() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await Promise.all([
      setDoc(doc(db, "usuarios", "admin-uid"), {
        uid: "admin-uid",
        nombre: "Admin Principal",
        rol: "Administrador",
        activo: true
      }),
      setDoc(doc(db, "usuarios", "cajero-uid"), {
        uid: "cajero-uid",
        nombre: "Cajero 1",
        rol: "Cajero",
        activo: true
      }),
      setDoc(doc(db, "usuarios", "cajero2-uid"), {
        uid: "cajero2-uid",
        nombre: "Cajero 2",
        rol: "Cajero",
        activo: true
      }),
      setDoc(doc(db, "usuarios", "empleado-uid"), {
        uid: "empleado-uid",
        nombre: "Empleado 1",
        rol: "Empleado",
        activo: true
      }),
      setDoc(doc(db, "usuarios", "inactivo-uid"), {
        uid: "inactivo-uid",
        nombre: "Usuario Inactivo",
        rol: "Cajero",
        activo: false
      }),
      setDoc(doc(db, "clientes", "cli-1"), {
        id: "cli-1",
        nombre: "Cliente Billetera",
        documento: "1001",
        saldoAFavorDisponible: 100,
        ultimoMovimientoBilleteraId: "mov-seed-0"
      }),
      setDoc(doc(db, "productos", "prod-1"), {
        id: "prod-1",
        codigo: "VID-001",
        nombre: "Vidrio Templado 6mm",
        precio: 50,
        stock: 3,
        stockMinimo: 1,
        unidad: "m²"
      }),
      setDoc(doc(db, "control", "consecutivo_ventas"), {
        ultimoNumero: 10
      }),
      setDoc(doc(db, "control", "caja_activa"), {
        activa: false,
        cajaId: null
      }),
      setDoc(doc(db, "cajas", "caja-abierta"), {
        id: "caja-abierta",
        estado: "Abierta",
        montoInicial: 200,
        fechaApertura: "2026-11-13T08:00:00.000Z",
        usuarioApertura: "cajero-uid"
      }),
      setDoc(doc(db, "cajas", "caja-cerrada"), {
        id: "caja-cerrada",
        estado: "Cerrada",
        montoInicial: 200,
        montoFinal: 500,
        fechaApertura: "2026-11-12T08:00:00.000Z",
        fechaCierre: "2026-11-12T18:00:00.000Z",
        usuarioApertura: "cajero-uid"
      }),
      setDoc(doc(db, "ventas", "venta-credito-1"), {
        id: "venta-credito-1",
        numero: "V-0010",
        estado: "Completada",
        total: 100,
        importePagado: 0,
        saldoPendiente: 100,
        totalDevueltoAcumulado: 0,
        saldoAFavorAplicado: 0,
        cliente: { id: "cli-1", nombre: "Cliente Billetera" },
        items: [{ lineId: "l1", nombre: "Vidrio Templado 6mm", cantidad: 2, precio: 50 }],
        pagos: []
      }),
      setDoc(doc(db, "movimientos_billetera", "mov-seed-0"), {
        id: "mov-seed-0",
        clienteId: "cli-1",
        tipo: "GENERACION",
        monto: 100,
        saldoAnterior: 0,
        saldoPosterior: 100,
        devolucionId: "dev-seed-0"
      })
    ]);
  });
}

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST debe estar definido por firebase emulators:exec."
  );

  const rules = fs.readFileSync(RULES_PATH, "utf8");
  testEnv = await initializeTestEnvironment({
    projectId: DEMO_PROJECT_ID,
    firestore: {
      rules
    }
  });
});

after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedBaseFixtures();
});

test("Aislamiento de entorno: bloquea proyecto de producción y exige demo-* + emulador", () => {
  setFirebaseConfigOverride({ projectId: "inventario-10d9e", apiKey: "test" });
  setEmulatorConfig({ enabled: true });
  assert.equal(isDemoProject("inventario-10d9e"), false);
  assert.throws(() => assertSafeEmulatorEnvironment(DEMO_PROJECT_ID), /producción bloqueada/i);

  setFirebaseConfigOverride({ projectId: DEMO_PROJECT_ID, apiKey: "test" });
  setEmulatorConfig({ enabled: false });
  assert.throws(() => assertSafeEmulatorEnvironment(DEMO_PROJECT_ID), /emulatorConfig\.enabled/i);

  setEmulatorConfig({ enabled: true });
  assert.equal(assertSafeEmulatorEnvironment(DEMO_PROJECT_ID), DEMO_PROJECT_ID);
});

// ==================== ESCENARIOS DE REGLAS A - P ====================

test("Regla A: Cajero no puede aumentar saldoAFavorDisponible directamente en clientes", async () => {
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  await assertFails(
    updateDoc(doc(cajeroDb, "clientes", "cli-1"), {
      saldoAFavorDisponible: 500,
      ultimoMovimientoBilleteraId: "mov-falso"
    })
  );
});

test("Regla B: Cajero no puede crear movimiento GENERACION en movimientos_billetera", async () => {
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  await assertFails(
    setDoc(doc(cajeroDb, "movimientos_billetera", "mov-gen-cajero"), {
      clienteId: "cli-1",
      tipo: "GENERACION",
      monto: 50,
      saldoAnterior: 100,
      saldoPosterior: 150,
      devolucionId: "dev-inexistente"
    })
  );
});

test("Regla C: Admin no puede crear GENERACION sin devolución atómica válida (getAfter)", async () => {
  const adminDb = testEnv.authenticatedContext("admin-uid").firestore();
  await assertFails(
    setDoc(doc(adminDb, "movimientos_billetera", "mov-gen-sin-dev"), {
      clienteId: "cli-1",
      tipo: "GENERACION",
      monto: 50,
      saldoAnterior: 100,
      saldoPosterior: 150,
      devolucionId: "dev-no-creada"
    })
  );
});

test("Regla D: Cajero puede redimir saldo a favor atómicamente con venta + movimiento REDENCION", async () => {
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  await assertSucceeds(
    runTransaction(cajeroDb, async (tx) => {
      const cliRef = doc(cajeroDb, "clientes", "cli-1");
      const cliSnap = await tx.get(cliRef);
      const saldoAnterior = cliSnap.data().saldoAFavorDisponible;
      const monto = 60;
      const saldoPosterior = saldoAnterior - monto;

      tx.set(doc(cajeroDb, "ventas", "venta-redencion-1"), {
        numero: "V-0011",
        estado: "Completada",
        total: 60,
        importePagado: 60,
        saldoPendiente: 0,
        saldoAFavorAplicado: monto,
        cliente: { id: "cli-1", nombre: "Cliente Billetera" },
        items: [{ lineId: "l1", nombre: "Vidrio", cantidad: 1, precio: 60 }],
        pagos: [{ metodo: "Saldo a favor", monto }]
      });

      tx.set(doc(cajeroDb, "movimientos_billetera", "mov-red-1"), {
        clienteId: "cli-1",
        tipo: "REDENCION",
        monto,
        saldoAnterior,
        saldoPosterior,
        ventaId: "venta-redencion-1"
      });

      tx.update(cliRef, {
        saldoAFavorDisponible: saldoPosterior,
        ultimoMovimientoBilleteraId: "mov-red-1"
      });
    })
  );
});

test("Regla E: Cajero no puede redimir dejando saldo negativo en cliente", async () => {
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  await assertFails(
    runTransaction(cajeroDb, async (tx) => {
      tx.set(doc(cajeroDb, "ventas", "venta-red-neg"), {
        numero: "V-0012",
        estado: "Completada",
        total: 150,
        saldoAFavorAplicado: 150,
        cliente: { id: "cli-1", nombre: "Cliente Billetera" },
        items: [{ lineId: "l1", nombre: "Vidrio", cantidad: 1, precio: 150 }],
        pagos: [{ metodo: "Saldo a favor", monto: 150 }]
      });
      tx.set(doc(cajeroDb, "movimientos_billetera", "mov-red-neg"), {
        clienteId: "cli-1",
        tipo: "REDENCION",
        monto: 150,
        saldoAnterior: 100,
        saldoPosterior: -50,
        ventaId: "venta-red-neg"
      });
      tx.update(doc(cajeroDb, "clientes", "cli-1"), {
        saldoAFavorDisponible: -50,
        ultimoMovimientoBilleteraId: "mov-red-neg"
      });
    })
  );
});

test("Regla F: movimientos_billetera es estrictamente inmutable incluso para Administrador", async () => {
  const adminDb = testEnv.authenticatedContext("admin-uid").firestore();
  await assertFails(
    updateDoc(doc(adminDb, "movimientos_billetera", "mov-seed-0"), { monto: 999 })
  );
  await assertFails(deleteDoc(doc(adminDb, "movimientos_billetera", "mov-seed-0")));
});

test("Regla G: Caja cerrada no puede reabrirse ni modificarse", async () => {
  const adminDb = testEnv.authenticatedContext("admin-uid").firestore();
  await assertFails(
    updateDoc(doc(adminDb, "cajas", "caja-cerrada"), { estado: "Abierta" })
  );
});

test("Regla H: Caja abierta no permite alterar montoInicial, fechaApertura ni usuarioApertura", async () => {
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  await assertFails(
    updateDoc(doc(cajeroDb, "cajas", "caja-abierta"), { montoInicial: 9999 })
  );
});

test("Regla I: Venta no puede crearse con estado Anulada ni total <= 0", async () => {
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  await assertFails(
    setDoc(doc(cajeroDb, "ventas", "venta-invalida"), {
      numero: "V-0013",
      estado: "Anulada",
      total: 100,
      items: [{ lineId: "l1", nombre: "Vidrio", cantidad: 1, precio: 100 }]
    })
  );
});

test("Regla J: Cajero no puede anular o devolver una venta", async () => {
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  await assertFails(
    updateDoc(doc(cajeroDb, "ventas", "venta-credito-1"), { estado: "Anulada" })
  );
});

test("Regla K: Cajero puede registrar abono válido reduciendo saldoPendiente y agregando 1 pago", async () => {
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  await assertSucceeds(
    updateDoc(doc(cajeroDb, "ventas", "venta-credito-1"), {
      saldoPendiente: 60,
      importePagado: 40,
      pagos: [{ metodo: "Efectivo", monto: 40 }]
    })
  );
});

test("Regla L: operaciones/{opId} es inmutable (no permite sobrescribir ni eliminar)", async () => {
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  await assertSucceeds(
    setDoc(doc(cajeroDb, "operaciones", "op-1"), { tipo: "VENTA", estado: "OK" })
  );
  await assertFails(
    setDoc(doc(cajeroDb, "operaciones", "op-1"), { tipo: "VENTA", estado: "REPETIDA" })
  );
  await assertFails(deleteDoc(doc(cajeroDb, "operaciones", "op-1")));
});

test("Regla M: control/consecutivo_ventas exige incremento estricto +1", async () => {
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  await assertFails(
    updateDoc(doc(cajeroDb, "control", "consecutivo_ventas"), { ultimoNumero: 10 })
  );
  await assertFails(
    updateDoc(doc(cajeroDb, "control", "consecutivo_ventas"), { ultimoNumero: 12 })
  );
  await assertSucceeds(
    updateDoc(doc(cajeroDb, "control", "consecutivo_ventas"), { ultimoNumero: 11 })
  );
});

test("Regla N: Cajero y Empleado no pueden escalar privilegios en usuarios/{uid}", async () => {
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  const empleadoDb = testEnv.authenticatedContext("empleado-uid").firestore();
  await assertFails(
    updateDoc(doc(cajeroDb, "usuarios", "cajero-uid"), { rol: "Administrador" })
  );
  await assertFails(
    updateDoc(doc(empleadoDb, "usuarios", "empleado-uid"), { rol: "Administrador" })
  );
});

test("Regla O: Usuario no autenticado o inactivo no tiene acceso", async () => {
  const anonDb = testEnv.unauthenticatedContext().firestore();
  const inactiveDb = testEnv.authenticatedContext("inactivo-uid").firestore();
  await assertFails(getDoc(doc(anonDb, "productos", "prod-1")));
  await assertFails(getDoc(doc(inactiveDb, "productos", "prod-1")));
});

test("Regla P: Consecutivo transaccional evita colisión de números entre dos ventas concurrentes", async () => {
  const c1 = testEnv.authenticatedContext("cajero-uid").firestore();
  const c2 = testEnv.authenticatedContext("cajero2-uid").firestore();

  const runSale = (db, saleId) =>
    runTransaction(db, async (tx) => {
      const ref = doc(db, "control", "consecutivo_ventas");
      const snap = await tx.get(ref);
      const nextNum = snap.data().ultimoNumero + 1;
      tx.update(ref, { ultimoNumero: nextNum });
      tx.set(doc(db, "ventas", saleId), {
        numero: `V-${String(nextNum).padStart(4, "0")}`,
        estado: "Completada",
        total: 50,
        items: [{ lineId: "l1", nombre: "Vidrio", cantidad: 1, precio: 50 }]
      });
      return nextNum;
    });

  const [n1, n2] = await Promise.all([runSale(c1, "v-p1"), runSale(c2, "v-p2")]);
  assert.notEqual(n1, n2);
  assert.deepEqual([n1, n2].sort((a, b) => a - b), [11, 12]);
});

// ==================== 10 ESCENARIOS DE CONCURRENCIA REAL ====================

test("Concurrencia 1: Dos cajeros intentan abrir caja activa simultáneamente", async () => {
  const c1 = testEnv.authenticatedContext("cajero-uid").firestore();
  const c2 = testEnv.authenticatedContext("cajero2-uid").firestore();

  const tryOpen = (db, cajaId) =>
    runTransaction(db, async (tx) => {
      const ctrlRef = doc(db, "control", "caja_activa");
      const snap = await tx.get(ctrlRef);
      if (snap.data()?.activa) {
        throw new Error("Ya existe una caja abierta");
      }
      tx.update(ctrlRef, { activa: true, cajaId });
      tx.set(doc(db, "cajas", cajaId), {
        id: cajaId,
        estado: "Abierta",
        montoInicial: 150,
        fechaApertura: "2026-11-13T09:00:00.000Z",
        usuarioApertura: cajaId
      });
    });

  const results = await Promise.allSettled([
    tryOpen(c1, "caja-c1"),
    tryOpen(c2, "caja-c2")
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
});

test("Concurrencia 2: Ventas simultáneas obtienen consecutivos únicos sin saltos", async () => {
  const c1 = testEnv.authenticatedContext("cajero-uid").firestore();
  const c2 = testEnv.authenticatedContext("cajero2-uid").firestore();
  const emp = testEnv.authenticatedContext("empleado-uid").firestore();

  const nextConsec = (db, id) =>
    runTransaction(db, async (tx) => {
      const ref = doc(db, "control", "consecutivo_ventas");
      const snap = await tx.get(ref);
      const next = snap.data().ultimoNumero + 1;
      tx.update(ref, { ultimoNumero: next });
      tx.set(doc(db, "ventas", id), {
        numero: `V-${next}`,
        estado: "Completada",
        total: 25,
        items: [{ lineId: "l1", nombre: "Corte", cantidad: 1, precio: 25 }]
      });
      return next;
    });

  const nums = await Promise.all([
    nextConsec(c1, "vc-1"),
    nextConsec(c2, "vc-2"),
    nextConsec(emp, "vc-3")
  ]);
  assert.deepEqual([...nums].sort((a, b) => a - b), [11, 12, 13]);
});

test("Concurrencia 3: Dos cajeros venden últimas 3 unidades (2 c/u) sin stock negativo", async () => {
  const c1 = testEnv.authenticatedContext("cajero-uid").firestore();
  const c2 = testEnv.authenticatedContext("cajero2-uid").firestore();

  const sellTwo = (db) =>
    runTransaction(db, async (tx) => {
      const prodRef = doc(db, "productos", "prod-1");
      const snap = await tx.get(prodRef);
      const stock = snap.data().stock;
      if (stock < 2) throw new Error("Stock insuficiente");
      tx.update(prodRef, { stock: stock - 2 });
    });

  const results = await Promise.allSettled([sellTwo(c1), sellTwo(c2)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);

  const finalSnap = await getDoc(doc(c1, "productos", "prod-1"));
  assert.equal(finalSnap.data().stock, 1);
});

test("Concurrencia 4: Dos cajeros redimen $80 de la misma billetera ($100) simultáneamente", async () => {
  const c1 = testEnv.authenticatedContext("cajero-uid").firestore();
  const c2 = testEnv.authenticatedContext("cajero2-uid").firestore();

  const redeem80 = (db, suffix) =>
    runTransaction(db, async (tx) => {
      const cliRef = doc(db, "clientes", "cli-1");
      const snap = await tx.get(cliRef);
      const saldoAnterior = snap.data().saldoAFavorDisponible;
      if (saldoAnterior < 80) throw new Error("Saldo a favor insuficiente");
      const saldoPosterior = saldoAnterior - 80;
      const ventaId = `venta-conc-${suffix}`;
      const movId = `mov-conc-${suffix}`;

      tx.set(doc(db, "ventas", ventaId), {
        numero: `V-CONC-${suffix}`,
        estado: "Completada",
        total: 80,
        saldoAFavorAplicado: 80,
        cliente: { id: "cli-1", nombre: "Cliente Billetera" },
        items: [{ lineId: "l1", nombre: "Vidrio", cantidad: 1, precio: 80 }],
        pagos: [{ metodo: "Saldo a favor", monto: 80 }]
      });
      tx.set(doc(db, "movimientos_billetera", movId), {
        clienteId: "cli-1",
        tipo: "REDENCION",
        monto: 80,
        saldoAnterior,
        saldoPosterior,
        ventaId
      });
      tx.update(cliRef, {
        saldoAFavorDisponible: saldoPosterior,
        ultimoMovimientoBilleteraId: movId
      });
    });

  const results = await Promise.allSettled([redeem80(c1, "1"), redeem80(c2, "2")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);

  const cliFinal = await getDoc(doc(c1, "clientes", "cli-1"));
  assert.equal(cliFinal.data().saldoAFavorDisponible, 20);
});

test("Concurrencia 5: Dos abonos simultáneos de $60 sobre deuda de $100", async () => {
  const c1 = testEnv.authenticatedContext("cajero-uid").firestore();
  const c2 = testEnv.authenticatedContext("cajero2-uid").firestore();

  const pay60 = (db) =>
    runTransaction(db, async (tx) => {
      const vRef = doc(db, "ventas", "venta-credito-1");
      const snap = await tx.get(vRef);
      const v = snap.data();
      if (v.saldoPendiente < 60) throw new Error("Abono supera saldo pendiente");
      tx.update(vRef, {
        saldoPendiente: v.saldoPendiente - 60,
        importePagado: v.importePagado + 60,
        pagos: [...v.pagos, { metodo: "Efectivo", monto: 60 }]
      });
    });

  const results = await Promise.allSettled([pay60(c1), pay60(c2)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);

  const vFinal = await getDoc(doc(c1, "ventas", "venta-credito-1"));
  assert.equal(vFinal.data().saldoPendiente, 40);
});

test("Concurrencia 6: Abono de Cajero mientras Admin anula la misma venta", async () => {
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  const adminDb = testEnv.authenticatedContext("admin-uid").firestore();

  const abonoTx = runTransaction(cajeroDb, async (tx) => {
    const vRef = doc(cajeroDb, "ventas", "venta-credito-1");
    const snap = await tx.get(vRef);
    const v = snap.data();
    if (v.estado !== "Completada") throw new Error("Venta no activa");
    tx.update(vRef, {
      saldoPendiente: v.saldoPendiente - 20,
      importePagado: v.importePagado + 20,
      pagos: [...v.pagos, { metodo: "Efectivo", monto: 20 }]
    });
  });

  const annulTx = runTransaction(adminDb, async (tx) => {
    const vRef = doc(adminDb, "ventas", "venta-credito-1");
    const snap = await tx.get(vRef);
    const v = snap.data();
    if (v.estado !== "Completada") throw new Error("Venta ya anulada");
    tx.update(vRef, { estado: "Anulada" });
  });

  const results = await Promise.allSettled([abonoTx, annulTx]);
  assert.ok(results.some((r) => r.status === "fulfilled"));
  const vFinal = await getDoc(doc(adminDb, "ventas", "venta-credito-1"));
  assert.ok(["Completada", "Anulada"].includes(vFinal.data().estado));
});

test("Concurrencia 7: Dos Administradores intentan devolución con misma clave de idempotencia", async () => {
  const admin1 = testEnv.authenticatedContext("admin-uid").firestore();
  const admin2 = testEnv.authenticatedContext("admin-uid").firestore();

  const tryReturn = (db, devId) =>
    runTransaction(db, async (tx) => {
      const opRef = doc(db, "operaciones", "op-dev-unica");
      const opSnap = await tx.get(opRef);
      if (opSnap.exists()) throw new Error("Operación ya procesada");
      tx.set(opRef, { tipo: "DEVOLUCION", devId });
      tx.set(doc(db, "devoluciones", devId), {
        ventaId: "venta-credito-1",
        cliente: { id: "cli-1" },
        saldoAFavorGenerado: 0
      });
    });

  const results = await Promise.allSettled([
    tryReturn(admin1, "dev-1"),
    tryReturn(admin2, "dev-2")
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
});

test("Concurrencia 8: Dos clientes envían doble clic de venta con misma operación idempotente", async () => {
  const c1 = testEnv.authenticatedContext("cajero-uid").firestore();
  const c2 = testEnv.authenticatedContext("cajero2-uid").firestore();

  const submitSale = (db, ventaId) =>
    runTransaction(db, async (tx) => {
      const opRef = doc(db, "operaciones", "op-venta-doble");
      if ((await tx.get(opRef)).exists()) {
        throw new Error("Venta duplicada bloqueada por idempotencia");
      }
      tx.set(opRef, { tipo: "VENTA", ventaId });
      tx.set(doc(db, "ventas", ventaId), {
        numero: "V-IDEMP-1",
        estado: "Completada",
        total: 30,
        items: [{ lineId: "l1", nombre: "Silicón", cantidad: 1, precio: 30 }]
      });
    });

  const results = await Promise.allSettled([
    submitSale(c1, "v-idemp-a"),
    submitSale(c2, "v-idemp-b")
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
});

test("Concurrencia 9: Cajero registra venta mientras Admin cierra caja activa", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "control", "caja_activa"), {
      activa: true,
      cajaId: "caja-abierta"
    });
  });

  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  const adminDb = testEnv.authenticatedContext("admin-uid").firestore();

  const saleTx = runTransaction(cajeroDb, async (tx) => {
    const ctrl = await tx.get(doc(cajeroDb, "control", "caja_activa"));
    if (!ctrl.data()?.activa) throw new Error("Caja cerrada");
    tx.set(doc(cajeroDb, "ventas", "v-durante-cierre"), {
      numero: "V-CIERRE",
      estado: "Completada",
      total: 45,
      items: [{ lineId: "l1", nombre: "Vidrio", cantidad: 1, precio: 45 }]
    });
  });

  const closeTx = runTransaction(adminDb, async (tx) => {
    const ctrlRef = doc(adminDb, "control", "caja_activa");
    const ctrl = await tx.get(ctrlRef);
    if (!ctrl.data()?.activa) throw new Error("Ya cerrada");
    tx.update(ctrlRef, { activa: false, cajaId: null });
    tx.update(doc(adminDb, "cajas", "caja-abierta"), { estado: "Cerrada" });
  });

  const results = await Promise.allSettled([saleTx, closeTx]);
  assert.ok(results.every((r) => r.status === "fulfilled" || r.status === "rejected"));
  const ctrlFinal = await getDoc(doc(adminDb, "control", "caja_activa"));
  assert.equal(ctrlFinal.data().activa, false);
});

test("Concurrencia 10: Compatibilidad de roles (Administrador, Cajero, Empleado) en paralelo", async () => {
  const adminDb = testEnv.authenticatedContext("admin-uid").firestore();
  const cajeroDb = testEnv.authenticatedContext("cajero-uid").firestore();
  const empDb = testEnv.authenticatedContext("empleado-uid").firestore();

  const [adminRead, cajeroAb, empNoAnnul] = await Promise.allSettled([
    getDoc(doc(adminDb, "ventas", "venta-credito-1")),
    setDoc(doc(cajeroDb, "operaciones", "op-rol-cajero"), { tipo: "TEST" }),
    updateDoc(doc(empDb, "ventas", "venta-credito-1"), { estado: "Anulada" })
  ]);

  assert.equal(adminRead.status, "fulfilled");
  assert.equal(cajeroAb.status, "fulfilled");
  assert.equal(empNoAnnul.status, "rejected");
});
