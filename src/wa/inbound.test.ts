import { describe, expect, it, vi } from "vitest";

import type { InboundEvent } from "./client.js";
import { handleInbound, type InboundDependencies } from "./inbound.js";

const E164 = "+51999111222";
const OUTBOUND = new Date("2026-07-26T15:00:00.000Z");

function evento(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    e164: E164,
    body: "Cuéntame más",
    at: new Date(OUTBOUND.getTime() + 90_000),
    waMessageId: "wa-1",
    tipo: "chat",
    tieneMedia: false,
    citaOtroMensaje: false,
    ...overrides,
  };
}

function deps(
  events: string[],
  opts: { ultimoOutboundAt?: Date | null; yaRegistrado?: boolean } = {},
): InboundDependencies {
  return {
    store: {
      ultimoOutboundAt: () => opts.ultimoOutboundAt ?? OUTBOUND,
      recordInbound: (_e164, _body, _at, meta) => {
        events.push(`recordInbound:${meta?.clase ?? "sin clase"}`);
        return opts.yaRegistrado !== true;
      },
      suppress: (_e164, reason) => events.push(`suppress:${reason}`),
    },
  };
}

describe("handleInbound", () => {
  it("registra primero y suprime un opt-out sin responder", () => {
    const events: string[] = [];
    const info = vi.fn();

    const result = handleInbound(
      { ...deps(events), logger: { info } },
      evento({ body: "No me escribas" }),
    );

    expect(result).toEqual({ action: "suppressed" });
    expect(events).toEqual([
      "recordInbound:humano",
      "suppress:opt-out detectado",
    ]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("no se responderá"));
  });

  it("deja el mensaje humano listo para el agente", () => {
    const events: string[] = [];
    expect(handleInbound(deps(events), evento())).toEqual({
      action: "needs_agent",
    });
    expect(events).toEqual(["recordInbound:humano"]);
  });

  it("registra el autorespondedor y no lo manda al agente", () => {
    const events: string[] = [];
    const resultado = handleInbound(
      deps(events),
      evento({
        body: "Gracias por comunicarte con nosotros, en breve te atenderemos",
        at: new Date(OUTBOUND.getTime() + 2_000),
      }),
    );

    expect(resultado.action).toBe("automatic");
    expect(events).toEqual(["recordInbound:automatico"]);
  });

  // Una reconexión de WhatsApp Web reemite eventos ya procesados. Sin este
  // corte el agente contesta dos veces el mismo mensaje.
  it("corta el evento duplicado antes de cualquier decisión", () => {
    const events: string[] = [];
    const resultado = handleInbound(
      deps(events, { yaRegistrado: true }),
      evento({ body: "No me escribas" }),
    );

    expect(resultado).toEqual({ action: "duplicate" });
    // Ni siquiera el opt-out corre de nuevo: ya se aplicó la primera vez.
    expect(events).toEqual(["recordInbound:humano"]);
  });

  // El opt-out manda sobre la clasificación: si el texto pide que no le
  // escriban, da igual que parezca plantilla.
  it("respeta el opt-out aunque el mensaje parezca automático", () => {
    const events: string[] = [];
    const resultado = handleInbound(
      deps(events),
      evento({
        body: "Gracias por comunicarte, no estamos interesados",
        at: new Date(OUTBOUND.getTime() + 2_000),
      }),
    );

    expect(resultado).toEqual({ action: "suppressed" });
  });
});
