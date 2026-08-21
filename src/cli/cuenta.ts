// La cuenta de envío, vista y controlada.
//
//   npm run cuenta
//   npm run cuenta -- --levantar-kill-switch
//
// Levantar el kill switch es la única acción que este comando permite, y es
// deliberadamente manual: el switch se activa solo ante eventos graves
// (loggedOut, credenciales rechazadas); quitarlo exige que una persona haya
// leído el motivo y haya decidido que es seguro volver a enviar.

import { Store } from "../wa/store.js";

const args = process.argv.slice(2);
const levantar = args.includes("--levantar-kill-switch");

const store = new Store();
try {
  const ahora = new Date();
  const salud = store.loadAccountHealth(ahora);

  if (levantar) {
    if (!salud.killSwitch.tripped) {
      console.info("El kill switch no estaba activo. Nada que levantar.");
    } else {
      console.info(
        `Motivo que tenía: ${salud.killSwitch.reason ?? "sin detalle"}\n` +
          "Asegúrate de haberlo resuelto antes de correr una campaña.",
      );
      const estabaActivo = store.levantarKillSwitch();
      console.info(
        estabaActivo
          ? "Kill switch levantado. El envío vuelve a depender del resto de las puertas."
          : "Ya había sido levantado en otra ejecución.",
      );
    }
    process.exit(0);
  }

  console.info("Cuenta de envío\n");
  if (salud.killSwitch.tripped) {
    console.info(
      `  Kill switch: ACTIVO desde ${salud.killSwitch.trippedAt?.toISOString() ?? "?"}` +
        `\n    ${salud.killSwitch.reason ?? "sin detalle"}` +
        `\n    Para levantarlo: npm run cuenta -- --levantar-kill-switch`,
    );
  } else {
    console.info("  Kill switch: inactivo");
  }
  console.info(`  Hoy (día ${salud.dayIndex}): ${salud.sentToday} mensaje(s) enviado(s).`);
  console.info(
    salud.deviceRate === null
      ? "  deviceRate: sin muestra todavía."
      : `  deviceRate: ${(salud.deviceRate * 100).toFixed(0)}% de ACK_DEVICE` +
        ` (muestra ${salud.deviceRateSample})` +
        (salud.deviceRateBaseline !== null
          ? `, baseline ${(salud.deviceRateBaseline * 100).toFixed(0)}%`
          : "") +
        ".",
  );
} finally {
  store.close();
}
