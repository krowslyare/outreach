// Ejecuta la mitad saliente del pipeline.
//
//   npm run campana -- --max 5 --dry-run
//   npm run campana -- --max 5

import { clienteAnthropic } from "../agent/cliente.js";
import { ejecutarTanda } from "../sequence/campaign.js";
import { createWaClient, type WaClient } from "../wa/client.js";
import { handleInbound } from "../wa/inbound.js";
import { hardKill } from "../wa/safety.js";
import { Store } from "../wa/store.js";
import { DEFAULT_SAFETY_CONFIG } from "../wa/types.js";

interface Argumentos {
  max?: number;
  dryRun: boolean;
}

function parseArgs(args: readonly string[]): Argumentos {
  let max: number | undefined;
  let dryRun = false;

  for (let indice = 0; indice < args.length; indice += 1) {
    const argumento = args[indice]!;
    if (argumento === "--dry-run") {
      dryRun = true;
      continue;
    }

    const inline = argumento.startsWith("--max=")
      ? argumento.slice("--max=".length)
      : undefined;
    if (argumento === "--max" || inline !== undefined) {
      const raw = inline ?? args[indice + 1];
      if (inline === undefined) indice += 1;
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(
          "--max requiere un entero positivo, por ejemplo --max 5",
        );
      }
      max = parsed;
      continue;
    }

    throw new Error(`argumento desconocido: ${argumento}`);
  }

  return { max, dryRun };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const argumentos = parseArgs(process.argv.slice(2));
const store = new Store();
let wa: WaClient | null = null;

try {
  let client: Pick<WaClient, "sendText">;
  if (argumentos.dryRun) {
    console.info(
      "DRY RUN: se compondrán mensajes, pero WhatsApp no se iniciará ni enviará nada.",
    );
    client = {
      sendText: async () => {
        // Si el runner rompe el contrato del dry-run, fallamos cerrado en vez
        // de crear accidentalmente una sesión real de WhatsApp.
        throw new Error("dry-run intentó enviar un mensaje");
      },
    };
  } else {
    console.warn(
      "ATENCIÓN: MODO REAL. Esta ejecución enviará mensajes por WhatsApp.",
    );
    wa = createWaClient();
    wa.onAck((waMessageId, ack, at) => {
      store.recordAck(waMessageId, ack, at);
    });
    wa.onInbound((e164, body, at) => {
      handleInbound({ store }, e164, body, at);
    });
    wa.onFatal((reason) => {
      // Un fallo de autenticación o conflicto debe frenar cualquier intento
      // posterior, incluso si la tanda actual alcanza a continuar.
      store.tripKillSwitch(hardKill(reason, new Date()));
    });
    await wa.start();
    client = wa;
  }

  const resumen = await ejecutarTanda(
    {
      store,
      cliente: clienteAnthropic(),
      client,
      config: DEFAULT_SAFETY_CONFIG,
      now: () => new Date(),
      sleep: delay,
      random: Math.random,
      log: (mensaje) => console.info(mensaje),
    },
    { max: argumentos.max, dryRun: argumentos.dryRun },
  );

  if (argumentos.dryRun) {
    for (const mensaje of resumen.mensajesCompuestos) {
      console.info(
        `\n${mensaje.nombre} — ${mensaje.e164} [${mensaje.paso}]\n${mensaje.texto}`,
      );
    }
  }

  console.info("\nResumen de tanda:");
  console.info(`  enviados: ${resumen.enviados}`);
  console.info(
    `  saltados por destinatario: ${resumen.saltadosPorDestinatario}`,
  );
  console.info(`  fallos de composición: ${resumen.fallosComposicion}`);
  if (argumentos.dryRun) {
    console.info(
      `  mensajes compuestos para revisión: ${resumen.mensajesCompuestos.length}`,
    );
  }
  console.info(`  terminó por: ${resumen.motivoTerminacion}`);
} finally {
  if (wa !== null) await wa.stop();
  store.close();
}
