import { isOptOut } from "./safety.js";
import type { Store } from "./store.js";

export type InboundResult =
  | { action: "suppressed" }
  | { action: "needs_agent" };

export interface InboundDependencies {
  store: Pick<Store, "recordInbound" | "suppress">;
  logger?: Pick<Console, "info">;
}

export function handleInbound(
  deps: InboundDependencies,
  e164: string,
  body: string,
  at: Date,
): InboundResult {
  // El rastro entra primero: incluso un opt-out o un número ajeno a la campaña
  // debe quedar auditable antes de ejecutar cualquier decisión.
  deps.store.recordInbound(e164, body, at);

  if (isOptOut(body)) {
    deps.store.suppress(e164, "opt-out detectado");
    (deps.logger ?? console).info(
      `[WhatsApp] ${e164} suprimido: opt-out detectado; no se responderá.`,
    );
    return { action: "suppressed" };
  }

  // Este módulo solo registra y aplica el opt-out; deliberadamente no decide
  // qué responder. Quien encadena inbound → agente → handoff es
  // src/orquestador/conversacion.ts, que es donde viven las puertas de
  // seguridad de una respuesta.
  return { action: "needs_agent" };
}
