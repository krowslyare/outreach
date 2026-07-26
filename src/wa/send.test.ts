import { describe, expect, it } from "vitest";

import type { SendDependencies } from "./send.js";
import { attemptSend } from "./send.js";
import {
  DEFAULT_SAFETY_CONFIG,
  type AccountHealth,
  type SafetyConfig,
} from "./types.js";

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

function concurrentDeps(options: {
  dayIndex: number;
  minGapSeconds: number;
  failFirstSend?: Error;
}): {
  deps: SendDependencies;
  sentCount: () => number;
  sendCount: () => number;
} {
  let sentToday = 0;
  let lastSentAt: Date | null = null;
  let nextMessageId = 1;
  let sendCalls = 0;

  const config: SafetyConfig = {
    ...DEFAULT_SAFETY_CONFIG,
    minGapSeconds: options.minGapSeconds,
    maxGapSeconds: options.minGapSeconds,
  };
  const deps: SendDependencies = {
    store: {
      loadAccountHealth: () =>
        health({
          dayIndex: options.dayIndex,
          sentToday,
          lastSentAt,
        }),
      loadRecipientState: (e164) => ({
        e164,
        suppressed: false,
        humanTakeover: false,
        firstOutboundAt: null,
        lastOutboundAt: null,
        lastInboundAt: null,
        followUpCount: 0,
      }),
      claimSend: () => nextMessageId++,
      markSent: () => {
        // La carrera solo queda cubierta si el estado que leen los siguientes
        // turnos cambia al persistir cada envío, como ocurriría en el store real.
        sentToday += 1;
        lastSentAt = NOW;
      },
      markError: () => undefined,
      tripKillSwitch: () => undefined,
    },
    client: {
      sendText: async (_e164, _body) => {
        sendCalls += 1;
        if (sendCalls === 1 && options.failFirstSend !== undefined) {
          throw options.failFirstSend;
        }
        return `wa-message-${sendCalls}`;
      },
    },
    config,
    now: () => NOW,
  };

  return {
    deps,
    sentCount: () => sentToday,
    sendCount: () => sendCalls,
  };
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

  it("serializa intentos concurrentes para no superar el tope diario", async () => {
    const dailyLimit = 3;
    const { deps, sentCount } = concurrentDeps({
      dayIndex: 1,
      minGapSeconds: 0,
    });

    // Los destinatarios distintos evitan que la idempotencia esconda la carrera:
    // la única protección que debe limitar estos diez intentos es la cola.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        attemptSend(
          deps,
          `+5190000000${index}`,
          `Hola ${index}`,
          "first",
        ),
      ),
    );

    expect(results.filter((result) => result.allow)).toHaveLength(dailyLimit);
    expect(sentCount()).toBe(dailyLimit);
  });

  it("serializa intentos concurrentes para respetar la separación mínima", async () => {
    const { deps, sentCount } = concurrentDeps({
      dayIndex: 15,
      minGapSeconds: 3_600,
    });

    // Con un reloj fijo, markSent deja a todos los turnos posteriores dentro de
    // la separación. Sin serialización todos leerían lastSentAt=null y pasarían.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        attemptSend(
          deps,
          `+5191000000${index}`,
          `Hola ${index}`,
          "first",
        ),
      ),
    );

    expect(results.filter((result) => result.allow)).toHaveLength(1);
    expect(sentCount()).toBe(1);
  });

  it("un rechazo no envenena la cola para el intento posterior", async () => {
    const failure = new Error("fallo aislado de WhatsApp");
    const { deps, sendCount } = concurrentDeps({
      dayIndex: 15,
      minGapSeconds: 0,
      failFirstSend: failure,
    });

    // Un fallo de red debe rechazarse al llamador, pero la cola interna tiene
    // que absorberlo para que el siguiente turno sí llegue al cliente.
    await expect(
      attemptSend(deps, "+51920000001", "Primero", "first"),
    ).rejects.toBe(failure);
    await expect(
      attemptSend(deps, "+51920000002", "Segundo", "first"),
    ).resolves.toMatchObject({ allow: true });
    expect(sendCount()).toBe(2);
  });

  it("persiste el kill switch degradado antes de tocar la red", async () => {
    const degraded = health({
      deviceRate: 0.6,
      deviceRateSample: 30,
      deviceRateBaseline: 0.9,
    });
    const { deps, events } = fakeDeps({ healthRows: [degraded] });

    await expect(
      attemptSend(deps, "+51999111222", "Hola", "first"),
    ).resolves.toMatchObject({
      allow: false,
      reason: expect.stringContaining("kill switch activo"),
    });

    // La persistencia previa evita mandar el mensaje extra que antes escapaba
    // justo cuando la salud ya había cruzado el umbral de seguridad.
    expect(events).toEqual(["loadAccountHealth", "tripKillSwitch"]);
    expect(events).not.toContain("sendText");
  });

  it("persiste el kill switch aunque el tope diario ya esté alcanzado", async () => {
    const degradedAtCap = health({
      dayIndex: 1,
      sentToday: 3,
      deviceRate: 0.6,
      deviceRateSample: 30,
      deviceRateBaseline: 0.9,
    });
    const { deps, events } = fakeDeps({ healthRows: [degradedAtCap] });

    await expect(
      attemptSend(deps, "+51999111222", "Hola", "first"),
    ).resolves.toMatchObject({ allow: false });

    // El tope no puede ser un early-return anterior a la persistencia: de otro
    // modo el switch quedaría sin registrar hasta que vuelva a abrir el cupo.
    expect(events).toEqual(["loadAccountHealth", "tripKillSwitch"]);
    expect(events).not.toContain("sendText");
  });
});
