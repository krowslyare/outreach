// El cable que faltaba: inbound → agente → (responder | handoff).
//
// Hasta acá cada módulo existía y estaba testeado, pero nada los llamaba:
// inbound.ts terminaba en `needs_agent` y ejecutarHandoff no tenía call site
// real. Este módulo es el único lugar donde se juntan, y por eso concentra las
// decisiones sobre qué puertas de seguridad aplican a una respuesta.

import { decidirRespuesta, type Turno } from "../agent/agent.js";
import { enSerie } from "./cola.js";
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
    | "inboundsPendientes"
  >;
  proveedor: ProveedorLLM;
  enviar(e164: string, texto: string): Promise<string>;
  handoff: Omit<HandoffDeps, "store" | "enviar" | "now">;
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

/**
 * Atiende un entrante de punta a punta, sin agrupar.
 *
 * El camino en vivo NO usa esto: separa `ingerirInbound` de `atenderNumero`
 * para poder agrupar ráfagas. Esto queda como el camino de un solo mensaje
 * —más fácil de razonar y de testear— y comparte con aquél tanto la ingesta
 * como la atención, así que no puede divergir en silencio.
 */
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

export interface ResumenReintentos {
  numeros: number;
  respondidos: number;
  siguenDiferidos: number;
}

/**
 * Cobra la deuda de entrantes sin atender.
 *
 * Existe porque `diferido` dejaba una promesa que nadie cumplía: alguien
 * escribía 21:40, la ventana estaba cerrada, el mensaje quedaba sin marcar
 * "para reintentarlo después" y no había ningún después. La persona no recibía
 * respuesta nunca.
 *
 * Se agrupa por número y se atiende UNA vez por persona. Si alguien mandó tres
 * mensajes mientras estábamos fuera de horario, merece una respuesta que los
 * lea a los tres, no tres respuestas encadenadas — y los tres se marcan
 * atendidos con esa única respuesta.
 *
 * Serializado con el mismo candado que los entrantes en vivo: sin eso, un
 * reintento y un mensaje nuevo del mismo prospecto correrían a la vez, cada uno
 * con la mitad del historial.
 */
export async function reintentarPendientes(
  deps: ConversacionDeps,
  limite = 20,
): Promise<ResumenReintentos> {
  const pendientes = deps.store.inboundsPendientes(limite);

  const porNumero = new Map<string, string[]>();
  for (const pendiente of pendientes) {
    const ids = porNumero.get(pendiente.e164) ?? [];
    ids.push(pendiente.waMessageId);
    porNumero.set(pendiente.e164, ids);
  }

  let respondidos = 0;
  let siguenDiferidos = 0;

  for (const [e164, ids] of porNumero) {
    let resultado: ResultadoConversacion;
    try {
      resultado = await atenderYSaldar(deps, e164, ids);
    } catch (error) {
      // Un fallo con un prospecto no puede impedir que se atienda al siguiente,
      // y al no marcarse nada este número vuelve a salir en la próxima pasada.
      deps.log?.(`reintento de ${e164} falló: ${String(error)}`);
      continue;
    }

    if (!cerroElCiclo(resultado)) siguenDiferidos += 1;
    else if (resultado.accion === "respondido") respondidos += 1;
  }

  return { numeros: porNumero.size, respondidos, siguenDiferidos };
}

/**
 * Atiende un número y salda los entrantes que esa respuesta cubre.
 *
 * Los IDs se marcan solo si la decisión llegó a un final: si volvió a diferirse,
 * la deuda sigue viva y el número reaparece en la próxima pasada.
 */
async function atenderYSaldar(
  deps: ConversacionDeps,
  e164: string,
  ids: readonly string[],
): Promise<ResultadoConversacion> {
  const resultado = await enSerie(e164, () => atender(deps, e164));
  if (cerroElCiclo(resultado)) {
    for (const id of ids) deps.store.marcarInboundAtendido(id, deps.now());
  }
  return resultado;
}

/**
 * Registra un entrante SIN contestarlo todavía.
 *
 * Separado de la respuesta para poder agrupar ráfagas. Tres mensajes seguidos
 * —"Hola" / "¿quién habla?" / "¿cuánto cuesta?", lo más común del mundo en
 * WhatsApp— producían tres respuestas encadenadas: ordenadas y con contexto,
 * pero inconfundiblemente de una máquina. Una persona lee los tres y contesta
 * una vez.
 *
 * El registro sí es inmediato: el opt-out y la idempotencia no pueden esperar a
 * que se cumpla un silencio.
 */
