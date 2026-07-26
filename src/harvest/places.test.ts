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
