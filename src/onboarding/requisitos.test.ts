import { describe, expect, it } from "vitest";

import type { RequisitoCliente } from "../onboarding/requisitos.js";
import {
  barraProgreso,
  esEstadoCliente,
  mensajeKickoff,
  normalizarPlan,
  plantillaRequisitos,
  progreso,
} from "./requisitos.js";

function requisito(clave: string, resuelto: boolean): RequisitoCliente {
  return {
    clave,
    etiqueta: `etiqueta de ${clave}`,
    resuelto,
    resueltoEn: resuelto ? new Date("2026-08-21T12:00:00.000Z") : null,
  };
}

describe("normalizarPlan", () => {
  it("acepta clave o nombre público, con cualquier formato", () => {
    expect(normalizarPlan("presencia")).toBe("presencia");
    expect(normalizarPlan("Empresa +")).toBe("empresa_plus");
    expect(normalizarPlan("empresa+")).toBe("empresa_plus");
    expect(normalizarPlan("EMPRESA_PLUS")).toBe("empresa_plus");
    expect(normalizarPlan(" Sistemas ")).toBe("sistemas");
  });

  it("devuelve null en vez de adivinar un plan que no existe", () => {
    expect(normalizarPlan("premium")).toBeNull();
    expect(normalizarPlan("")).toBeNull();
  });
});

describe("plantillaRequisitos", () => {
  it("siempre incluye la base común, sin claves repetidas", () => {
    for (const plan of ["presencia", "empresa", "empresa_plus", "sistemas"] as const) {
      const plantilla = plantillaRequisitos(plan);
      const claves = plantilla.map((r) => r.clave);
      expect(new Set(claves).size).toBe(claves.length);
      expect(claves).toContain("servicios");
      expect(claves).toContain("dominio");
    }
  });

  it("agrega solo el extra que el plan realmente necesita", () => {
    expect(plantillaRequisitos("presencia")).toHaveLength(7);
    expect(plantillaRequisitos("empresa").map((r) => r.clave)).toContain(
      "destino_consultas",
    );
    expect(plantillaRequisitos("empresa_plus").map((r) => r.clave)).toContain(
      "libro_reclamos",
    );
    expect(plantillaRequisitos("sistemas").map((r) => r.clave)).toContain(
      "flujos",
    );
  });
});

describe("progreso", () => {
  it("cuenta lo listo y lista lo que falta, en orden", () => {
    const progresoActual = progreso([
      requisito("servicios", true),
      requisito("fotos", false),
      requisito("logo", false),
    ]);
    expect(progresoActual.listos).toBe(1);
    expect(progresoActual.total).toBe(3);
    expect(progresoActual.faltantes.map((r) => r.clave)).toEqual([
      "fotos",
      "logo",
    ]);
  });
});

describe("barraProgreso", () => {
  it("es legible en un terminal de 80 columnas", () => {
    expect(barraProgreso(0, 8)).toBe("[----] 0/8");
    expect(barraProgreso(4, 8)).toBe("[##--] 4/8");
    expect(barraProgreso(8, 8)).toBe("[####] 8/8");
  });
});

describe("mensajeKickoff", () => {
  it("pide solo lo que falta, numerado y sin prometer plazos", () => {
    const mensaje = mensajeKickoff("Clínica Sonrisa", [
      requisito("servicios", false),
      requisito("fotos", false),
      requisito("logo", true),
    ]);
    expect(mensaje).toContain("Hola Clínica Sonrisa");
    expect(mensaje).toContain("1. etiqueta de servicios");
    expect(mensaje).toContain("2. etiqueta de fotos");
    expect(mensaje).not.toContain("logo");
    // Regla dura del proyecto: nada de plazos inventados.
    expect(mensaje.toLowerCase()).not.toMatch(/d[ií]as|semanas|plazo/);
  });

  it("con todo completo, el mensaje cambia de tarea", () => {
    const mensaje = mensajeKickoff(
      "Clínica Sonrisa",
      plantillaRequisitos("presencia").map((r) => requisito(r.clave, true)),
    );
    expect(mensaje).toContain("Ya tenemos todo");
    expect(mensaje).not.toContain("1.");
  });
});

describe("esEstadoCliente", () => {
  it("valida los cinco estados y nada más", () => {
    for (const estado of ["kickoff", "recoleccion", "construccion", "publicado", "baja"]) {
      expect(esEstadoCliente(estado)).toBe(true);
    }
    expect(esEstadoCliente("cancelado")).toBe(false);
  });
});
