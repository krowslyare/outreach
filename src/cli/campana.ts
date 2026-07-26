// Ejecuta la mitad saliente del pipeline.
//
//   npm run campana -- --max 5 --dry-run
//   npm run campana -- --max 5

import { crearProveedor } from "../llm/index.js";
import { ejecutarTanda } from "../sequence/campaign.js";
import { createWaClient, type WaClient } from "../wa/client.js";
import { manejarInbound } from "../orquestador/conversacion.js";
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
const proveedor = crearProveedor();
// Se anuncia antes de iniciar WhatsApp o componer mensajes para que el
// operador pueda detener una ejecución apuntada al proveedor equivocado.
console.info(`Proveedor LLM: ${proveedor.nombre}`);
const store = new Store();
// Número al que se escala. Sin esto el handoff no tiene a quién avisar, así que
// se exige explícitamente en vez de fallar recién cuando alguien esté caliente.
const numeroHumano = process.env.NUMERO_HUMANO?.trim();
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
    if (numeroHumano === undefined || numeroHumano === "") {
      throw new Error(
        "Falta NUMERO_HUMANO (E.164). Es a donde se escala cuando un prospecto " +
          "está listo; sin eso, una conversación caliente se perdería.",
      );
    }
    wa = createWaClient();
    const waActivo = wa;
    wa.onAck((waMessageId, ack, at) => {
      store.recordAck(waMessageId, ack, at);
    });
    wa.onInbound((e164, body, at) => {
      // Va al ORQUESTADOR, no a handleInbound. handleInbound solo registra y
      // aplica el opt-out; manejarInbound es el único camino que llama al
      // agente y ejecuta el handoff. Con el de bajo nivel, un prospecto que
      // responde durante la tanda queda registrado y sin respuesta — y si
      // quería contratar, sin escalar.
      void manejarInbound(
        {
          store,
          proveedor,
          enviar: (destino, texto) => waActivo.sendText(destino, texto),
          handoff: { numeroHumano },
          config: DEFAULT_SAFETY_CONFIG,
          now: () => new Date(),
          log: (mensaje) => console.log(`[inbound] ${mensaje}`),
        },
        e164,
        body,
        at,
      ).catch((error: unknown) => {
        // Un fallo atendiendo un inbound no debe tumbar la tanda saliente.
        console.error(`[inbound] error atendiendo ${e164}:`, error);
      });
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
      proveedor,
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
