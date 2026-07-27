// El cable que faltaba: inbound → agente → (responder | handoff).
//
// Hasta acá cada módulo existía y estaba testeado, pero nada los llamaba:
// inbound.ts terminaba en `needs_agent` y ejecutarHandoff no tenía call site
// real. Este módulo es el único lugar donde se juntan, y por eso concentra las
// decisiones sobre qué puertas de seguridad aplican a una respuesta.

import { decidirRespuesta, type Turno } from "../agent/agent.js";
import { ejecutarHandoff, type HandoffDeps } from "../handoff/handoff.js";
import type { ProveedorLLM } from "../llm/port.js";
import type { InboundEvent } from "../wa/client.js";
import { handleInbound } from "../wa/inbound.js";
import { zonedParts } from "../wa/safety.js";
import { CLASIFICACION_STUB_INBOUND, type Store } from "../wa/store.js";
import type { SafetyConfig } from "../wa/types.js";

export type ResultadoConversacion =
  | { accion: "suprimido" }
  | { accion: "duplicado" }
  /** Autorespondedor: se registró, no se contesta y la cadencia sigue viva. */
  | { accion: "automatico"; razon: string }
  | { accion: "ignorado"; razon: string }
  | { accion: "respondido"; texto: string }
  | { accion: "escalado"; motivo: string }
  | { accion: "perdido"; motivo: string }
  | { accion: "diferido"; razon: string };

export interface ConversacionDeps {
  store: Pick<
    Store,
    | "recordInbound"
    | "marcarInboundAtendido"
    | "ultimoOutboundAt"
    | "suppress"
    | "loadRecipientState"
    | "loadConversacion"
    | "loadFichaProspecto"
    | "loadAccountHealth"
    | "recordOutboundLibre"
    | "setHumanTakeover"
  >;
  proveedor: ProveedorLLM;
  enviar(e164: string, texto: string): Promise<string>;
  handoff: Omit<HandoffDeps, "store" | "enviar">;
  config: SafetyConfig;
  now(): Date;
  log?: (mensaje: string) => void;
}

/**
 * Puertas que aplican a una RESPUESTA, que no son las mismas que a un mensaje
 * frío. Esto es una decisión de diseño, no un olvido:
 *
 * - Kill switch, supresión y takeover humano: aplican igual. Son absolutas.
 * - Horario hábil: aplica. Contestar a las 3am delata al bot.
 * - Tope diario y separación mínima: NO aplican. Existen para limitar la
 *   iniciativa hacia desconocidos, que es lo que genera bloqueos. Alguien que
 *   ya nos escribió no es un desconocido, y dejarlo sin respuesta porque se
 *   acabó la cuota de outreach del día es peor para la conversación y no
 *   protege el número de nada.
 */
function puedeResponder(
  deps: ConversacionDeps,
  ahora: Date,
): { ok: true } | { ok: false; razon: string } {
  const salud = deps.store.loadAccountHealth(ahora);
  if (salud.killSwitch.tripped) {
    return { ok: false, razon: `kill switch activo: ${salud.killSwitch.reason ?? "sin detalle"}` };
  }

  const { hour, weekday } = zonedParts(ahora, deps.config.timezone);
  if (!deps.config.activeWeekdays.includes(weekday)) {
    return { ok: false, razon: `día no activo (weekday ${weekday})` };
  }
  if (hour < deps.config.windowStartHour || hour >= deps.config.windowEndHour) {
    return { ok: false, razon: `fuera de la ventana horaria (${hour}:00)` };
  }

  return { ok: true };
}

/**
 * Un entrante se marca atendido solo cuando la decisión llegó a un final.
 *
 * `duplicado` ya estaba marcado. `diferido` NO lo está a propósito: no se envió
 * nada y la respuesta se sigue debiendo, así que debe poder reintentarse. Y si
 * `resolver` lanza —falla el LLM, el handoff o el envío— no se marca nada y el
 * evento queda elegible para reprocesarse: quedarse callado con alguien que
 * escribió es peor que contestarle dos veces.
 */
