import { afterEach, describe, expect, it } from "vitest";

import type { ScoredProspect } from "../types.js";
import { Store } from "./store.js";

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
