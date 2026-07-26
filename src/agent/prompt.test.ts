import { describe, expect, it } from "vitest";

import { PLANES } from "./catalog.js";
import { contextoProspecto, SYSTEM_PROMPT } from "./prompt.js";

function contexto(
  tieneWeb: boolean | null,
  resenas: number | null = null,
): string {
  return contextoProspecto({
    nombre: "Centro Médico Ejemplo",
    distrito: "San Isidro",
    clasificacion: "Centro médico",
    tieneWeb,
    resenas,
  });
}

describe("contextoProspecto", () => {
  it.each([
    [null, "no se pudo verificar"],
    [true, "sí tiene"],
    [false, "no tiene"],
  ] as const)("describe tieneWeb=%s como %s", (tieneWeb, esperado) => {
    expect(contexto(tieneWeb)).toContain(`Página web: ${esperado}`);
  });

  it('describe reseñas null como "sin dato"', () => {
    expect(contexto(false, null)).toContain("Presencia en Google: sin dato");
  });

  it("incluye el número de reseñas cuando existe", () => {
    expect(contexto(false, 37)).toContain(
      "Presencia en Google: 37 reseñas en Google",
    );
  });

  it("abre y cierra el bloque delimitado de contexto", () => {
    const salida = contexto(false, 10);

    expect(salida.startsWith("<contexto_prospecto>")).toBe(true);
    expect(salida).toContain("</contexto_prospecto>");
    expect(salida.indexOf("<contexto_prospecto>")).toBeLessThan(
      salida.indexOf("</contexto_prospecto>"),
    );
  });
});

describe("SYSTEM_PROMPT", () => {
  it("contiene las cuatro etiquetas de precio interpoladas", () => {
    expect(PLANES).toHaveLength(4);
    for (const plan of PLANES) {
      expect(SYSTEM_PROMPT).toContain(plan.precio);
    }
  });

  it("menciona ambas herramientas por nombre", () => {
    expect(SYSTEM_PROMPT).toContain("escalar_a_humano");
    expect(SYSTEM_PROMPT).toContain("marcar_perdido");
  });
});
