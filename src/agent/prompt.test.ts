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

  it("no asume una apertura única ni confunde Presencia con un negocio nuevo", () => {
    expect(SYSTEM_PROMPT).toContain("No asumas que siempre fue la misma apertura");
    expect(SYSTEM_PROMPT).toContain("no significa que el consultorio sea nuevo");
  });

  it("no describe un catálogo de tres planes cuando hay cuatro", () => {
    expect(PLANES).toHaveLength(4);
    expect(SYSTEM_PROMPT).not.toContain("los tres planes");
    expect(SYSTEM_PROMPT).not.toContain("con los tres planes");
  });

  it("posiciona web y Portal juntos antes de recomendar un plan", () => {
    expect(SYSTEM_PROMPT).toContain(
      "La web abre la conversación; el Portal diferencia la propuesta",
    );
    expect(SYSTEM_PROMPT).toContain(
      "Que el registro público diga que no tiene web NO significa que le calce Presencia",
    );
    expect(SYSTEM_PROMPT).toContain(
      "no eliges plan",
    );
    expect(SYSTEM_PROMPT).toContain(
      'Usa el nombre completo "Libro de Reclamaciones"',
    );
    expect(SYSTEM_PROMPT).toContain(
      'NO digas "reúne contactos", "captación de contactos", "medición", "analytics" ni "oportunidades"',
    );
    expect(SYSTEM_PROMPT).toContain(
      'Di "ver las consultas que llegan"',
    );
  });

  it("distingue las señales de Presencia, Empresa y Empresa +", () => {
    expect(SYSTEM_PROMPT).toContain(
      "Solo quiere tener la web profesional hecha y administrada: Presencia",
    );
    expect(SYSTEM_PROMPT).toContain(
      "captar contactos reales, medir resultados o dar acceso a su equipo: Empresa",
    );
    expect(SYSTEM_PROMPT).toContain(
      "Libro de Reclamaciones con seguimiento, más cambios o atención prioritaria: Empresa +",
    );
  });

  it("trata promociones, catálogo y reservas como módulos activables", () => {
    expect(SYSTEM_PROMPT).toContain(
      "Los módulos de promociones, catálogo y reservas son activables",
    );
    expect(SYSTEM_PROMPT).toContain(
      "nunca se presentan como incluidos por defecto",
    );
  });

  it("permite responder una duda concreta antes de ejecutar el handoff", () => {
    expect(SYSTEM_PROMPT).toContain(
      "usa el campo respuesta_concreta de escalar_a_humano",
    );
    expect(SYSTEM_PROMPT).toContain(
      "La opción que reúne todo eso es Empresa + — S/ 649 mensual.",
    );
    expect(SYSTEM_PROMPT).toContain(
      "No dices que es caro ni barato",
    );
    expect(SYSTEM_PROMPT).toContain(
      'Preguntar "¿cuánto cuesta?" o "¿es caro?" NO es negociar',
    );
  });
});
