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

  // Paso 3 — el portal, si está configurado.
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
