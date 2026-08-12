import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScoredProspect } from "../types.js";
import { esSitioPropio, Store } from "./store.js";

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
    const prospecto = scored("A", "+51999111222");
    store.importRecipients([
      {
        ...prospecto,
        web: { ...prospecto.web, verificadoSinWeb: true },
      },
    ]);
    store.guardarPerfilWhatsApp("+51999111222", {
      description: "Clínica A",
      category: "Dentista",
      address: "Miraflores",
      websites: [],
    });
    expect(store.aprobarProspecto("+51999111222").ok).toBe(true);

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

describe("pendientes y autoría de mensajes", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function conProspecto(ahora: Date): Store {
    const store = new Store(":memory:", () => ahora);
    stores.push(store);
    store.importRecipients([scored("A", "+51999111222")]);
    return store;
  }

  const AHORA = new Date("2026-07-28T15:00:00.000Z");

  it("devuelve el entrante sin atender y lo saca al marcarlo", () => {
    const store = conProspecto(AHORA);
    store.recordInbound("+51999111222", "¿cuánto cuesta?", AHORA, {
      waMessageId: "wa-1",
      clase: "humano",
    });

    expect(store.inboundsPendientes(10)).toEqual([
      { e164: "+51999111222", waMessageId: "wa-1", at: AHORA },
    ]);

    store.marcarInboundAtendido("wa-1", AHORA);
    expect(store.inboundsPendientes(10)).toEqual([]);
  });

  // Un autorespondedor se registra sin atender y no hay nada que contestarle:
  // devolverlo acá haría que el barrido le hable a un robot todas las veces.
  it("no devuelve entrantes automáticos", () => {
    const store = conProspecto(AHORA);
    store.recordInbound("+51999111222", "Gracias por comunicarse", AHORA, {
      waMessageId: "wa-auto",
      clase: "automatico",
    });

    expect(store.inboundsPendientes(10)).toEqual([]);
  });

  it("no devuelve a quien ya está suprimido o tomado por un humano", () => {
    const store = conProspecto(AHORA);
    store.recordInbound("+51999111222", "hola", AHORA, {
      waMessageId: "wa-2",
      clase: "humano",
    });
    store.setHumanTakeover("+51999111222");

    expect(store.inboundsPendientes(10)).toEqual([]);
  });

  // Sin esto, reiniciar el proceso haría que sus propios envíos recientes
  // parecieran escritos a mano desde el celular, y el takeover mataría la
  // conversación con ese prospecto.
  it("reconoce como propio un saliente que ya está en la base", () => {
    const store = conProspecto(AHORA);
    store.recordOutboundLibre("+51999111222", "hola", "wa-out", AHORA);

    expect(store.esMensajeNuestro("wa-out")).toBe(true);
    expect(store.esMensajeNuestro("wa-desconocido")).toBe(false);
  });

  it("un entrante nunca cuenta como mensaje nuestro", () => {
    const store = conProspecto(AHORA);
    store.recordInbound("+51999111222", "hola", AHORA, {
      waMessageId: "wa-in",
      clase: "humano",
    });

    expect(store.esMensajeNuestro("wa-in")).toBe(false);
  });
});

describe("has_website con tres estados", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function importado(web: Partial<ScoredProspect["web"]>): boolean | null {
    const store = new Store(":memory:");
    stores.push(store);
    const base = scored("A", "+51999111222");
    store.importRecipients([{ ...base, web: { ...base.web, ...web } }]);
    return store.loadFichaProspecto("+51999111222")!.tieneWeb;
  }

  // LA regresión que costaba el 90% del pipeline en el otro sentido: guardar
  // "no sé" como "no tiene" autoriza al compositor a decirle a alguien "vi que
  // no tienen web" cuando en realidad nadie lo verificó.
  it("sin verificar llega como 'no sé', no como 'no tiene'", () => {
    expect(importado({ websiteUri: null, verificadoSinWeb: false })).toBeNull();
  });

  it("verificado sin web llega como false", () => {
    expect(importado({ websiteUri: null, verificadoSinWeb: true })).toBe(false);
  });

  it("con web llega como true aunque no se haya 'verificado'", () => {
    expect(
      importado({ websiteUri: "https://ejemplo.pe", verificadoSinWeb: false }),
    ).toBe(true);
  });
});

