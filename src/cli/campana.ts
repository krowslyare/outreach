// Ejecuta la mitad saliente del pipeline.
//
//   npm run campana -- --max 5 --dry-run
//   npm run campana -- --max 5

import "./env.js";

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
  solo?: string;
}

function parseArgs(args: readonly string[]): Argumentos {
  let max: number | undefined;
  let dryRun = false;
  let solo: string | undefined;

  for (let indice = 0; indice < args.length; indice += 1) {
    const argumento = args[indice]!;
    if (argumento === "--dry-run") {
      dryRun = true;
      continue;
    }

    const soloInline = argumento.startsWith("--solo=")
      ? argumento.slice("--solo=".length)
      : undefined;
    if (argumento === "--solo" || soloInline !== undefined) {
      const raw = soloInline ?? args[indice + 1];
      if (soloInline === undefined) indice += 1;
      if (raw === undefined || !/^\+51\d{9}$/.test(raw)) {
        throw new Error(
          "--solo requiere un móvil peruano en E.164, por ejemplo --solo +51931845435",
        );
      }
      solo = raw;
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

  return { max, dryRun, solo };
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

// El horario hábil se abre SOLO apuntando a un número sembrado a mano. Escribir
// a un prospecto real a las 3am delata al bot y quema la cuenta; hacia un
// teléfono propio no protege de nada, y esperar a mañana para probar el canal
// tampoco protege de nada. La condición la resuelve el store —source_id de
// prueba— y no un flag suelto, así que la excusa no se puede invocar sobre un
// prospecto real ni por error de tipeo.
const esPrueba =
  argumentos.solo !== undefined && store.esDestinatarioDePrueba(argumentos.solo);
const config = esPrueba
  ? {
      ...DEFAULT_SAFETY_CONFIG,
      windowStartHour: 0,
      windowEndHour: 24,
      activeWeekdays: [1, 2, 3, 4, 5, 6, 7],
      minGapSeconds: 5,
      maxGapSeconds: 10,
    }
  : DEFAULT_SAFETY_CONFIG;
if (esPrueba) {
  console.info(
    `MODO PRUEBA hacia ${argumentos.solo}: sin ventana horaria y con separación ` +
      `mínima corta. El kill switch, la supresión y el takeover siguen aplicando.`,
  );
} else if (argumentos.solo !== undefined) {
  console.info(
    `--solo ${argumentos.solo}: NO es un número sembrado, así que corre con las ` +
      `reglas completas (ventana horaria incluida).`,
  );
}

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
    // NUMERO_HUMANO es el destino de los escalamientos, así que tenerlo también
    // en la cola significa que el bot le haría outreach en frío a tu propio
    // número de escalamiento. Pasa de verdad: se siembra para probar y queda.
    // Se avisa en vez de suprimirlo solo, porque durante una prueba es
    // exactamente lo que uno quiere.
    if (
      store
        .candidatosParaContactar(200)
        .some((candidato) => candidato.e164 === numeroHumano)
    ) {
      console.warn(
        `\n⚠️  ${numeroHumano} es NUMERO_HUMANO y además está en la cola de contacto.\n` +
          `   El bot le va a escribir en frío a tu propio número de escalamiento.\n` +
          `   Si era una prueba: npm run sembrar -- --e164 ${numeroHumano} --quitar\n`,
      );
    }

    wa = createWaClient();
    const waActivo = wa;
    wa.onAck((waMessageId, ack, at) => {
      store.recordAck(waMessageId, ack, at);
    });
    wa.onInbound((evento) => {
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
          config,
          now: () => new Date(),
          log: (mensaje) => console.log(`[inbound] ${mensaje}`),
        },
        evento,
      ).catch((error: unknown) => {
        // Un fallo atendiendo un inbound no debe tumbar la tanda saliente.
        console.error(`[inbound] error atendiendo ${evento.e164}:`, error);
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
      config,
      now: () => new Date(),
      sleep: delay,
      random: Math.random,
      log: (mensaje) => console.info(mensaje),
    },
    { max: argumentos.max, dryRun: argumentos.dryRun, solo: argumentos.solo },
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
