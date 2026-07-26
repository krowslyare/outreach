import { describe, expect, it } from "vitest";

import type { SendDependencies } from "./send.js";
import { attemptSend } from "./send.js";
import { DEFAULT_SAFETY_CONFIG, type AccountHealth } from "./types.js";

const NOW = new Date("2026-07-27T15:00:00.000Z");

function health(overrides: Partial<AccountHealth> = {}): AccountHealth {
  return {
    dayIndex: 1,
    sentToday: 0,
    lastSentAt: null,
    deviceRate: null,
    deviceRateSample: 0,
    deviceRateBaseline: null,
    killSwitch: { tripped: false, reason: null, trippedAt: null },
    ...overrides,
  };
}

function fakeDeps(options: {
  healthRows?: AccountHealth[];
  suppressed?: boolean;
  claim?: number | null;
  sendError?: Error;
} = {}): { deps: SendDependencies; events: string[] } {
  const events: string[] = [];
  const healthRows = options.healthRows ?? [health(), health()];
  let healthIndex = 0;
  const deps: SendDependencies = {
    store: {
      loadAccountHealth: () => {
        events.push("loadAccountHealth");
        const row = healthRows[Math.min(healthIndex, healthRows.length - 1)];
        healthIndex += 1;
        if (row === undefined) throw new Error("falta health fake");
        return row;
      },
      loadRecipientState: (e164) => {
        events.push("loadRecipientState");
        return {
          e164,
          suppressed: options.suppressed ?? false,
          humanTakeover: false,
          firstOutboundAt: null,
          lastOutboundAt: null,
          lastInboundAt: null,
          followUpCount: 0,
        };
      },
      claimSend: () => {
        events.push("claimSend");
        return options.claim === undefined ? 7 : options.claim;
      },
      markSent: () => {
        events.push("markSent");
      },
      markError: (_id, error) => {
        events.push(`markError:${error}`);
      },
      tripKillSwitch: () => {
        events.push("tripKillSwitch");
      },
    },
    client: {
      sendText: async () => {
        events.push("sendText");
        if (options.sendError !== undefined) throw options.sendError;
        return "wa-message-1";
      },
    },
    config: DEFAULT_SAFETY_CONFIG,
    now: () => NOW,
  };
  return { deps, events };
}

describe("attemptSend", () => {
  it("respeta el orden estricto y persiste el resultado exitoso", async () => {
    const { deps, events } = fakeDeps();

    await expect(
      attemptSend(deps, "+51999111222", "Hola", "first"),
    ).resolves.toEqual({
      allow: true,
      messageId: 7,
      waMessageId: "wa-message-1",
    });
    expect(events).toEqual([
      "loadAccountHealth",
      "loadRecipientState",
      "claimSend",
      "sendText",
      "markSent",
      "loadAccountHealth",
    ]);
  });

  it("si canSendNow niega, no consulta destinatario ni muta la DB", async () => {
    const { deps, events } = fakeDeps({
      healthRows: [
        health({
          killSwitch: {
            tripped: true,
            reason: "pausado",
            trippedAt: NOW,
          },
        }),
      ],
    });

    await expect(
      attemptSend(deps, "+51999111222", "Hola", "first"),
    ).resolves.toMatchObject({
      allow: false,
      reason: "kill switch activo: pausado",
    });
    expect(events).toEqual(["loadAccountHealth"]);
  });

  it("si canContact niega, no reclama ni envía", async () => {
    const { deps, events } = fakeDeps({ suppressed: true });

    await expect(
      attemptSend(deps, "+51999111222", "Hola", "first"),
    ).resolves.toMatchObject({
      allow: false,
      reason: expect.stringContaining("supresión"),
    });
    expect(events).toEqual(["loadAccountHealth", "loadRecipientState"]);
  });

  it("un claim duplicado no vuelve a tocar WhatsApp", async () => {
    const { deps, events } = fakeDeps({ claim: null });

    await expect(
      attemptSend(deps, "+51999111222", "Hola", "first"),
    ).resolves.toEqual({
      allow: false,
      reason: "envío ya reclamado (+51999111222:first)",
      retryAfter: null,
    });
    expect(events).toEqual([
      "loadAccountHealth",
      "loadRecipientState",
      "claimSend",
    ]);
  });

  it("marca el error y propaga el mismo fallo sin reintentar", async () => {
    const failure = new Error("WhatsApp no disponible");
    const { deps, events } = fakeDeps({ sendError: failure });

    await expect(
      attemptSend(deps, "+51999111222", "Hola", "first"),
    ).rejects.toBe(failure);
    expect(events).toEqual([
      "loadAccountHealth",
      "loadRecipientState",
      "claimSend",
      "sendText",
      "markError:WhatsApp no disponible",
    ]);
  });

  it("evalúa y persiste el kill switch después de marcar el envío", async () => {
    const degraded = health({
      deviceRate: 0.6,
      deviceRateSample: 30,
      deviceRateBaseline: 0.9,
    });
    const { deps, events } = fakeDeps({
      healthRows: [health(), degraded],
    });

    await attemptSend(deps, "+51999111222", "Hola", "first");

    expect(events).toEqual([
      "loadAccountHealth",
      "loadRecipientState",
      "claimSend",
      "sendText",
      "markSent",
      "loadAccountHealth",
      "tripKillSwitch",
    ]);
  });
});