describe("revisión manual del tramo sin verificar", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function conPendiente(): Store {
    const store = new Store(":memory:");
    stores.push(store);
    const base = scored("A", "+51999111222");
    store.importRecipients([
      { ...base, score: 50, web: { ...base.web, verificadoSinWeb: false } },
    ]);
    return store;
  }

  it("lista solo los que quedaron en 'no se sabe'", () => {
    const store = conPendiente();
    const base = scored("B", "+51999333444");
    store.importRecipients([
      { ...base, web: { ...base.web, verificadoSinWeb: true } },
    ]);

    expect(store.paraRevisar(10).map((p) => p.e164)).toEqual(["+51999111222"]);
  });

  // Confirmar que no tiene web es información nueva: tiene que reflejarse en el
  // orden de la cola, o revisar no serviría de nada.
  it("confirmar que no tiene web sube el score y sale de la lista", () => {
    const store = conPendiente();

    expect(store.resolverWeb("+51999111222", false, 18)).toBe(true);
    store.guardarPerfilWhatsApp("+51999111222", {
      description: "Clínica A",
      category: "Dentista",
      address: "Miraflores",
      websites: [],
    });
    expect(store.aprobarProspecto("+51999111222").ok).toBe(true);
    expect(store.loadFichaProspecto("+51999111222")!.tieneWeb).toBe(false);
    expect(store.paraRevisar(10)).toEqual([]);
    expect(
      store.candidatosParaContactar(10).find((c) => c.e164 === "+51999111222")
        ?.score,
    ).toBe(68);
  });

  // El producto ES la web: quien ya tiene una no es prospecto.
  it("marcar que sí tiene web lo saca de la cola", () => {
    const store = conPendiente();

    expect(store.resolverWeb("+51999111222", true, 18)).toBe(true);
    expect(store.loadRecipientState("+51999111222").suppressed).toBe(true);
    expect(store.candidatosParaContactar(10)).toEqual([]);
  });

  // Sin esto, un tipeo en el número se leería como revisión hecha.
  it("no finge haber resuelto algo que no estaba pendiente", () => {
    const store = conPendiente();
    store.resolverWeb("+51999111222", false, 18);

    expect(store.resolverWeb("+51999111222", true, 18)).toBe(false);
    expect(store.resolverWeb("+51900000000", false, 18)).toBe(false);
  });
});

describe("existeDestinatario", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  // loadRecipientState lanza para un desconocido, y la detección de envíos
  // manuales corre sin await: esa excepción se llevaba el proceso entero.
  it("responde sin lanzar para un número que no está", () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.importRecipients([scored("A", "+51999111222")]);

    expect(store.existeDestinatario("+51999111222")).toBe(true);
    expect(store.existeDestinatario("+51900000000")).toBe(false);
    expect(() => store.loadRecipientState("+51900000000")).toThrow();
  });
});

