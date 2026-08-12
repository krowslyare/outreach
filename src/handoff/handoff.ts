// M6: el handoff. Cierra el end-to-end pasándote la conversación cuando el
// prospecto está listo.
//
// El orden de los pasos es lo único delicado de este módulo, y no es
// intercambiable. Ver ejecutarHandoff.

import type { AgentDecision } from "../agent/agent.js";

/** Lo mínimo del store que necesita el handoff. Puerto angosto para testear. */
export interface StoreHandoff {
  loadRecipientState(e164: string): { humanTakeover: boolean };
  setHumanTakeover(e164: string): void;
  suppress(e164: string, reason: string): void;
  /** El acuse al prospecto también es un saliente y tiene que quedar en el hilo. */
  recordOutboundLibre(
    e164: string,
    body: string,
    waMessageId: string,
    at: Date,
  ): void;
}

/**
 * Destino de la Oportunidad en el portal. Opcional a propósito: el handoff
 * tiene que servir desde el día uno con solo la notificación, y el write al
 * portal se enchufa después sin tocar este flujo.
 */
export interface PortalClient {
  crearOportunidad(datos: {
    e164: string;
    nombre: string;
    motivo: string;
    resumen: string;
  }): Promise<void>;
}

export interface HandoffDeps {
  store: StoreHandoff;
  /** Mismo canal que usa el bot. A un contacto conocido no hay riesgo de ban. */
  enviar(e164: string, texto: string): Promise<string>;
  /** Número de Hideki, en E.164. */
  numeroHumano: string;
  now(): Date;
  portal?: PortalClient;
  log?: (mensaje: string) => void;
}

export type ResultadoHandoff =
  | { estado: "ejecutado"; notificado: boolean; portalOk: boolean }
  | { estado: "ya_estaba"; }
  | { estado: "no_aplica" };

/**
 * Ejecuta el handoff de una decisión del agente.
 *
 * EL ORDEN IMPORTA Y NO ES INTERCAMBIABLE:
 *
 * 1. Primero el lock de takeover. Es lo único que impide que el bot vuelva a
 *    escribirle a alguien con quien ya estás hablando tú. Si esto se hiciera
 *    después de notificar y la notificación fallara, quedaría una conversación
 *    caliente con el bot todavía suelto encima — el peor error del sistema.
 * 2. Después la notificación. Si falla, el lock ya está puesto: pierdes el
 *    aviso, no el control.
 * 3. Al final el portal, que es lo más prescindible de los tres.
 *
 * Idempotente: si ya hubo takeover no vuelve a notificar. Los reintentos y los
 * eventos duplicados no deben inundarte de avisos repetidos.
 */
export async function ejecutarHandoff(
  deps: HandoffDeps,
  e164: string,
  nombre: string,
  decision: AgentDecision,
): Promise<ResultadoHandoff> {
  if (decision.kind === "responder") return { estado: "no_aplica" };

  if (decision.kind === "perdido") {
    // Un no claro se respeta y se suprime. No se te notifica: no hay nada que
    // hacer y un aviso por cada rechazo es ruido que te entrena a ignorarlos.
    deps.store.suppress(e164, `perdido: ${decision.motivo}`);
    deps.log?.(`perdido ${e164} (${decision.motivo})`);
    return { estado: "ejecutado", notificado: false, portalOk: false };
  }

  const estado = deps.store.loadRecipientState(e164);
  if (estado.humanTakeover) return { estado: "ya_estaba" };

  // Paso 1 — el lock, antes que cualquier cosa que pueda fallar.
  deps.store.setHumanTakeover(e164);

  // Paso 2 — el aviso. No se propaga el error: el lock ya te protegió, y
  // reventar acá no arregla nada.
  let notificado = false;
  try {
    await deps.enviar(deps.numeroHumano, mensajeParaHumano(nombre, e164, decision));
    notificado = true;
  } catch (error) {
    deps.log?.(`FALLÓ la notificación de handoff para ${e164}: ${String(error)}`);
  }

  // Paso 3 — cerrarle el turno al prospecto.
  //
  // Antes no existía: el lock dejaba al bot mudo y el prospecto se quedaba
  // mirando su propio "me interesa" sin respuesta hasta que un humano abriera
  // WhatsApp. El mensaje más caliente de todo el flujo era el único que recibía
  // silencio, y de madrugada eso son horas.
  //
  // Va DESPUÉS del aviso a propósito: si algo va a fallar, es preferible que
  // falle esto —el prospecto espera sin saberlo— a que falle el aviso, que es
  // el único camino por el que alguien se entera y lo arregla.
  try {
    const texto = mensajeParaProspecto(decision);
    const waMessageId = await deps.enviar(e164, texto);
    // Se registra como cualquier otro saliente. Sin esto, lo ÚLTIMO que le
    // dijimos al prospecto no existía en la base: el hilo guardado terminaba en
    // su "me interesa" y quien abriera el historial —o el agente, si algún día
    // se levanta el takeover— no vería que ya le respondimos.
    deps.store.recordOutboundLibre(e164, texto, waMessageId, deps.now());
  } catch (error) {
    deps.log?.(`FALLÓ el acuse al prospecto ${e164}: ${String(error)}`);
  }

  // Paso 4 — el portal, si está configurado.
  let portalOk = false;
  if (deps.portal !== undefined) {
    try {
      await deps.portal.crearOportunidad({
        e164,
        nombre,
        motivo: decision.motivo,
        resumen: decision.resumen,
      });
      portalOk = true;
    } catch (error) {
      deps.log?.(`FALLÓ el write al portal para ${e164}: ${String(error)}`);
    }
  }

  return { estado: "ejecutado", notificado, portalOk };
}

