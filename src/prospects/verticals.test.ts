import { describe, expect, it } from "vitest";

import {
  perfilVerticalParaPrompt,
  VERTICALES,
  VERTICAL_IDS,
  verticalConfig,
} from "./verticals.js";

describe("perfiles verticales", () => {
  it("incluye constructoras e interiorismo como verticales completas", () => {
    expect(VERTICAL_IDS).toContain("construction");
    expect(VERTICAL_IDS).toContain("contractors");
    expect(VERTICAL_IDS).toContain("interiors");
    expect(VERTICALES.construction.commercial.primaryAngle).toMatch(
      /imagen corporativa|proyectos/iu,
    );
    expect(VERTICALES.interiors.commercial.visualDirection).toMatch(
      /Awwwards|portafolio/iu,
    );
    expect(VERTICALES.contractors.commercial.primaryAngle).toMatch(
      /capacidad operativa|B2B/iu,
    );
  });

  it("cada vertical expone el contrato comercial completo", () => {
    for (const id of VERTICAL_IDS) {
      const config = VERTICALES[id];
      expect(config.id).toBe(id);
      expect(config.placeQueries.length).toBeGreaterThan(0);
      expect(config.strongSignals.length).toBeGreaterThan(0);
      expect(config.commercial.audience).not.toBe("");
      expect(config.commercial.primaryAngle).not.toBe("");
      expect(config.commercial.productHooks.length).toBeGreaterThan(0);
      expect(config.commercial.complianceAngle).not.toBe("");
      expect(config.commercial.visualDirection).not.toBe("");
    }
  });

  it("genera un bloque compartido para compositor y agente", () => {
    const bloque = perfilVerticalParaPrompt("construction");

    expect(bloque).toContain("<perfil_vertical>");
    expect(bloque).toContain("Constructoras e inmobiliarias");
    expect(bloque).toContain("Ángulo principal:");
    expect(bloque).toContain("Cumplimiento:");
    expect(bloque).toContain("ni autoriza a afirmar experiencia previa");
  });

  it("falla cerrado con verticales legacy o desconocidas", () => {
    expect(verticalConfig("inventada")).toBeNull();
    expect(perfilVerticalParaPrompt(null)).toContain("Vertical: no verificada");
  });
});