describe("pendientes acotados y revisión que sobrevive al harvest", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  const AHORA = new Date("2026-07-28T15:00:00.000Z");

  // Con el límite global, 50 pendientes viejos de otros chats tapaban el
  // mensaje recién llegado: el prospecto en vivo se quedaba sin respuesta.
  it("acota los pendientes al número pedido, no filtrando después", () => {
    const store = new Store(":memory:", () => AHORA);
    stores.push(store);
    store.importRecipients(
      Array.from({ length: 4 }, (_, i) =>
        scored(`S${i}`, `+5199900000${i}`),
      ),
    );
    for (let i = 0; i < 4; i += 1) {
      store.recordInbound(`+5199900000${i}`, "hola", AHORA, {
        waMessageId: `wa-${i}`,
        clase: "humano",
      });
    }

    // Límite 1: sin acotar en SQL, solo saldría el más viejo (wa-0).
    expect(store.inboundsPendientes(1, "+51999000003")).toEqual([
      { e164: "+51999000003", waMessageId: "wa-3", at: AHORA },
    ]);
    // Sin número sigue siendo global.
    expect(store.inboundsPendientes(1)[0]?.waMessageId).toBe("wa-0");
  });

  // El trabajo manual de revisar 55 prospectos no puede perderse porque alguien
  // vuelva a correr el harvest.
  it("una reimportación no pisa lo que se resolvió a mano", () => {
    const store = new Store(":memory:", () => AHORA);
    stores.push(store);
    const base = scored("A", "+51999111222");
    const sinVerificar = {
      ...base,
      score: 50,
      web: { ...base.web, websiteUri: null, verificadoSinWeb: false },
    };
    store.importRecipients([sinVerificar]);
    store.resolverWeb("+51999111222", false, 18);
    store.guardarPerfilWhatsApp("+51999111222", {
      description: "Clínica A",
      category: "Dentista",
      address: "Miraflores",
      websites: [],
    });
    expect(store.aprobarProspecto("+51999111222").ok).toBe(true);

    store.importRecipients([sinVerificar]);

    expect(store.loadFichaProspecto("+51999111222")!.tieneWeb).toBe(false);
    expect(store.paraRevisar(10)).toEqual([]);
    expect(
      store.candidatosParaContactar(10).find((c) => c.e164 === "+51999111222")
        ?.score,
    ).toBe(68);
  });

  // Un hallazgo NUEVO sí gana, y llega como NO elegible: scoreProspect le pone
  // el bloqueo "ya tiene web". El primer intento de este test pasaba `eligible:
  // true`, que es un estado que scoreProspect nunca produce — o sea probaba un
  // escenario imposible mientras el real (importRecipients hace `continue` y
  // descarta la información) quedaba sin cubrir.
  it("un harvest que descubre web corrige y saca de la cola la fila vieja", () => {
    const store = new Store(":memory:", () => AHORA);
    stores.push(store);
    const base = scored("A", "+51999111222");
    store.importRecipients([
      { ...base, web: { ...base.web, websiteUri: null, verificadoSinWeb: false } },
    ]);
    store.resolverWeb("+51999111222", false, 18);

    store.importRecipients([
      {
        ...base,
        eligible: false,
        blockers: ["ya tiene web"],
        web: { ...base.web, websiteUri: "https://ejemplo.pe" },
      },
    ]);

    expect(store.loadFichaProspecto("+51999111222")!.tieneWeb).toBe(true);
    expect(store.loadRecipientState("+51999111222").suppressed).toBe(true);
    expect(store.candidatosParaContactar(10)).toEqual([]);
  });

  // Pero un bloqueado que NO tiene web tampoco debe crear filas nuevas.
  it("un bloqueado sin web no entra a la cola", () => {
    const store = new Store(":memory:", () => AHORA);
    stores.push(store);
    const base = scored("Z", "+51999888777");
    store.importRecipients([
      { ...base, eligible: false, blockers: ["match poco confiable"] },
    ]);

    expect(store.existeDestinatario("+51999888777")).toBe(false);
  });
});

describe("la revisión es del establecimiento, no del teléfono", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  // Un mismo source_id con dos móviles crea dos filas. Aplicar la revisión a
  // una sola dejaba la otra contactable: el bot le escribía al mismo negocio por
  // el otro número, después de que alguien ya verificó que tiene web.
  it("marcar 'tiene web' suprime todos los números del mismo negocio", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const base = scored("A", "+51999111222");
    store.importRecipients([
      {
        ...base,
        phones: [
          { raw: "999111222", e164: "+51999111222", kind: "mobile" },
          { raw: "988222333", e164: "+51988222333", kind: "mobile" },
        ],
        web: { ...base.web, websiteUri: null, verificadoSinWeb: false },
      },
    ]);

    expect(store.resolverWeb("+51999111222", true, 18)).toBe(true);

    expect(store.loadRecipientState("+51999111222").suppressed).toBe(true);
    expect(store.loadRecipientState("+51988222333").suppressed).toBe(true);
    expect(store.candidatosParaContactar(10)).toEqual([]);
    expect(store.paraRevisar(10)).toEqual([]);
  });
});

