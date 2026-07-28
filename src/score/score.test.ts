import { describe, expect, it } from "vitest";

import type { EnrichedProspect } from "../types.js";
import { scoreProspect } from "./score.js";

function enriched(overrides: Partial<EnrichedProspect> = {}): EnrichedProspect {
  return {
    source: "renipress",
    sourceId: "000123",
    name: "Centro Dental Ejemplo",
    classification: "CENTRO ODONTOLOGICO",
    category: "I-2",
    district: "MIRAFLORES",
    ubigeo: "150122",
    address: "Av. Ejemplo 123",
    lat: -12.0675439,
    lng: -77.0368198,
    phones: [{ raw: "999111222", e164: "+51999111222", kind: "mobile" }],
    web: {
      checkedAt: "2026-07-26T12:00:00.000Z",
      placeId: "place-1",
      websiteUri: null,
      rating: 4.6,
      userRatingCount: 55,
      matchConfidence: 0.9,
    },
    ...overrides,
  };
}

describe("scoreProspect", () => {
  it("suma señales y limita el score a 100", () => {
    const base = enriched();
    const result = scoreProspect({
      ...base,
      web: { ...base.web, verificadoSinWeb: true },
    });

    expect(result.score).toBe(100);
    expect(result.signals.map((signal) => signal.points)).toEqual([
      40, 20, 20, 8, 12,
    ]);
  });

  it("contacta sin verificar, pero puntúa menos que un verificado", () => {
    // Que Places no traiga websiteUri es un dato ausente, no una prueba, así
    // que vale menos. Ya NO bloquea: ese bloqueo costaba el 90% del pipeline y
    // protegía contra una afirmación que el mensaje ya no hace. La garantía
    // vive ahora en compose.ts, que con `tieneWeb: null` ordena preguntar en
    // vez de afirmar. Si el mensaje vuelve a afirmar la ausencia de web, esto
    // tiene que volver a ser un bloqueo.
    const result = scoreProspect(enriched());

    expect(result.eligible).toBe(true);
    expect(result.blockers).toEqual([]);
    const sinWeb = result.signals.find((s) => s.name === "sin_web");
    expect(sinWeb?.points).toBe(22);
    expect(sinWeb?.detail).toContain("sin verificar");

    // Un verificado tiene que seguir puntuando por encima, o el orden de la
    // cola dejaría de reflejar la calidad del dato.
    const base = enriched();
    const verificado = scoreProspect({
      ...base,
      web: { ...base.web, verificadoSinWeb: true },
    });
    expect(verificado.score).toBeGreaterThan(result.score);
  });

  it("habilita el contacto cuando la ausencia de web está verificada", () => {
    const base = enriched();
    const result = scoreProspect({
      ...base,
      web: { ...base.web, verificadoSinWeb: true },
    });

    expect(result.score).toBe(100);
    expect(result.eligible).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.signals.find((s) => s.name === "sin_web")?.detail).toContain(
      "verificado",
    );
  });

  it("bloquea un match de Places poco confiable aunque sigue scoreando", () => {
    const result = scoreProspect(
      enriched({
        classification: "CONSULTORIOS MEDICOS",
        district: "COMAS",
        web: {
          ...enriched().web,
          matchConfidence: 0.59,
          userRatingCount: 5,
        },
      }),
    );

    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain(
      "match de Places poco confiable, revisar a mano",
    );
    expect(result.score).toBe(24);
  });

  it("bloquea un negocio que ya tiene web y no le suma la señal sin web", () => {
    const result = scoreProspect(
      enriched({
        web: {
          ...enriched().web,
          websiteUri: "https://clinica.example",
          rating: null,
          userRatingCount: null,
        },
      }),
    );

    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("ya tiene web");
    expect(result.signals.some((signal) => signal.name === "sin_web")).toBe(false);
    expect(result.score).toBe(32);
  });

  it("bloquea si no existe móvil para contactar por WhatsApp", () => {
    const result = scoreProspect(
      enriched({
        phones: [{ raw: "4455667", e164: "+514455667", kind: "landline" }],
      }),
    );

    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain(
      "no tiene teléfono móvil para WhatsApp",
    );
  });
});
