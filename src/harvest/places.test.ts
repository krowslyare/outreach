import { describe, expect, it, vi } from "vitest";

import type { RawProspect, WebPresence } from "../types.js";
import {
  enrichProspect,
  matchConfidence,
  type FetchLike,
  type PlacesCache,
} from "./places.js";

class MemoryCache implements PlacesCache {
  readonly values = new Map<string, WebPresence>();

  async get(sourceId: string): Promise<WebPresence | null> {
    return this.values.get(sourceId) ?? null;
  }

  async set(sourceId: string, value: WebPresence): Promise<void> {
    this.values.set(sourceId, value);
  }
}

function prospect(overrides: Partial<RawProspect> = {}): RawProspect {
  return {
    source: "renipress",
    sourceId: "000123",
    name: "Centro Dental Sonrisa Bella",
    classification: "CENTRO ODONTOLOGICO",
    category: "I-2",
    district: "MIRAFLORES",
    ubigeo: "150122",
    address: "Av. Ejemplo 123",
    lat: -12.0675439,
    lng: -77.0368198,
    phones: [{ raw: "999111222", e164: "+51999111222", kind: "mobile" }],
    ...overrides,
  };
}

function response(status: number, payload: unknown): Response {
  return {
    status,
    json: async () => payload,
  } as Response;
}

describe("matchConfidence", () => {
  it("da máxima confianza con nombre coincidente y distancia menor a 100 m", () => {
    expect(
      matchConfidence(prospect(), {
        id: "place-1",
        displayName: { text: "Clínica Sonrisa Bella" },
        location: {
          latitude: -12.0672,
          longitude: -77.0368,
        },
      }),
    ).toBe(0.95);
  });

  it("usa solo el nombre cuando el registro no tiene coordenadas", () => {
    expect(
      matchConfidence(prospect({ lat: null, lng: null }), {
        id: "place-1",
        displayName: { text: "Clínica Sonrisa Bella" },
      }),
    ).toBe(0.7);
  });
});

