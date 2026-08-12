import type { InboundEvent } from "./client.js";
import { clasificarInbound } from "./clasificar.js";
import { isOptOut } from "./safety.js";
import type { Store } from "./store.js";

export type InboundResult =
  /**
   * Este mensaje ya se atendió de punta a punta. No hacer nada más.
   *
   * Distinto de "ya estaba guardado": un evento recibido cuyo procesamiento
   * falló a mitad de camino vuelve a pasar por acá como si fuera nuevo.
   */
  | { action: "duplicate" }
  | { action: "suppressed" }
  /** Saludo o ausencia automáticos: queda registrado y no pasa de acá. */
  | { action: "automatic"; motivo: string }
  /** Evento sin contenido legible: corta cadencia, pero no autoriza respuesta. */
  | { action: "empty" }
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
  const registro = deps.store.recordInbound(
    evento.e164,
    evento.body,
    evento.at,
    { waMessageId: evento.waMessageId, clase: clasificacion.clase },
  );
  // Una reconexión de WhatsApp Web puede reemitir eventos ya procesados. Sin
  // este corte el agente contesta dos veces el mismo mensaje, que frente al
  // prospecto es la señal más clara de que del otro lado hay un bot.
  //
  // Solo corta lo YA ATENDIDO. Un evento cuyo trabajo posterior falló sigue
  // adelante: quedarse callado con alguien que escribió es peor que repetirse.
  if (registro === "ya_atendido") return { action: "duplicate" };

  // El opt-out se evalúa cualquiera sea la clasificación. Si un texto pide que
  // no le escriban, da igual que parezca automático: se respeta.
  if (isOptOut(evento.body)) {
    deps.store.suppress(evento.e164, "opt-out detectado");
    (deps.logger ?? console).info(
      `[WhatsApp] ${evento.e164} suprimido: opt-out detectado; no se responderá.`,
    );
    return { action: "suppressed" };
  }

  // Una reacción de WhatsApp es actividad del prospecto, pero no contiene una
  // petición que el agente pueda contestar. Baileys la entrega como tipo
  // `reaction` y el adaptador conserva el marcador `[reaction]`; si cae al
  // agente, este suele responder con un cierre genérico (y una segunda reacción
  // puede producir otro), que se ve como un bot conversando consigo mismo.
  // Se registra como evento sin contenido para cortar la cadencia, sin llamar
  // al LLM ni mandar una respuesta.
  if (evento.tipo === "reaction" || evento.body.trim() === "[reaction]") {
    return { action: "empty" };
  }

  // Un chat vacío puede ser un mensaje eliminado o un evento incompleto de
  // WhatsApp. Se conserva como humano para detener la cadencia —sí hubo
  // actividad del prospecto—, pero no se le pide al agente que adivine qué
  // quiso decir. Complete Dent demostró el modo de falla: el LLM interpretó el
  // turno vacío como interés y produjo un handoff falso.
  if (evento.body.trim() === "") return { action: "empty" };

  if (clasificacion.clase === "automatico") {
    return { action: "automatic", motivo: clasificacion.motivo };
  }

  // Este módulo solo registra, clasifica y aplica el opt-out; deliberadamente no
  // decide qué responder. Quien encadena inbound → agente → handoff es
  // src/orquestador/conversacion.ts, que es donde viven las puertas de
  // seguridad de una respuesta.
  return { action: "needs_agent" };
}
