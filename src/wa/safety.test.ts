import { describe, expect, it } from "vitest";

import {
  canContact,
  canSendNow,
  dailyCap,
  isOptOut,
  zonedParts,
} from "./safety.js";
import {
  DEFAULT_SAFETY_CONFIG,
  type AccountHealth,
  type RecipientState,
  type SafetyConfig,
} from "./types.js";

const MONDAY_AT_10_LIMA = new Date("2026-07-27T15:00:00.000Z");

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

function recipient(overrides: Partial<RecipientState> = {}): RecipientState {
  return {
    e164: "+51999111222",
    suppressed: false,
    humanTakeover: false,
    firstOutboundAt: null,
    lastOutboundAt: null,
    lastInboundAt: null,
    lastHumanInboundAt: null,
    followUpCount: 0,
    ...overrides,
  };
}

function config(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return { ...DEFAULT_SAFETY_CONFIG, ...overrides };
}

describe("canSendNow", () => {
  it("prioriza el kill switch sobre horario, día, tope y separación", () => {
    const verdict = canSendNow(
      health({
        sentToday: 99,
        lastSentAt: MONDAY_AT_10_LIMA,
        killSwitch: {
          tripped: true,
          reason: "ban detectado",
          trippedAt: MONDAY_AT_10_LIMA,
        },
      }),
      config({ activeWeekdays: [] }),
      MONDAY_AT_10_LIMA,
    );

    expect(verdict).toMatchObject({
      allow: false,
      reason: "kill switch activo: ban detectado",
    });
  });

  it("niega antes y después de la ventana local", () => {
    const before = new Date("2026-07-27T13:59:59.000Z"); // 08:59 Lima
    const atEnd = new Date("2026-07-28T00:00:00.000Z"); // 19:00 Lima

    expect(canSendNow(health(), config(), before)).toMatchObject({
      allow: false,
      reason: expect.stringContaining("fuera de la ventana"),
    });
    expect(canSendNow(health(), config(), atEnd)).toMatchObject({
      allow: false,
      reason: expect.stringContaining("fuera de la ventana"),
    });
  });

  it("niega el domingo", () => {
    const sundayAt10 = new Date("2026-07-26T15:00:00.000Z");

    expect(canSendNow(health(), config(), sundayAt10)).toMatchObject({
      allow: false,
      reason: "día no activo (weekday 7)",
    });
  });

  it.each([
    [1, 3],
    [2, 3],
    [3, 5],
    [4, 5],
    [5, 10],
    [7, 10],
    [8, 15],
    [14, 15],
    [15, 20],
    [99, 20],
  ])("aplica el escalón del día %i con tope %i", (dayIndex, cap) => {
    expect(dailyCap(dayIndex, true)).toBe(cap);
    expect(
      canSendNow(
        health({ dayIndex, sentToday: cap }),
        config(),
        MONDAY_AT_10_LIMA,
      ),
    ).toMatchObject({
      allow: false,
      reason: expect.stringContaining(`tope diario alcanzado (${cap}/${cap}`),
    });
  });

  it("congela el ramp-up un escalón cuando la señal no está sana", () => {
    const unhealthy = health({
      dayIndex: 5,
      sentToday: 5,
      deviceRate: 0.7,
      deviceRateSample: 30,
      deviceRateBaseline: 0.9,
    });

    expect(dailyCap(5, false)).toBe(5);
    expect(canSendNow(unhealthy, config(), MONDAY_AT_10_LIMA)).toMatchObject({
      allow: false,
      reason: expect.stringContaining("(5/5"),
    });
  });

  it("mantiene el escalón anterior al tope pleno cuando el día 15 no está sano", () => {
    // REGRESIÓN: findIndex devuelve -1 fuera de la tabla, y tratar ese -1 como
    // "primer escalón" hacía caer el tope de 20 a 3 ante cualquier señal floja.
    expect(dailyCap(15, false)).toBe(15);
    expect(dailyCap(99, false)).toBe(15);
  });

  it("exige la separación mínima y calcula cuándo reintentar", () => {
    const lastSentAt = new Date(
      MONDAY_AT_10_LIMA.getTime() -
        (DEFAULT_SAFETY_CONFIG.minGapSeconds - 1) * 1000,
    );
    const verdict = canSendNow(
      health({ lastSentAt }),
      config(),
      MONDAY_AT_10_LIMA,
    );

    expect(verdict).toEqual({
      allow: false,
      reason: expect.stringContaining("separación mínima no cumplida"),
      retryAfter: new Date(
        lastSentAt.getTime() + DEFAULT_SAFETY_CONFIG.minGapSeconds * 1000,
      ),
    });
  });
});

