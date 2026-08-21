import { afterEach, describe, expect, it } from "vitest";

import type { ScoredProspect } from "../types.js";
import { datosTablero, type FuenteTablero } from "./datos.js";
import { Store } from "../wa/store.js";

// Helpers mínimos para poblar una base en memoria con lo que el tablero lee.
function scored(sourceId: string, e164: string): ScoredProspect {
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
      checkedAt: "2026-08-01T12:00:00.000Z",
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
  };
}

describe("datosTablero", () => {
  const stores: Store[] = [];
  const AHORA = new Date("2026-08-21T15:00:00.000Z");

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function fuenteDe(store: Store): FuenteTablero {
    return {
      loadAccountHealth: (ahora) => store.loadAccountHealth(ahora),
      colaAtencion: (limite) => store.colaAtencion(limite),
      listarClientes: () => store.listarClientes(),
      contarPorRevisar: (limite) => store.paraRevisar(limite).length,
      contarListosParaContactar: (limite) => store.candidatosParaContactar(limite).length,
    };
  }

  it("con la base vacía devuelve estados limpios y ceros", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const datos = datosTablero(fuenteDe(store), AHORA);
    expect(datos).toEqual({
      cuenta: {
        killSwitchActivo: false,
        killSwitchMotivo: null,
        deviceRate: null,
        deviceRateMuestra: 0,
        baseline: null,
        enviadosHoy: 0,
      },
      bandeja: [],
      clientes: [],
      embudo: { porRevisar: 0, listosParaContactar: 0 },
    });
  });

  it("arma la bandeja, los clientes con progreso y el estado de cuenta", () => {
    const store = new Store(":memory:", () => AHORA);
    stores.push(store);
    store.importRecipients([scored("A", "+51999111222")]);

    // Un escalado viejo: takeover con entrante humano más nuevo que el saliente.
    const haceDosDias = new Date(AHORA.getTime() - 2 * 86_400_000);
    store.recordInbound("+51999111222", "me interesa", haceDosDias, {
      waMessageId: "wa-in-1",
    });
    store.marcarInboundAtendido("wa-in-1", haceDosDias);
    store.setHumanTakeover("+51999111222");

    // Un cliente con dos de ocho requisitos.
    store.crearCliente({
      e164: "+51999222333",
      nombreComercial: "Clínica Sonrisa",
      plan: "empresa_plus",
    });
    store.marcarRequisito("+51999222333", "servicios", true);
    store.marcarRequisito("+51999222333", "fotos", true);

    // Kill switch activo para verlo reflejado.
    store.tripKillSwitch({
      tripped: true,
      reason: "loggedOut: prueba",
      trippedAt: AHORA,
    });

    const datos = datosTablero(fuenteDe(store), AHORA);

    expect(datos.cuenta.killSwitchActivo).toBe(true);
    expect(datos.cuenta.killSwitchMotivo).toBe("loggedOut: prueba");

    expect(datos.bandeja).toHaveLength(1);
    expect(datos.bandeja[0]).toMatchObject({
      e164: "+51999111222",
      nombre: "Clínica A",
      motivo: "escalado",
      etiquetaMotivo: "ESCALADA A TI",
      esperaTexto: "2 d",
      ultimoEntrante: "me interesa",
      link: "https://wa.me/51999111222",
    });

    expect(datos.clientes).toHaveLength(1);
    expect(datos.clientes[0]).toMatchObject({
      nombreComercial: "Clínica Sonrisa",
      planEtiqueta: "Empresa +",
      estado: "kickoff",
      listos: 2,
      total: 8,
      pct: 25,
    });
    expect(datos.clientes[0]?.faltantes.map((f) => f.clave)).toContain(
      "libro_reclamos",
    );
  });
});
