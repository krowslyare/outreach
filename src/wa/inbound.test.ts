import { describe, expect, it, vi } from "vitest";

import { handleInbound } from "./inbound.js";

describe("handleInbound", () => {
  it("registra primero y suprime un opt-out sin responder", () => {
    const events: string[] = [];
    const info = vi.fn();
    const at = new Date("2026-07-26T03:00:00.000Z");

    const result = handleInbound(
      {
        store: {
          recordInbound: () => events.push("recordInbound"),
          suppress: (_e164, reason) => events.push(`suppress:${reason}`),
        },
        logger: { info },
      },
      "+51999111222",
      "No me escribas",
      at,
    );

    expect(result).toEqual({ action: "suppressed" });
    expect(events).toEqual([
      "recordInbound",
      "suppress:opt-out detectado",
    ]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("no se responderá"));
  });

  it("deja el mensaje normal listo para M5 sin responder automáticamente", () => {
    const events: string[] = [];

    expect(
      handleInbound(
        {
          store: {
            recordInbound: () => events.push("recordInbound"),
            suppress: () => events.push("suppress"),
          },
        },
        "+51999111222",
        "Cuéntame más",
        new Date(),
      ),
    ).toEqual({ action: "needs_agent" });
    expect(events).toEqual(["recordInbound"]);
  });
});
