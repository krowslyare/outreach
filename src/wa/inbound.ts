import type { InboundEvent } from "./client.js";
import { clasificarInbound } from "./clasificar.js";
import { isOptOut } from "./safety.js";
import type { Store } from "./store.js";

export type InboundResult =
  /** Ya se había procesado este mismo mensaje de WhatsApp. No hacer nada más. */
  | { action: "duplicate" }
  | { action: "suppressed" }
  /** Saludo o ausencia automáticos: queda registrado y no pasa de acá. */
  | { action: "automatic"; motivo: string }
  | { action: "needs_agent" };

export interface InboundDependencies {
  store: Pick<Store, "recordInbound" | "suppress" | "ultimoOutboundAt">;
  logger?: Pick<Console, "info">;
}

export function handleInbound(
  deps: InboundDependencies,
  evento: InboundEvent,
): InboundResult {
  const clasificacion = clasificarInbound({
    body: evento.body,
    tipo: evento.tipo,
    tieneMedia: evento.tieneMedia,
    citaOtroMensaje: evento.citaOtroMensaje,
    at: evento.at,
    ultimoOutboundAt: deps.store.ultimoOutboundAt(evento.e164),
  });

  // El rastro entra primero: incluso un opt-out o un número ajeno a la campaña
  // debe quedar auditable antes de ejecutar cualquier decisión.
  const nuevo = deps.store.recordInbound(evento.e164, evento.body, evento.at, {
    waMessageId: evento.waMessageId,
    clase: clasificacion.clase,
  });
  // Una reconexión de WhatsApp Web puede reemitir eventos ya procesados. Sin
  // este corte el agente contesta dos veces el mismo mensaje, que frente al
  // prospecto es la señal más clara de que del otro lado hay un bot.
  if (!nuevo) return { action: "duplicate" };

  // El opt-out se evalúa cualquiera sea la clasificación. Si un texto pide que
  // no le escriban, da igual que parezca automático: se respeta.
  if (isOptOut(evento.body)) {
    deps.store.suppress(evento.e164, "opt-out detectado");
    (deps.logger ?? console).info(
      `[WhatsApp] ${evento.e164} suprimido: opt-out detectado; no se responderá.`,
    );
    return { action: "suppressed" };
  }

  if (clasificacion.clase === "automatico") {
    return { action: "automatic", motivo: clasificacion.motivo };
  }

  // Este módulo solo registra, clasifica y aplica el opt-out; deliberadamente no
  // decide qué responder. Quien encadena inbound → agente → handoff es
  // src/orquestador/conversacion.ts, que es donde viven las puertas de
  // seguridad de una respuesta.
  return { action: "needs_agent" };
}
