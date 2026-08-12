// Ejecuta la mitad saliente del pipeline.
//
//   npm run campana -- --max 5 --dry-run
//   npm run campana -- --max 5

import "./env.js";

import { crearProveedor, modeloAnunciado } from "../llm/index.js";
import {
  esVerticalId,
  VERTICAL_IDS,
  type VerticalId,
} from "../prospects/verticals.js";
import { ejecutarTanda } from "../sequence/campaign.js";
import type { PasoCampana } from "../sequence/compose.js";
import { cargarVisualesAprobados } from "../sequence/visual.js";
import { createWaClient, type WaClient } from "../wa/client.js";
import {
  atenderNumero,
  ingerirInbound,
  reintentarPendientes,
  type ConversacionDeps,
} from "../orquestador/conversacion.js";
import { crearAgrupador } from "../orquestador/rafaga.js";
import { hardKill } from "../wa/safety.js";
import { Store } from "../wa/store.js";
import {
  DEFAULT_SAFETY_CONFIG,
  type SafetyConfig,
} from "../wa/types.js";

interface Argumentos {
  max?: number;
  dryRun: boolean;
  paso?: PasoCampana;
  solo?: string;
  solos?: readonly string[];
  escuchar: boolean;
  sinTanda: boolean;
  soloFollowUps: boolean;
  vertical?: VerticalId;
  visuales?: string;
}