describe("canContact", () => {
  it("niega una supresión", () => {
    expect(
      canContact(
        recipient({ suppressed: true }),
        config(),
        MONDAY_AT_10_LIMA,
      ),
    ).toMatchObject({
      allow: false,
      reason: "destinatario en supresión (opt-out)",
    });
  });

  it("niega una conversación tomada por humano", () => {
    expect(
      canContact(
        recipient({ humanTakeover: true }),
        config(),
        MONDAY_AT_10_LIMA,
      ),
    ).toMatchObject({
      allow: false,
      reason: expect.stringContaining("tomada por humano"),
    });
  });

  it("termina la cadencia si el destinatario ya respondió", () => {
    expect(
      canContact(
        recipient({
          lastInboundAt: MONDAY_AT_10_LIMA,
          lastHumanInboundAt: MONDAY_AT_10_LIMA,
        }),
        config(),
        MONDAY_AT_10_LIMA,
      ),
    ).toMatchObject({
      allow: false,
      reason: expect.stringContaining("respondió"),
    });
  });

  // El caso que mataba la cadencia de toda la lista: casi todo establecimiento
  // tiene saludo automático de WhatsApp Business y llega a los segundos del
  // primer contacto. Si eso cuenta como respuesta, ningún follow-up sale nunca.
  it("un entrante automático NO termina la cadencia", () => {
    const primerContacto = new Date(MONDAY_AT_10_LIMA.getTime() - 3 * 86_400_000);
    expect(
      canContact(
        recipient({
          firstOutboundAt: primerContacto,
          lastOutboundAt: primerContacto,
          // Llegó un entrante, pero ninguno humano.
          lastInboundAt: primerContacto,
          lastHumanInboundAt: null,
        }),
        config(),
        MONDAY_AT_10_LIMA,
      ),
    ).toMatchObject({ allow: true });
  });

  it("abre el primer follow-up en el día 3 y no antes", () => {
    const firstSentAt = new Date("2026-07-24T15:00:00.000Z");
    const before = new Date("2026-07-27T14:59:59.000Z");

    expect(
      canContact(
        recipient({ lastOutboundAt: firstSentAt }),
        config(),
        before,
      ),
    ).toEqual({
      allow: false,
      reason: expect.stringContaining("día 2 de 3"),
      retryAfter: new Date("2026-07-27T15:00:00.000Z"),
    });
    expect(
      canContact(
        recipient({ lastOutboundAt: firstSentAt }),
        config(),
        MONDAY_AT_10_LIMA,
      ),
    ).toEqual({ allow: true });
  });

  it("abre el segundo follow-up en el día 7 desde el primer contacto", () => {
    // REGRESIÓN: medir desde lastOutboundAt corría la fecha con cada envío, así
    // que tras el FU1 (día 3) el FU2 caía el día 10 en vez del 7.
    const firstSentAt = new Date("2026-07-24T15:00:00.000Z");
    const followUpOneSentAt = new Date("2026-07-27T15:00:00.000Z");
    const daySevenFromFirst = new Date("2026-07-31T15:00:00.000Z");
    const state = recipient({
      firstOutboundAt: firstSentAt,
      lastOutboundAt: followUpOneSentAt,
      followUpCount: 1,
    });

    expect(canContact(state, config(), daySevenFromFirst)).toEqual({
      allow: true,
    });
    // Y el día 6 desde el primero todavía no.
    expect(
      canContact(state, config(), new Date("2026-07-30T15:00:00.000Z")),
    ).toMatchObject({ allow: false, reason: expect.stringContaining("día 6 de 7") });
  });

  it("no trata un estado inconsistente como primer contacto", () => {
    // REGRESIÓN: el early-return de "primer contacto" miraba solo
    // firstOutboundAt, así que un destinatario con follow-ups ya enviados pero
    // sin fechas se escapaba por arriba y salteaba el tope de follow-ups.
    expect(
      canContact(
        recipient({ followUpCount: 2 }),
        config(),
        MONDAY_AT_10_LIMA,
      ),
    ).toMatchObject({
      allow: false,
      reason: "máximo de follow-ups alcanzado (2)",
    });

    // Con followUpCount por debajo del tope pero sin fechas, tampoco envía:
    // no hay contra qué medir la cadencia.
    expect(
      canContact(
        recipient({ followUpCount: 1 }),
        config(),
        MONDAY_AT_10_LIMA,
      ),
    ).toMatchObject({
      allow: false,
      reason: expect.stringContaining("estado inconsistente"),
    });
  });

  it("respeta el máximo de follow-ups", () => {
    expect(
      canContact(
        recipient({
          lastOutboundAt: new Date("2026-07-01T15:00:00.000Z"),
          followUpCount: 2,
        }),
        config(),
        MONDAY_AT_10_LIMA,
      ),
    ).toMatchObject({
      allow: false,
      reason: "máximo de follow-ups alcanzado (2)",
    });
  });
});

describe("isOptOut", () => {
  it.each([
    "No me escribas más",
    "NO ME INTERESA",
    "Déjame en paz",
    "dejame en paz",
    "Bórrame",
    "borrame por favor",
    "Quítame de tu lista",
    "quitame",
    "¿Cómo conseguiste mi número?",
    "como obtuviste mi numero",
    "STOP",
    "Esto es spam",
    "Voy a denunciar",
  ])("detecta opt-out: %s", (text) => {
    expect(isOptOut(text)).toBe(true);
  });

  it.each([
    "",
    "No puedo hoy, escríbeme mañana",
    "Me interesa",
    "¿Cómo funciona el servicio?",
    "Quiero más información",
  ])("no marca conversación normal: %s", (text) => {
    expect(isOptOut(text)).toBe(false);
  });

  it("detecta la formulación común 'no estoy interesado'", () => {
    // BUG CONTRATO: el patrón cubre "no me interesa", pero no esta variante
    // inequívoca de rechazo.
    expect(isOptOut("Gracias, pero no estoy interesado")).toBe(true);
  });
});

describe("zonedParts", () => {
  it("usa el día local de Lima cuando UTC ya cambió de fecha", () => {
    // 2026-07-26 03:00 UTC todavía es sábado 25 a las 22:00 en Lima.
    expect(
      zonedParts(new Date("2026-07-26T03:00:00.000Z"), "America/Lima"),
    ).toEqual({ hour: 22, weekday: 6 });
  });
});