export function ingerirInbound(
  deps: ConversacionDeps,
  evento: InboundEvent,
): { atender: boolean; resultado?: ResultadoConversacion } {
  const inbound = handleInbound({ store: deps.store }, evento);
  if (inbound.action === "duplicate") {
    return { atender: false, resultado: { accion: "duplicado" } };
  }
  if (inbound.action === "suppressed") {
    deps.store.marcarInboundAtendido(evento.waMessageId, deps.now());
    return { atender: false, resultado: { accion: "suprimido" } };
  }
  if (inbound.action === "automatic") {
    deps.log?.(`inbound automático de ${evento.e164}: ${inbound.motivo}`);
    deps.store.marcarInboundAtendido(evento.waMessageId, deps.now());
    return {
      atender: false,
      resultado: { accion: "automatico", razon: inbound.motivo },
    };
  }
  return { atender: true };
}

/**
 * Contesta todo lo que ese número tenga pendiente, en una sola respuesta.
 *
 * Es el par de `ingerirInbound`: se llama cuando la ráfaga se aquietó. Toma los
 * pendientes del store en vez de recibir el evento porque entre la ingesta y
 * esta llamada pueden haber llegado más mensajes, y todos deben quedar saldados
 * por la misma respuesta.
 */
export async function atenderNumero(
  deps: ConversacionDeps,
  e164: string,
): Promise<ResultadoConversacion> {
  // Acotado por número en la consulta: con el límite global, 50 pendientes
  // viejos de otros chats tapaban el mensaje que acaba de llegar.
  const ids = deps.store
    .inboundsPendientes(50, e164)
    .map((pendiente) => pendiente.waMessageId);
  if (ids.length === 0) {
    return { accion: "duplicado" };
  }
  return atenderYSaldar(deps, e164, ids);
}

async function resolver(
  deps: ConversacionDeps,
  evento: InboundEvent,
): Promise<ResultadoConversacion> {
  // Misma ingesta que usa el camino en vivo. No se duplica a propósito: si las
  // dos versiones divergieran, una correría con otras puertas de seguridad y
  // los tests de este archivo seguirían en verde igual.
  const ingesta = ingerirInbound(deps, evento);
  if (!ingesta.atender) return ingesta.resultado!;
  return atender(deps, evento.e164);
}

/**
 * Todo lo que va DESPUÉS de registrar el entrante: ficha, puertas, agente,
 * handoff, respuesta.
 *
 * Está separado de la ingesta porque un reintento no debe volver a registrar,
 * reclasificar ni reevaluar el opt-out: eso ya ocurrió cuando el mensaje llegó.
 * Y porque no necesita el evento — el historial sale del store, así que atender
 * a alguien con tres mensajes pendientes produce UNA respuesta que los ve todos,
 * en vez de tres respuestas encadenadas.
 */
async function atender(
  deps: ConversacionDeps,
  e164: string,
): Promise<ResultadoConversacion> {
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

  // 4. Las puertas, ANTES de llamar al agente.
  //
  // Estaban después, cubriendo solo la respuesta libre. Eso alcanzaba mientras
  // un escalamiento no producía ningún saliente hacia el prospecto — pero ahora
  // el handoff le manda el acuse con las tres opciones, así que un "me interesa"
  // a las 3am generaba un mensaje automático a las 3am, que es exactamente lo
  // que la ventana horaria existe para evitar. Con el kill switch activo era
  // peor: dos envíos desde una cuenta que hay que dejar quieta.
  //
  // Moverlas acá arriba las vuelve absolutas de verdad, como dice su propio
  // comentario, y de paso no se gasta una llamada al LLM cuyo resultado no se
  // podría usar. El entrante queda sin marcar, así que el barrido lo reintenta
  // al abrir la ventana y ahí sí escala, avisa y responde — todo en horario.
  const puerta = puedeResponder(deps, deps.now());
  if (!puerta.ok) {
    deps.log?.(`respuesta a ${e164} diferida: ${puerta.razon}`);
    return { accion: "diferido", razon: puerta.razon };
  }

  // 5. El agente decide.
  const historial: Turno[] = deps.store.loadConversacion(e164).map((m) => ({
    rol: m.direction === "in" ? "prospecto" : "nosotros",
    texto: m.body,
  }));

  // El inbound ya quedó registrado en el paso 1, así que el último turno es el
  // del prospecto — que es justo lo que decidirRespuesta exige.
  const decision = await decidirRespuesta(deps.proveedor, ficha, historial);

  // 6. Escalar y perder van al handoff, que pone el lock antes de nada.
  if (decision.kind !== "responder") {
    const resultado = await ejecutarHandoff(
      { ...deps.handoff, store: deps.store, enviar: deps.enviar, now: deps.now },
      e164,
      ficha.nombre,
      decision,
    );
    deps.log?.(`handoff ${e164}: ${decision.kind} (${resultado.estado})`);
    return decision.kind === "escalar"
      ? { accion: "escalado", motivo: decision.motivo }
      : { accion: "perdido", motivo: decision.motivo };
  }

  // 7. Responder.
  const waMessageId = await deps.enviar(e164, decision.texto);
  deps.store.recordOutboundLibre(e164, decision.texto, waMessageId, deps.now());
  return { accion: "respondido", texto: decision.texto };
}