describe("enrichProspect", () => {
  it("devuelve presencia vacía y la cachea cuando Places no encuentra resultados", async () => {
    const cache = new MemoryCache();
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(response(200, { places: [] }));

    const enriched = await enrichProspect(prospect(), {
      apiKey: "test-key",
      fetch: fetchMock,
      cache,
      now: () => new Date("2026-07-26T12:00:00.000Z"),
    });

    expect(enriched.web).toEqual({
      checkedAt: "2026-07-26T12:00:00.000Z",
      placeId: null,
      websiteUri: null,
      rating: null,
      userRatingCount: null,
      matchConfidence: 0,
    });
    expect(cache.values.get("000123")).toEqual(enriched.web);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
      textQuery: "Centro Dental Sonrisa Bella MIRAFLORES Lima Perú",
      locationBias: {
        circle: {
          center: {
            latitude: -12.0675439,
            longitude: -77.0368198,
          },
          radius: 300,
        },
      },
    });
  });

  it("reintenta un 429 y usa el resultado del siguiente intento", async () => {
    const cache = new MemoryCache();
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(response(429, {}))
      .mockResolvedValueOnce(
        response(200, {
          places: [
            {
              id: "place-2",
              displayName: { text: "Sonrisa Bella" },
              websiteUri: "https://sonrisa.example",
              rating: 4.7,
              userRatingCount: 21,
              location: {
                latitude: -12.0672,
                longitude: -77.0368,
              },
            },
          ],
        }),
      );

    const enriched = await enrichProspect(prospect(), {
      apiKey: "test-key",
      fetch: fetchMock,
      cache,
      sleep,
      retryBackoffMs: 10,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
    expect(enriched.web).toMatchObject({
      placeId: "place-2",
      websiteUri: "https://sonrisa.example",
      matchConfidence: 0.95,
    });
  });

  it("usa un caché fresco sin llamar a la API", async () => {
    const cache = new MemoryCache();
    const cached: WebPresence = {
      checkedAt: "2026-07-20T12:00:00.000Z",
      placeId: "cached-place",
      websiteUri: null,
      rating: 4.4,
      userRatingCount: 10,
      matchConfidence: 0.8,
    };
    cache.values.set("000123", cached);
    const fetchMock = vi.fn<FetchLike>();

    const enriched = await enrichProspect(prospect(), {
      apiKey: "test-key",
      fetch: fetchMock,
      cache,
      now: () => new Date("2026-07-26T12:00:00.000Z"),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(enriched.web).toEqual(cached);
  });
});

describe("errores distinguibles de \"sin coincidencias\"", () => {
  // Un fallo de API produce el mismo matchConfidence 0 que una búsqueda
  // legítima sin resultados. Sin distinguirlos, una key mal configurada se lee
  // como "el matching no sirve" y se termina culpando a la heurística en vez
  // de revisar la consola de Google.
  function errorResponse(status: number, message: string): Response {
    return {
      status,
      text: async () => JSON.stringify({ error: { code: status, message } }),
      json: async () => ({ error: { code: status, message } }),
    } as Response;
  }

  it("un 403 deja el motivo en web.error, con el mensaje de Google", async () => {
    const cache = new MemoryCache();
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        errorResponse(403, "Places API (New) has not been used in project 1 before or it is disabled."),
      );

    const enriched = await enrichProspect(prospect(), {
      apiKey: "k",
      fetch: fetchMock,
      cache,
    });

    expect(enriched.web.matchConfidence).toBe(0);
    expect(enriched.web.error).toContain("HTTP 403");
    expect(enriched.web.error).toContain("disabled");
    // Un error de configuración se arregla: la próxima corrida debe reintentar,
    // así que no se cachea.
    expect(cache.values.size).toBe(0);
  });

  it("una búsqueda sin resultados NO deja error", async () => {
    const cache = new MemoryCache();
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(response(200, { places: [] }));

    const enriched = await enrichProspect(prospect(), {
      apiKey: "k",
      fetch: fetchMock,
      cache,
    });

    expect(enriched.web.matchConfidence).toBe(0);
    expect(enriched.web.error).toBeUndefined();
  });
});

describe("verificación de ausencia de web por coordenadas", () => {
  const placeCerca = (websiteUri?: string) => ({
    id: "place-1",
    displayName: { text: "Clínica Sonrisa Bella" },
    location: { latitude: -12.0672, longitude: -77.0368 },
    ...(websiteUri === undefined ? {} : { websiteUri }),
  });

  it("marca verificadoSinWeb en un match de 0.95 sin websiteUri", async () => {
    // 0.95 solo se alcanza por coordenadas: Place a menos de 100 m del
    // domicilio declarado Y solape de nombre. A esa altura se acepta que la
    // ausencia del campo en Places equivale a no tener sitio.
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(response(200, { places: [placeCerca()] }));

    const enriched = await enrichProspect(prospect(), {
      apiKey: "k",
      fetch: fetchMock,
      cache: new MemoryCache(),
    });

    expect(enriched.web.matchConfidence).toBe(0.95);
    expect(enriched.web.verificadoSinWeb).toBe(true);
  });

  it("NO lo marca en un match por solo nombre, aunque no haya websiteUri", async () => {
    // Sin coordenadas el match se sostiene solo en el nombre y topa en 0.70.
    // Ahí la ausencia del campo no alcanza como evidencia.
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      response(200, {
        places: [{ id: "place-1", displayName: { text: "Clínica Sonrisa Bella" } }],
      }),
    );

    const enriched = await enrichProspect(prospect({ lat: null, lng: null }), {
      apiKey: "k",
      fetch: fetchMock,
      cache: new MemoryCache(),
    });

    expect(enriched.web.matchConfidence).toBe(0.7);
    expect(enriched.web.verificadoSinWeb).toBe(false);
  });

  it("NO lo marca cuando el negocio SÍ tiene web", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        response(200, { places: [placeCerca("https://ejemplo.pe")] }),
      );

    const enriched = await enrichProspect(prospect(), {
      apiKey: "k",
      fetch: fetchMock,
      cache: new MemoryCache(),
    });

    expect(enriched.web.verificadoSinWeb).toBe(false);
  });
});

describe("empate en la cima de confianza", () => {
  const cerca = (id: string, websiteUri?: string) => ({
    id,
    displayName: { text: "Clínica Sonrisa Bella" },
    location: { latitude: -12.0672, longitude: -77.0368 },
    ...(websiteUri === undefined ? {} : { websiteUri }),
  });

  it("no verifica cuando un candidato empatado SÍ tiene web", async () => {
    // La selección conserva el primero ante empate. Si el segundo es igual de
    // confiable y tiene web, la evidencia se contradice: no sabemos cuál es el
    // negocio. Verificar acá significaría escribirle "vi que no tienes web" a
    // alguien que sí la tiene.
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      response(200, {
        places: [cerca("sin-web"), cerca("con-web", "https://ejemplo.pe")],
      }),
    );

    const enriched = await enrichProspect(prospect(), {
      apiKey: "k",
      fetch: fetchMock,
      cache: new MemoryCache(),
    });

    expect(enriched.web.matchConfidence).toBe(0.95);
    expect(enriched.web.websiteUri).toBeNull();
    expect(enriched.web.verificadoSinWeb).toBe(false);
  });

  it("sí verifica cuando todos los empatados carecen de web", async () => {
    // Places duplica entradas del mismo negocio con frecuencia. Si ninguna
    // tiene sitio, el empate no aporta contradicción y la verificación se
    // sostiene.
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      response(200, { places: [cerca("dup-1"), cerca("dup-2")] }),
    );

    const enriched = await enrichProspect(prospect(), {
      apiKey: "k",
      fetch: fetchMock,
      cache: new MemoryCache(),
    });

    expect(enriched.web.verificadoSinWeb).toBe(true);
  });
});