function parseArgs(args: readonly string[]): Argumentos {
  let max: number | undefined;
  let dryRun = false;
  let paso: PasoCampana | undefined;
  const solos: string[] = [];
  let escuchar = false;
  let sinTanda = false;
  // Bloqueo operativo vigente desde la primera restricción de WhatsApp:
  // ninguna ejecución normal puede abrir chats nuevos hasta que el dueño
  // autorice explícitamente levantarlo y se cambie esta política.
  let soloFollowUps = true;
  let vertical: VerticalId | undefined;
  let visuales: string | undefined;

  for (let indice = 0; indice < args.length; indice += 1) {
    const argumento = args[indice]!;
    if (argumento === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argumento === "--escuchar") {
      escuchar = true;
      continue;
    }
    if (argumento === "--sin-tanda") {
      // Implica escuchar: un proceso que ni envía ni escucha no hace nada.
      sinTanda = true;
      escuchar = true;
      continue;
    }
    if (argumento === "--solo-followups") {
      soloFollowUps = true;
      continue;
    }

    const pasoInline = argumento.startsWith("--paso=")
      ? argumento.slice("--paso=".length)
      : undefined;
    if (argumento === "--paso" || pasoInline !== undefined) {
      const raw = pasoInline ?? args[indice + 1];
      if (pasoInline === undefined) indice += 1;
      if (raw !== "first" && raw !== "fu1" && raw !== "fu2") {
        throw new Error("--paso requiere uno de: first, fu1, fu2");
      }
      paso = raw;
      continue;
    }

    const visualesInline = argumento.startsWith("--visuales=")
      ? argumento.slice("--visuales=".length)
      : undefined;
    if (argumento === "--visuales" || visualesInline !== undefined) {
      const raw = visualesInline ?? args[indice + 1];
      if (visualesInline === undefined) indice += 1;
      if (raw === undefined || raw.trim() === "") {
        throw new Error("--visuales requiere la ruta a un manifest.json aprobado");
      }
      visuales = raw;
      continue;
    }

    const verticalInline = argumento.startsWith("--vertical=")
      ? argumento.slice("--vertical=".length)
      : undefined;
    if (argumento === "--vertical" || verticalInline !== undefined) {
      const raw = verticalInline ?? args[indice + 1];
      if (verticalInline === undefined) indice += 1;
      if (raw === undefined || !esVerticalId(raw)) {
        throw new Error(
          `--vertical requiere uno de: ${VERTICAL_IDS.join(", ")}`,
        );
      }
      vertical = raw;
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
      solos.push(raw);
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

  if (escuchar && dryRun) {
    throw new Error(
      "--escuchar no tiene sentido con --dry-run: el dry-run no inicia WhatsApp, " +
        "así que no hay nada que escuchar.",
    );
  }
  if (sinTanda && visuales !== undefined) {
    throw new Error("--visuales no tiene efecto con --sin-tanda");
  }
  if (soloFollowUps && paso === "first") {
    throw new Error("--solo-followups no puede combinarse con --paso first");
  }

  return {
    max,
    dryRun,
    paso,
    solo: solos.length === 1 ? solos[0] : undefined,
    solos: solos.length > 0 ? solos : undefined,
    escuchar,
    sinTanda,
    soloFollowUps,
    vertical,
    visuales,
  };
}

/**
 * Mantiene el proceso vivo hasta Ctrl-C.
 *
 * Sin esto, la tanda terminaba y el proceso salía llevándose el listener: las
 * respuestas del prospecto llegaban al teléfono sin nadie escuchando, y los ACK
 * —que llegan segundos DESPUÉS del envío— no se registraban nunca. Eso último
 * dejaba `deviceRate` permanentemente en null, o sea el kill switch ciego por
 * construcción.
 */
function esperarInterrupcion(): Promise<void> {
  return new Promise((resolve) => {
    const terminar = (): void => {
      console.info("\nCerrando la sesión...");
      resolve();
    };
    process.once("SIGINT", terminar);
    process.once("SIGTERM", terminar);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * libsignal 2.0 imprime `SessionEntry` completo al cerrar una sesión de cifrado,
 * incluyendo claves privadas efímeras. No es un log útil para operar el bot y
 * termina dejando material criptográfico en terminales y recolectores de logs.
 *
 * Se filtra solo esa firma exacta y se devuelve un restaurador para no dejar
 * `console.info` alterado después de cerrar WhatsApp.
 */
function ocultarLogsSensiblesLibsignal(): () => void {
  const original = console.info;
  console.info = (...args: unknown[]): void => {
    if (
      args[0] === "Closing session:" ||
      args[0] === "Removing old closed session:"
    ) {
      return;
    }
    original(...args);
  };
  return () => {
    console.info = original;
  };
}

const argumentos = parseArgs(process.argv.slice(2));
if (argumentos.soloFollowUps && !argumentos.sinTanda) {
  console.info(
    "MODO SOLO FOLLOW-UPS: no se abrirán chats nuevos hasta nuevo aviso.",
  );
}
const visuales =
  argumentos.visuales === undefined
    ? undefined
    : cargarVisualesAprobados(argumentos.visuales);
if (visuales !== undefined) {
  console.info(
    `Cohorte visual aprobada: ${visuales.size} destinatario(s). ` +
      "La tanda no considerará números fuera del manifiesto.",
  );
}
// Dos proveedores porque son dos trabajos distintos: componer el mensaje en
// frío —donde la calidad es lo que evita que te bloqueen— y conversar, donde
// pesa más seguir las reglas duras. Ver src/llm/index.ts.
const proveedorCompositor = crearProveedor("compositor");
const proveedorAgente = crearProveedor("agente");
// Se anuncia antes de iniciar WhatsApp o componer mensajes para que el
// operador pueda detener una ejecución apuntada al proveedor equivocado.
console.info(
  `Proveedor LLM: ${proveedorCompositor.nombre}` +
    ` — compositor: ${modeloAnunciado("compositor")}` +
    ` · agente: ${modeloAnunciado("agente")}`,
);
const store = new Store();
// Agrupa las ráfagas de un mismo chat en una sola respuesta. Ver rafaga.ts.
const agrupador = crearAgrupador();
// Número al que se escala. Sin esto el handoff no tiene a quién avisar, así que
// se exige explícitamente en vez de fallar recién cuando alguien esté caliente.
const numeroHumano = process.env.NUMERO_HUMANO?.trim();
let wa: WaClient | null = null;
let restaurarConsoleInfo: (() => void) | null = null;
// Se define recién cuando hay sesión de WhatsApp: sin cliente no hay a quién
// responderle, y un dry-run no debe poder llamar al agente por accidente.
let depsConversacion: (configConversacion?: SafetyConfig) => ConversacionDeps = () => {
  throw new Error("no hay sesión de WhatsApp: no se puede atender inbound");
};

// El horario hábil se abre SOLO apuntando a un número sembrado a mano. Escribir
// a un prospecto real a las 3am delata al bot y quema la cuenta; hacia un
// teléfono propio no protege de nada, y esperar a mañana para probar el canal
// tampoco protege de nada. La condición la resuelve el store —source_id de
// prueba— y no un flag suelto, así que la excusa no se puede invocar sobre un
// prospecto real ni por error de tipeo.
const soloDePrueba = argumentos.solo;
const esPrueba =
  soloDePrueba !== undefined && store.esDestinatarioDePrueba(soloDePrueba);
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
    `MODO PRUEBA hacia ${soloDePrueba}: sin ventana horaria y con separación ` +
      `mínima corta. El kill switch, la supresión y el takeover siguen aplicando.`,
  );
} else if (argumentos.solo !== undefined) {
  console.info(
    `--solo ${argumentos.solo}: NO es un número sembrado, así que corre con las ` +
      `reglas completas (ventana horaria incluida).`,
  );
}

try {
  let client: Pick<WaClient, "sendText" | "sendImage">;
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
      sendImage: async () => {
        throw new Error("dry-run intentó enviar una imagen");
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
    restaurarConsoleInfo = ocultarLogsSensiblesLibsignal();
    // Una sola definición para los dos caminos que llaman al agente —el
    // entrante en vivo y el barrido de pendientes— porque si divergen, uno de
    // los dos corre con otras puertas de seguridad y nadie lo nota.
    depsConversacion = (configConversacion = config) => ({
      store,
      proveedor: proveedorAgente,
      enviar: (destino: string, texto: string) => waActivo.sendText(destino, texto),
      handoff: { numeroHumano },
      config: configConversacion,
      now: () => new Date(),
      log: (mensaje: string) => console.log(`[inbound] ${mensaje}`),
    });
    wa.onAck((waMessageId, ack, at) => {
      store.recordAck(waMessageId, ack, at);
    });
    wa.onInbound((evento) => {
      // Va al ORQUESTADOR, no a handleInbound: aquél solo registra y aplica el
      // opt-out; el orquestador es el único camino que llama al agente y
      // ejecuta el handoff. Con el de bajo nivel, un prospecto que responde
      // durante la tanda queda registrado y sin respuesta — y si quería
      // contratar, sin escalar.
      //
      // El horario relajado de una prueba SOLO pertenece al número indicado en
      // --solo. El socket también oye a todos los contactos históricos; usar
      // `config` sin distinguirlos haría que un prospecto real que escriba a
      // las 5am reciba respuesta automática porque casualmente había una prueba
      // corriendo contra otro teléfono.
      const configInbound =
        esPrueba && evento.e164 === soloDePrueba
          ? config
          : DEFAULT_SAFETY_CONFIG;
      const deps = depsConversacion(configInbound);
      // El registro es inmediato —opt-out e idempotencia no pueden esperar— y
      // solo la RESPUESTA se agrupa. Sin esto, tres mensajes seguidos del mismo
      // prospecto producían tres respuestas encadenadas: correctas y en orden,
      // pero inconfundiblemente de una máquina.
      const ingesta = ingerirInbound(deps, evento);
      if (!ingesta.atender) return;

      void agrupador
        .programar(evento.e164, async () => {
          await atenderNumero(deps, evento.e164);
        })
        .catch((error: unknown) => {
          // Un fallo atendiendo un inbound no debe tumbar la tanda saliente.
          console.error(`[inbound] error atendiendo ${evento.e164}:`, error);
        });
    });
    wa.onEnvioManual((e164, waMessageId) => {
      // Segunda barrera: el Set del cliente no conoce lo que mandó una
      // ejecución anterior. Sin esto, reiniciar el proceso haría que sus
      // propios envíos recientes parecieran escritos a mano — y el falso
      // positivo mata la conversación con ese prospecto para siempre.
      if (store.esMensajeNuestro(waMessageId)) return;
      // Escribirle a alguien que no es de la campaña es lo normal: es tu
      // teléfono. loadRecipientState LANZA para un desconocido y esto corre sin
      // await, así que sin esta guarda la excepción terminaba como unhandled
      // rejection y se llevaba el proceso entero.
      if (!store.existeDestinatario(e164)) return;
      const estado = store.loadRecipientState(e164);
      if (estado.humanTakeover) return;
      store.setHumanTakeover(e164);
      console.info(
        `[takeover] escribiste a ${e164} desde tu teléfono: el bot ya no le ` +
          `escribe más a ese número.`,
      );
    });
    wa.onFatal((reason) => {
      // Un fallo de autenticación o conflicto debe frenar cualquier intento
      // posterior, incluso si la tanda actual alcanza a continuar.
      store.tripKillSwitch(hardKill(reason, new Date()));
    });
    await wa.start();
    client = wa;
  }

  const resumen = argumentos.sinTanda
    ? null
    : await ejecutarTanda(
        {
          store,
          proveedor: proveedorCompositor,
          client,
          config,
          now: () => new Date(),
          sleep: delay,
          random: Math.random,
          log: (mensaje) => console.info(mensaje),
        },
        {
          max: argumentos.max,
          dryRun: argumentos.dryRun,
          paso: argumentos.paso,
          soloFollowUps: argumentos.soloFollowUps,
          solo: argumentos.solo,
          solos: argumentos.solos,
          vertical: argumentos.vertical,
          visuales,
        },
      );

  if (resumen === null) {
    console.info("Sin tanda: solo se queda escuchando.");
  } else if (argumentos.dryRun) {
    for (const mensaje of resumen.mensajesCompuestos) {
      const media =
        mensaje.tipo === "image" ? `\n[imagen 16:9: ${mensaje.imagen}]` : "";
      console.info(
        `\n${mensaje.nombre} — ${mensaje.e164} [${mensaje.paso}/${mensaje.intencionApertura}]` +
          `${media}\n${mensaje.texto}`,
      );
    }
  }

  if (resumen !== null) {
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
  }

  if (argumentos.escuchar) {
    // Cobra lo que quedó debiendo: respuestas diferidas por horario, y lo que
    // llegó o quedó a medias mientras el proceso no estaba. Se corre una vez al
    // entrar y después cada pocos minutos; el intervalo es corto frente a la
    // hora a la que abre la ventana, así que apenas abre se despacha solo.
    // Un barrido puede tardar más que su intervalo —20 chats por una llamada al
    // LLM cada uno raspa los cinco minutos— y dos corriendo a la vez son dos
    // respuestas al mismo prospecto. El candado por chat los pone en fila pero
    // no evita el duplicado; eso lo resuelve releer los pendientes adentro del
    // candado (ver atenderYSaldar). Esto además evita que se apilen.
    let barriendo = false;
    const cobrarPendientes = async (): Promise<void> => {
      if (barriendo) return;
      barriendo = true;
      try {
        // El barrido incluye todos los números pendientes, no solo el objetivo
        // de --solo. Por eso nunca hereda el horario relajado del modo prueba.
        const resumen = await reintentarPendientes(
          depsConversacion(esPrueba ? DEFAULT_SAFETY_CONFIG : config),
        );
        if (resumen.numeros > 0) {
          console.info(
            `[pendientes] ${resumen.numeros} número(s): ${resumen.respondidos} ` +
              `respondido(s), ${resumen.siguenDiferidos} sigue(n) esperando ventana.`,
          );
        }
      } catch (error) {
        console.error("[pendientes] falló el barrido:", error);
      } finally {
        barriendo = false;
      }
    };
    await cobrarPendientes();
    const reloj = setInterval(() => void cobrarPendientes(), 5 * 60_000);
    // Sin unref, este timer solo mantendría el proceso vivo sin razón cuando
    // todo lo demás ya terminó.
    reloj.unref();

    console.info(
      "\nEscuchando respuestas y ACKs. Ctrl-C para salir.\n" +
        "  Mientras esto corra: las respuestas van al agente y los ACK alimentan\n" +
        "  deviceRate, que es la señal del kill switch. Si el proceso no está\n" +
        "  vivo, ninguna de las dos cosas ocurre.",
    );
    await esperarInterrupcion();
  }
} finally {
  // Lo que estaba esperando el silencio se contesta antes de cerrar: descartarlo
  // dejaría a alguien que escribió sin respuesta y sin nada que lo indique.
  await agrupador.vaciar();
  if (wa !== null) await wa.stop();
  restaurarConsoleInfo?.();
  store.close();
}
