import { describe, expect, it, vi } from "vitest";

import {
  asManualInput,
  discoverPlaces,
  shortlistFromPlaces,
  type DiscoveryFetch,
} from "./places-discovery.js";

describe("descubrimiento modular con Places", () => {
  it("pide solo una página acotada y conserva el distrito", async () => {
    const fetcher = vi.fn<DiscoveryFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ places: [] }),
    } as Response);

    await discoverPlaces(
      {
        apiKey: "test",
        query: "clínica veterinaria",
        district: "Surco",
        pageSize: 10,
      },
      fetcher,
    );

    const request = fetcher.mock.calls[0]!;
    expect(request[0]).toBe(
      "https://places.googleapis.com/v1/places:searchText",
    );
    expect(JSON.parse(request[1]!.body as string)).toEqual({
      textQuery: "clínica veterinaria en Surco, Lima, Perú",
      languageCode: "es",
      regionCode: "PE",
      pageSize: 10,
    });
  });

  it("filtra web, fijos y cierres; ordena por operación comprobable", () => {
    const shortlist = shortlistFromPlaces(
      [
        {
          id: "strong",
          displayName: { text: "Veterinaria Patitas" },
          nationalPhoneNumber: "999 111 222",
          formattedAddress: "Av. Principal 123, Surco",
          rating: 4.7,
          userRatingCount: 120,
          businessStatus: "OPERATIONAL",
        },
        {
          id: "web",
          displayName: { text: "Veterinaria Web" },
          nationalPhoneNumber: "999 222 333",
          formattedAddress: "Av. Principal 123, Surco",
          websiteUri: "https://veterinaria.pe",
        },
        {
          id: "fixed",
          displayName: { text: "Veterinaria Fijo" },
          nationalPhoneNumber: "01 445 6677",
          formattedAddress: "Av. Principal 123, Surco",
        },
        {
          id: "closed",
          displayName: { text: "Veterinaria Cerrada" },
          nationalPhoneNumber: "999 333 444",
          formattedAddress: "Av. Principal 123, Surco",
          businessStatus: "CLOSED_PERMANENTLY",
        },
        {
          id: "wrong-district",
          displayName: { text: "Veterinaria Lejana" },
          nationalPhoneNumber: "999 444 555",
          formattedAddress: "Av. Principal 123, La Molina",
        },
        {
          id: "public",
          displayName: { text: "Veterinaria Municipal de Surco" },
          nationalPhoneNumber: "999 555 666",
          formattedAddress: "Av. Principal 123, Surco",
        },
      ],
      "veterinary",
      "Surco",
      "clínica veterinaria",
    );

    expect(shortlist).toHaveLength(1);
    expect(shortlist[0]).toMatchObject({
      placeId: "strong",
      e164: "+51999111222",
      district: "SURCO",
      score: 90,
    });
    expect(asManualInput(shortlist[0]!, "veterinary")).toMatchObject({
      origin: "places",
      vertical: "veterinary",
      verifiedWithoutWebsite: false,
      approve: false,
    });
  });

  it("reporta el mensaje de error de Google", async () => {
    const fetcher = vi.fn<DiscoveryFetch>().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({ error: { message: "API key not authorized" } }),
    } as Response);

    await expect(
      discoverPlaces(
        {
          apiKey: "test",
          query: "dentista",
          district: "Miraflores",
        },
        fetcher,
      ),
    ).rejects.toThrow("API key not authorized");
  });
});
