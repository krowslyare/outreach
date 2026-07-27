import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScoredProspect } from "../types.js";
import { Store } from "./store.js";

// Igual que en store.ts: vitest 2 no resuelve `node:sqlite` sin esto.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function scored(
  sourceId: string,
  e164: string,
  overrides: Partial<ScoredProspect> = {},
): ScoredProspect {
  return {
    source: "renipress",
    sourceId,
    name: `Clínica ${sourceId}`,
    classification: "CENTRO ODONTOLOGICO",
    category: "I-2",
    district: "MIRAFLORES",
    ubigeo: "150122",
    address: "Av. Ejemplo 123",
    lat: -12.1,
    lng: -77,
    phones: [{ raw: e164, e164, kind: "mobile" }],
    web: {
      checkedAt: "2026-07-20T12:00:00.000Z",
      placeId: "place-1",
      websiteUri: null,
      rating: 4.5,
      userRatingCount: 20,
      matchConfidence: 0.9,
    },
    score: 80,
    signals: [],
    eligible: true,
    blockers: [],
    ...overrides,
  };
}

describe("Store", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  it("importa solo móviles elegibles y conserva flags en una reimportación", () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.importRecipients([
      scored("A", "+51999111222"),
      scored("B", "+51999222333", { eligible: false }),
      scored("C", "+514455667", {
        phones: [{ raw: "4455667", e164: "+514455667", kind: "landline" }],
      }),
    ]);
    store.suppress("+51999111222", "prueba");
    store.importRecipients([
      scored("A2", "+51999111222", { name: "Nombre actualizado" }),
    ]);

    expect(store.loadRecipientState("+51999111222")).toMatchObject({
      e164: "+51999111222",
      suppressed: true,
      humanTakeover: false,
      followUpCount: 0,
    });
    expect(() => store.loadRecipientState("+51999222333")).toThrow(
      "destinatario desconocido",
    );
    expect(() => store.loadRecipientState("+514455667")).toThrow(
      "destinatario desconocido",
    );
  });

  it("reclama antes de enviar y el mismo step nunca se reclama dos veces", () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.importRecipients([scored("A", "+51999111222")]);

    const first = store.claimSend("+51999111222", "first", "Hola");

    expect(first).toBeTypeOf("number");
    expect(store.claimSend("+51999111222", "first", "Otro texto")).toBeNull();
    expect(store.claimSend("+51999111222", "fu1", "Seguimiento")).toBeTypeOf(
      "number",
    );
  });

  it("devuelve solo aperturas de primeros contactos, recientes y truncadas", () => {
    let current = new Date("2026-07-24T15:00:00.000Z");
    const store = new Store(":memory:", () => current);
    stores.push(store);
    store.importRecipients([
      scored("A", "+51999111222"),
      scored("B", "+51999222333"),
      scored("C", "+51999333444"),
    ]);

    const enviar = (e164: string, step: "first" | "fu1", body: string) => {
      const id = store.claimSend(e164, step, body);
      if (id === null) throw new Error("claim inesperadamente duplicado");
      store.markSent(id, `wa-${e164}-${step}`);
    };

    const aperturaA = "A".repeat(90);
    enviar("+51999111222", "first", aperturaA);
    current = new Date("2026-07-24T16:00:00.000Z");
    enviar("+51999222333", "first", "Apertura B");
    current = new Date("2026-07-24T17:00:00.000Z");
    enviar("+51999222333", "fu1", "Follow-up B más reciente");
    current = new Date("2026-07-24T18:00:00.000Z");
    enviar("+51999333444", "first", "Apertura C");

    expect(store.aperturasRecientes(3)).toEqual([
      "Apertura C",
      "Apertura B",
      aperturaA.slice(0, 80),
    ]);
    expect(store.aperturasRecientes(2)).toEqual([
      "Apertura C",
      "Apertura B",
    ]);
  });

  it("calcula ACK_DEVICE solo sobre el primer mensaje maduro de cada destinatario", () => {
    let current = new Date("2026-07-24T15:00:00.000Z");
    const store = new Store(":memory:", () => current);
    stores.push(store);
    store.importRecipients([
      scored("A", "+51999111222"),
      scored("B", "+51999222333"),
    ]);

    const firstA = store.claimSend("+51999111222", "first", "A");
    const firstB = store.claimSend("+51999222333", "first", "B");
    if (firstA === null || firstB === null) throw new Error("claim inesperado");
    store.markSent(firstA, "wa-a-first");
    store.markSent(firstB, "wa-b-first");
    store.recordAck("wa-a-first", 2, current);
    store.recordAck("wa-a-first", 1, new Date(current.getTime() + 1_000));
    store.recordAck("wa-b-first", 1, current);

    const followUpB = store.claimSend("+51999222333", "fu1", "B2");
    if (followUpB === null) throw new Error("claim inesperado");
    store.markSent(followUpB, "wa-b-fu1");
    store.recordAck("wa-b-fu1", 4, current);
    store.setBaseline(0.95);

    current = new Date("2026-07-25T15:00:01.000Z");
    expect(store.loadAccountHealth(current)).toMatchObject({
      dayIndex: 2,
      sentToday: 0,
      deviceRate: 0.5,
      deviceRateSample: 2,
      deviceRateBaseline: 0.95,
      killSwitch: { tripped: false },
    });
  });

  it("calcula deviceRate sobre los primeros mensajes maduros más recientes", () => {
    const finalNow = new Date("2026-07-27T15:00:00.000Z");
    let current = new Date("2026-07-18T12:00:00.000Z");
    const store = new Store(":memory:", () => current);
    stores.push(store);
    const healthyCount = 100;
    const failedCount = 20;
    const prospects = Array.from(
      { length: healthyCount + failedCount },
      (_, index) =>
        scored(
          `HIST-${index}`,
          `+519${String(index).padStart(8, "0")}`,
        ),
    );
    store.importRecipients(prospects);

    for (let index = 0; index < healthyCount; index += 1) {
      current = new Date(
        new Date("2026-07-18T12:00:00.000Z").getTime() + index * 60_000,
      );
      const id = store.claimSend(
        prospects[index]!.phones[0]!.e164!,
        "first",
        "Hola",
      );
      if (id === null) throw new Error("claim sano inesperadamente duplicado");
      store.markSent(id, `wa-healthy-${index}`);
      store.recordAck(`wa-healthy-${index}`, 2, current);
    }

    for (let index = 0; index < failedCount; index += 1) {
      current = new Date(
        new Date("2026-07-25T12:00:00.000Z").getTime() + index * 60_000,
      );
      const prospect = prospects[healthyCount + index]!;
      const id = store.claimSend(prospect.phones[0]!.e164!, "first", "Hola");
      if (id === null) throw new Error("claim fallido inesperadamente duplicado");
      store.markSent(id, `wa-failed-${index}`);
      store.recordAck(`wa-failed-${index}`, 1, current);
    }

    const lifetimeRate = healthyCount / (healthyCount + failedCount);
    const healthInWindow = store.loadAccountHealth(finalNow, failedCount);

    // El histórico sano no debe diluir la degradación reciente: sin LIMIT la
    // tasa sería ~0.83 y el kill switch tardaría demasiado en reaccionar.
    expect(lifetimeRate).toBeCloseTo(0.83, 2);
    expect(healthInWindow.deviceRate).toBeCloseTo(0, 5);
    expect(healthInWindow.deviceRateSample).toBe(failedCount);
    expect(healthInWindow.deviceRateSample).toBeLessThanOrEqual(failedCount);
  });

  it("cuenta sentToday con el día de Lima, no el día UTC", () => {
    const current = new Date("2026-07-26T03:00:00.000Z");
    const store = new Store(":memory:", () => current);
    stores.push(store);
    store.importRecipients([scored("A", "+51999111222")]);
    const id = store.claimSend("+51999111222", "first", "Hola");
    if (id === null) throw new Error("claim inesperado");
    store.markSent(id, "wa-a");

    expect(store.loadAccountHealth(current)).toMatchObject({
      dayIndex: 1,
      sentToday: 1,
      lastSentAt: current,
    });
  });

  it("registra inbound desconocido y permite suprimirlo y tomarlo por humano", () => {
    const at = new Date("2026-07-26T03:00:00.000Z");
    const store = new Store(":memory:", () => at);
    stores.push(store);

    store.recordInbound("+51999888777", "Hola", at);
    expect(store.loadRecipientState("+51999888777")).toMatchObject({
      lastInboundAt: at,
      suppressed: false,
      humanTakeover: false,
    });

    store.suppress("+51999888777", "opt-out detectado");
    store.setHumanTakeover("+51999888777");
    expect(store.loadRecipientState("+51999888777")).toMatchObject({
      suppressed: true,
      humanTakeover: true,
    });
  });

  // El escenario real completo: se manda el primer contacto, el saludo
  // automático de WhatsApp Business llega a los segundos, y el prospecto tiene
  // que seguir recibiendo follow-ups. Antes de esto, ese saludo lo sacaba de la
  // campaña para siempre y toda la lista quedaba con un solo mensaje.
  it("un entrante automático no saca al prospecto de la cadencia", () => {
    const enviado = new Date("2026-07-27T15:00:00.000Z");
    const store = new Store(":memory:", () => enviado);
    stores.push(store);
    store.importRecipients([scored("A", "+51999111222")]);

    const id = store.claimSend("+51999111222", "first", "Hola");
    if (id === null) throw new Error("claim inesperado");
    store.markSent(id, "wa-out-1");

    store.recordInbound(
      "+51999111222",
      "Gracias por comunicarte, en breve te atenderemos",
      new Date(enviado.getTime() + 2_000),
      { waMessageId: "wa-in-1", clase: "automatico" },
    );

    const estado = store.loadRecipientState("+51999111222");
    // Queda el rastro de auditoría, pero no cuenta como respuesta.
    expect(estado.lastInboundAt).not.toBeNull();
    expect(estado.lastHumanInboundAt).toBeNull();
    // Y sigue en la cola: si la consulta y canContact divergieran, el candidato
    // pasaría una y moriría en la otra.
    expect(store.candidatosParaContactar(10).map((c) => c.e164)).toContain(
      "+51999111222",
    );
    // El agente no debe ver un turno del "prospecto" que el prospecto no escribió.
    expect(store.loadConversacion("+51999111222")).toEqual([
      { direction: "out", body: "Hola" },
    ]);
  });

  it("un entrante humano sí termina la cadencia", () => {
    const at = new Date("2026-07-27T15:00:00.000Z");
    const store = new Store(":memory:", () => at);
    stores.push(store);
    store.importRecipients([scored("A", "+51999111222")]);

    store.recordInbound("+51999111222", "¿De qué se trata?", at, {
      waMessageId: "wa-in-1",
      clase: "humano",
    });

    expect(store.loadRecipientState("+51999111222").lastHumanInboundAt).toEqual(at);
    expect(store.candidatosParaContactar(10)).toEqual([]);
  });

  it("no registra dos veces el mismo mensaje de WhatsApp", () => {
    const at = new Date("2026-07-27T15:00:00.000Z");
    const store = new Store(":memory:", () => at);
    stores.push(store);
    store.importRecipients([scored("A", "+51999111222")]);

    expect(
      store.recordInbound("+51999111222", "Hola", at, { waMessageId: "wa-in-1" }),
    ).toBe("nuevo");
    store.marcarInboundAtendido("wa-in-1", at);
    expect(
      store.recordInbound("+51999111222", "Hola", at, { waMessageId: "wa-in-1" }),
    ).toBe("ya_atendido");
    expect(store.loadConversacion("+51999111222")).toHaveLength(1);
  });

  // Recibir no es atender. Si el LLM, el handoff o el envío fallan después del
  // insert, el evento tiene que poder rehacerse: dejar sin respuesta a alguien
  // que escribió "sí, me interesa" es peor que contestarle dos veces.
  it("un entrante recibido y no atendido queda pendiente, no duplicado", () => {
    const at = new Date("2026-07-27T15:00:00.000Z");
    const store = new Store(":memory:", () => at);
    stores.push(store);
    store.importRecipients([scored("A", "+51999111222")]);

    store.recordInbound("+51999111222", "Sí, me interesa", at, {
      waMessageId: "wa-in-1",
    });
    expect(
      store.recordInbound("+51999111222", "Sí, me interesa", at, {
        waMessageId: "wa-in-1",
      }),
    ).toBe("pendiente");
    // Sigue habiendo una sola fila: se reprocesa, no se duplica el historial.
    expect(store.loadConversacion("+51999111222")).toHaveLength(1);

    store.marcarInboundAtendido("wa-in-1", at);
    expect(
      store.recordInbound("+51999111222", "Sí, me interesa", at, {
        waMessageId: "wa-in-1",
      }),
    ).toBe("ya_atendido");
  });

  // Las respuestas del agente son salientes enviados igual que un follow-up.
  // Contarlas empujaba al prospecto por encima de maxFollowUps sin que se
  // hubiera mandado un solo follow-up de campaña.
  it("las respuestas libres del agente no cuentan como follow-ups", () => {
    const at = new Date("2026-07-27T15:00:00.000Z");
    const store = new Store(":memory:", () => at);
    stores.push(store);
    store.importRecipients([scored("A", "+51999111222")]);

    const id = store.claimSend("+51999111222", "first", "Hola");
    if (id === null) throw new Error("claim inesperado");
    store.markSent(id, "wa-out-1");
    store.recordOutboundLibre("+51999111222", "Le cuento", "wa-out-2", at);
    store.recordOutboundLibre("+51999111222", "Y también", "wa-out-3", at);

    expect(store.loadRecipientState("+51999111222").followUpCount).toBe(0);
  });

  // El P2 del review: el ALTER TABLE commitea solo. Si el proceso muere entre
  // ése y el relleno, la siguiente arrancada ve la columna presente y —si el
  // relleno viviera dentro del `if`— se lo saltaría para siempre. Los salientes
  // de campaña quedarían con step nulo, followUpCount volvería a 0 y un fu1 ya
  // enviado se elegiría una y otra vez para morir contra su propia llave de
  // idempotencia, sin llegar nunca a fu2.
  it("rellena el step aunque la columna ya exista de una migración a medias", () => {
    const archivo = join(
      mkdtempSync(join(tmpdir(), "outreach-migracion-")),
      "outreach.sqlite",
    );
    const at = new Date("2026-07-27T15:00:00.000Z");
    const store = new Store(archivo, () => at);
    store.importRecipients([scored("A", "+51999111222")]);
    for (const paso of ["first", "fu1"] as const) {
      const id = store.claimSend("+51999111222", paso, `Mensaje ${paso}`);
      if (id === null) throw new Error("claim inesperado");
      store.markSent(id, `wa-out-${paso}`);
    }
    store.close();

    // Simula el corte: la columna existe pero quedó sin rellenar.
    const crudo = new DatabaseSync(archivo);
    crudo.exec("update messages set step = null");
    crudo.close();

    const reabierto = new Store(archivo, () => at);
    stores.push(reabierto);
    // Con step nulo esto habría dado 0, y el fu1 ya enviado se reintentaría solo.
    expect(reabierto.loadRecipientState("+51999111222").followUpCount).toBe(1);
  });

  it("persiste el kill switch sin permitir que un estado false lo levante", () => {
    const at = new Date("2026-07-26T03:00:00.000Z");
    const store = new Store(":memory:", () => at);
    stores.push(store);

    store.tripKillSwitch({
      tripped: true,
      reason: "auth_failure",
      trippedAt: at,
    });
    store.tripKillSwitch({ tripped: false, reason: null, trippedAt: null });

    expect(store.loadAccountHealth(at).killSwitch).toEqual({
      tripped: true,
      reason: "auth_failure",
      trippedAt: at,
    });
  });
});
