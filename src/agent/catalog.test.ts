import { describe, expect, it } from "vitest";

import {
  catalogoParaPrompt,
  MODULOS_ACTIVABLES,
  PLANES,
  PRICING_VERIFICADO_EN,
} from "./catalog.js";

describe("catálogo de planes", () => {
  it("conserva exactamente los códigos y precios vigentes", () => {
    expect(
      PLANES.map(({ code, precio }) => ({ code, precio })),
    ).toEqual([
      { code: "waas_presencia_199", precio: "S/ 199 mensual" },
      { code: "waas_empresa_449", precio: "S/ 449 mensual" },
      { code: "waas_empresa_plus_649", precio: "S/ 649 mensual" },
      { code: "waas_sistemas_999", precio: "Desde S/ 999 mensual" },
    ]);
  });

  it("no conserva códigos anteriores a la migración de julio de 2026", () => {
    const codigos = PLANES.map((plan) => plan.code);

    expect(codigos).not.toContain("waas_esencial_199");
    expect(codigos).not.toContain("waas_empresa_399");
    expect(codigos).not.toContain("waas_sistemas_899");
  });

  it("incluye todos los nombres y etiquetas de precio en el prompt", () => {
    const catalogo = catalogoParaPrompt();

    for (const plan of PLANES) {
      // Se revisan ambas cadenas porque el prompt es el contrato visible del agente.
      expect(catalogo).toContain(plan.nombre);
      expect(catalogo).toContain(plan.precio);
      expect(catalogo).toContain(plan.portal);
    }
  });

  it("incluye los módulos activables y deja claro que no vienen por defecto", () => {
    const catalogo = catalogoParaPrompt();

    expect(catalogo).toContain(
      "Módulos activables — no están incluidos por defecto",
    );
    for (const modulo of MODULOS_ACTIVABLES) {
      expect(catalogo).toContain(modulo.nombre);
      expect(catalogo).toContain(modulo.precio);
      expect(catalogo).toContain(modulo.implementacion);
    }
  });

  it("registra la fecha de la última verificación comercial", () => {
    expect(PRICING_VERIFICADO_EN).toBe("2026-07-30");
  });
});