/**
 * Lo que le llega al prospecto cuando la conversación pasa a un humano.
 *
 * Es texto fijo y no una respuesta del modelo, por dos razones. Es el mensaje
 * más caro del flujo —la persona ya dijo que le interesa— así que no se juega a
 * que el modelo tenga un buen día. Y el agente, cuando escala, devuelve la
 * herramienta y NADA de texto (ver interpretarDecision en agent.ts), de modo que
 * éste es el único mensaje que sale: no hay riesgo de decir dos cosas distintas.
 *
 * Nunca dice "Hideki". Un nombre propio que la persona no ha oído nunca no
 * genera confianza, genera "¿y ése quién es?". El rol sí se entiende, y el
 * nombre lo pone el propio Hideki cuando entra al chat.
 */
export function mensajeParaProspecto(
  decision: Extract<AgentDecision, { kind: "escalar" }>,
): string {
  // Una queja no se responde con un menú de opciones: ofrecerle a alguien
  // molesto que elija entre llamada y reunión suena a que no lo escucharon.
  if (decision.motivo === "queja") {
    return (
      "Entiendo, y lamento el inconveniente. Lo paso ahora mismo con la persona " +
      "a cargo para que lo vea con usted directamente."
    );
  }

  const respuestaConcreta = decision.respuestaConcreta?.trim();
  const prefijo =
    respuestaConcreta === undefined || respuestaConcreta === ""
      ? ""
      : `${respuestaConcreta}\n\n`;

  // Tres opciones y no solo "una llamada": la llamada tiene fricción —hay que
  // agendarla, contestar, estar libre— y seguir por el chat no tiene ninguna.
  // Dejar elegir quita la excusa de "ahorita no puedo hablar".
  return (
    prefijo +
    "Le paso la conversación con el dueño del estudio para que lo " +
    "vea con usted directamente.\n" +
    "¿Cómo prefiere: una llamada corta, una reunión, o seguimos por acá?"
  );
}

const ETIQUETA_MOTIVO: Record<string, string> = {
  quiere_contratar: "QUIERE CONTRATAR",
  pide_reunion: "pide reunión",
  negocia_precio: "quiere negociar precio",
  contrato_o_legal: "pregunta por contrato o tema legal",
  queja: "QUEJA",
  pide_humano: "pidió hablar con una persona",
  fuera_de_mi_alcance: "fuera del alcance del agente",
};

/**
 * El mensaje que te llega. Corto y accionable: lo vas a leer en el celular,
 * probablemente haciendo otra cosa. Lo primero tiene que ser por qué te
 * interrumpo, y lo último el link para responder sin buscar el número.
 */
export function mensajeParaHumano(
  nombre: string,
  e164: string,
  decision: Extract<AgentDecision, { kind: "escalar" }>,
): string {
  const etiqueta = ETIQUETA_MOTIVO[decision.motivo] ?? decision.motivo;
  const resumen = decision.resumen.trim();

  return [
    `🔔 ${etiqueta}`,
    ``,
    `${nombre}`,
    resumen.length > 0 ? resumen : "(el agente no dejó resumen)",
    ``,
    `Responde tú: https://wa.me/${e164.replace(/^\+/, "")}`,
    `El bot ya no le escribe más a este número.`,
  ].join("\n");
}