describe("gate de aprobación de prospectos", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function verificado(
    sourceId = "A",
    e164 = "+51999111222",
  ): ScoredProspect {
    const base = scored(sourceId, e164);
    return {
      ...base,
      web: { ...base.web, verificadoSinWeb: true },
    };
  }

  it("un harvest real nace pendiente y no puede salir por campaña", () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.importRecipients([verificado()]);

    expect(store.listarProspectos("pending", 10)).toHaveLength(1);
    expect(store.candidatosParaContactar(10)).toEqual([]);
    expect(store.aprobarProspecto("+51999111222")).toEqual({
      ok: false,
      reason: "falta consultar el perfil actual de WhatsApp",
    });
  });

  it("preflight más identidad confirmada habilita un lead manual de Meta", () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.upsertManualProspect({
      e164: "+51999111222",
      name: "Veterinaria Patitas",
      district: "SURCO",
      classification: "CLÍNICA VETERINARIA",
      vertical: "veterinary",
      origin: "meta",
      sourceUrl: "https://www.facebook.com/ads/library/",
      notes: "anuncio activo a WhatsApp",
      score: 90,
      verifiedWithoutWebsite: true,
      approve: false,
    });
    store.guardarPerfilWhatsApp("+51999111222", {
      description: "Patitas, atención veterinaria",
      category: "Veterinario",
      address: "Surco",
      websites: ["https://instagram.com/patitas"],
    });

    expect(store.aprobarProspecto("+51999111222").ok).toBe(true);
    expect(store.candidatosParaContactar(10)).toEqual([
      { e164: "+51999111222", score: 90 },
    ]);
    expect(store.listarProspectos("approved", 10)[0]).toMatchObject({
      vertical: "veterinary",
      origin: "meta",
      sourceUrl: "https://www.facebook.com/ads/library/",
    });
  });

  it("un sitio propio encontrado en WhatsApp bloquea la aprobación", () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.importRecipients([verificado()]);
    store.guardarPerfilWhatsApp("+51999111222", {
      description: "Clínica A",
      category: "Dentista",
      address: "Miraflores",
      websites: ["https://clinica-a.pe"],
    });

    expect(store.aprobarProspecto("+51999111222")).toEqual({
      ok: false,
      reason: "el perfil de WhatsApp muestra un sitio web propio",
    });
    expect(store.candidatosParaContactar(10)).toEqual([]);
  });

  it("aprobar un teléfono rechaza los duplicados del establecimiento", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const base = verificado();
    store.importRecipients([
      {
        ...base,
        phones: [
          { raw: "999111222", e164: "+51999111222", kind: "mobile" },
          { raw: "988222333", e164: "+51988222333", kind: "mobile" },
        ],
      },
    ]);
    store.guardarPerfilWhatsApp("+51999111222", {
      description: "Clínica A",
      category: "Dentista",
      address: "Miraflores",
      websites: [],
    });

    expect(store.aprobarProspecto("+51999111222")).toEqual({
      ok: true,
      affected: 2,
    });
    expect(store.listarProspectos("approved", 10).map((row) => row.e164)).toEqual([
      "+51999111222",
    ]);
    expect(store.listarProspectos("rejected", 10)[0]?.reviewReason).toContain(
      "+51999111222",
    );
  });

  it("los números de prueba siguen habilitados sin debilitar leads reales", () => {
    const store = new Store(":memory:");
    stores.push(store);
    store.importRecipients([verificado("prueba:+51999111222")]);

    expect(store.candidatosParaContactar(10)).toEqual([
      { e164: "+51999111222", score: 80 },
    ]);
  });

  it("filtra la cola por vertical para no mezclar cohortes", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const sinWeb = {
      ...scored("base", "+51990000000").web,
      verificadoSinWeb: true,
    };
    store.importRecipients([
      scored("prueba:dental", "+51999111222", { web: sinWeb }),
      scored("prueba:veterinary", "+51999222333", {
        classification: "CLÍNICA VETERINARIA",
        web: sinWeb,
      }),
    ]);

    expect(store.candidatosParaContactar(10, 0, "dental")).toEqual([
      { e164: "+51999111222", score: 80 },
    ]);
    expect(store.candidatosParaContactar(10, 0, "veterinary")).toEqual([
      { e164: "+51999222333", score: 80 },
    ]);
  });

  it("migra una base anterior dejando lo real pendiente", () => {
    const dir = mkdtempSync(join(tmpdir(), "outreach-approval-"));
    const filename = join(dir, "old.sqlite");
    const db = new DatabaseSync(filename);
    db.exec(`
      create table recipients (
        e164 text primary key, source_id text not null, name text not null,
        district text not null, classification text not null, score integer,
        suppressed integer not null default 0, suppressed_reason text,
        human_takeover integer not null default 0, created_at text not null,
        has_website integer, review_count integer
      );
      insert into recipients (
        e164, source_id, name, district, classification, score, created_at,
        has_website
      ) values (
        '+51999111222', '0001', 'Clínica vieja', 'SURCO',
        'CENTRO ODONTOLOGICO', 80, '2026-07-01T00:00:00.000Z', 0
      );
    `);
    db.close();

    const store = new Store(filename);
    stores.push(store);
    expect(store.listarProspectos("pending", 10).map((row) => row.e164)).toEqual([
      "+51999111222",
    ]);
    expect(store.candidatosParaContactar(10)).toEqual([]);
  });

  it("distingue una red social de un sitio propio", () => {
    expect(esSitioPropio("https://instagram.com/clinica")).toBe(false);
    expect(esSitioPropio("https://wa.me/51999111222")).toBe(false);
    expect(esSitioPropio("clinica.pe")).toBe(true);
    expect(esSitioPropio("texto que no es url")).toBe(false);
  });
});