function cerroElCiclo(resultado: ResultadoConversacion): boolean {
  return resultado.accion !== "duplicado" && resultado.accion !== "diferido";
}

export async function manejarInbound(
  deps: ConversacionDeps,
  evento: InboundEvent,
): Promise<ResultadoConversacion> {
  const resultado = await resolver(deps, evento);
  if (cerroElCiclo(resultado)) {
    deps.store.marcarInboundAtendido(evento.waMessageId, deps.now());
  }
  return resultado;
}

async function resolver(
  deps: ConversacionDeps,
  evento: InboundEvent,
): Promise<ResultadoConversacion> {
  const e164 = evento.e164;
  // 1. Rastro, idempotencia, opt-out y clasificación. Todo antes del agente.
  const inbound = handleInbound({ store: deps.store }, evento);
  if (inbound.action === "duplicate") return { accion: "duplicado" };
  if (inbound.action === "suppressed") return { accion: "suprimido" };
  // Un autorespondedor no es el prospecto hablando: ni se le contesta ni se
  // gasta una llamada al LLM en él. Y, sobre todo, la cadencia de follow-ups
  // sigue viva — de eso se encarga canContact leyendo lastHumanInboundAt.
  if (inbound.action === "automatic") {
    deps.log?.(`inbound automático de ${e164}: ${inbound.motivo}`);
    return { accion: "automatico", razon: inbound.motivo };
  }

  // 2. Un número que no es de campaña no se contesta solo. Puede ser cualquiera
  //    escribiendo al número; el agente no tiene contexto y responder sería
  //    improvisar.
  // Doble barrera a propósito. `recordInbound` crea un destinatario stub para
  // no perder el mensaje por la clave foránea, y ese stub puede confundirse con
  // una ficha real. El store ya los filtra por source_id, pero el modo de falla
  // acá es "el bot le contesta a cualquiera que escriba al número", y para eso
  // una sola barrera basada en un patrón de string es poco.
  const ficha = deps.store.loadFichaProspecto(e164);
  if (ficha === null || ficha.clasificacion === CLASIFICACION_STUB_INBOUND) {
    deps.log?.(`inbound de ${e164}, ajeno a la campaña: requiere atención manual`);
    return { accion: "ignorado", razon: "número fuera de la campaña" };
  }

  // 3. Si ya lo tomó un humano, el bot no vuelve a hablar. Nunca.
  const estado = deps.store.loadRecipientState(e164);
  if (estado.humanTakeover) {
    return { accion: "ignorado", razon: "conversación tomada por humano" };
  }
  if (estado.suppressed) {
    return { accion: "ignorado", razon: "destinatario suprimido" };
  }

  // 4. El agente decide.
  const historial: Turno[] = deps.store.loadConversacion(e164).map((m) => ({
    rol: m.direction === "in" ? "prospecto" : "nosotros",
    texto: m.body,
  }));

  // El inbound ya quedó registrado en el paso 1, así que el último turno es el
  // del prospecto — que es justo lo que decidirRespuesta exige.
  const decision = await decidirRespuesta(deps.proveedor, ficha, historial);

  // 5. Escalar y perder van al handoff, que pone el lock antes de nada.
  if (decision.kind !== "responder") {
    const resultado = await ejecutarHandoff(
      { ...deps.handoff, store: deps.store, enviar: deps.enviar },
      e164,
      ficha.nombre,
      decision,
    );
    deps.log?.(`handoff ${e164}: ${decision.kind} (${resultado.estado})`);
    return decision.kind === "escalar"
      ? { accion: "escalado", motivo: decision.motivo }
      : { accion: "perdido", motivo: decision.motivo };
  }

  // 6. Responder, si las puertas lo permiten.
  const ahora = deps.now();
  const puerta = puedeResponder(deps, ahora);
  if (!puerta.ok) {
    deps.log?.(`respuesta a ${e164} diferida: ${puerta.razon}`);
    return { accion: "diferido", razon: puerta.razon };
  }

  const waMessageId = await deps.enviar(e164, decision.texto);
  deps.store.recordOutboundLibre(e164, decision.texto, waMessageId, deps.now());
  return { accion: "respondido", texto: decision.texto };
}
