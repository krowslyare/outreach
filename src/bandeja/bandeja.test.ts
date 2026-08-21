import { describe, expect, it } from "vitest";

import type { FilaColaAtencion } from "../wa/store.js";
import {
  accionParaMotivo,
  esperaHumana,
  linkChat,
  ordenarCola,
  resumir,
  unaLinea,
} from "./bandeja.js";

function fila(
  e164: string,
  desde: Date,
  motivo: FilaColaAtencion["motivo"] = "deuda",
): FilaColaAtencion {
  return {
    e164,
    nombre: `Nombre ${e164}`,
    motivo,
    desde,
    ultimoEntrante: "hola",
    sinResolver: 1,
  };
}

describe("esperaHumana", () => {
  const ahora = new Date("2026-08-21T15:00:00.000Z");

  it("usa la unidad más chica que hace falta, nunca negativos", () => {
    const segundos = (n: number) => new Date(ahora.getTime() - n * 1000);
    expect(esperaHumana(segundos(30), ahora)).toBe("menos de un minuto");
    expect(esperaHumana(segundos(5 * 60), ahora)).toBe("5 min");
    expect(esperaHumana(segundos(3 * 3600), ahora)).toBe("3 h");
    expect(esperaHumana(segundos(3 * 3600 + 5 * 60), ahora)).toBe("3 h 05 min");
    expect(esperaHumana(segundos(2 * 86_400), ahora)).toBe("2 d");
    expect(esperaHumana(segundos(2 * 86_400 + 4 * 3600), ahora)).toBe("2 d 4 h");
    // Reloj adelantado o mensaje con fecha futura: ruido, no un número raro.
    expect(esperaHumana(new Date(ahora.getTime() + 60_000), ahora)).toBe(
      "menos de un minuto",
    );
  });
});

describe("unaLinea", () => {
  it("colapsa saltos de línea y recorta con elipsis", () => {
    expect(unaLinea("hola\n¿cómo\r\nestás?")).toBe("hola ¿cómo estás?");
    expect(unaLinea("x".repeat(80)).length).toBe(72);
    expect(unaLinea("x".repeat(80))).toMatch(/…$/);
    expect(unaLinea("  corto  ")).toBe("corto");
  });
});

describe("linkChat", () => {
  it("arma el link de wa.me sin el signo", () => {
    expect(linkChat("+51999111222")).toBe("https://wa.me/51999111222");
  });
});

describe("ordenarCola", () => {
  it("deja lo más viejo primero y no muta la entrada", () => {
    const viejo = new Date("2026-08-20T10:00:00.000Z");
    const nuevo = new Date("2026-08-21T10:00:00.000Z");
    const original = [fila("+51999222333", nuevo), fila("+51999111222", viejo)];

    const ordenada = ordenarCola(original);

    expect(ordenada.map((f) => f.e164)).toEqual([
      "+51999111222",
      "+51999222333",
    ]);
    expect(original[0]!.e164).toBe("+51999222333");
  });

  it("empata por número para que el orden sea estable", () => {
    const mismoMomento = new Date("2026-08-21T10:00:00.000Z");
    const ordenada = ordenarCola([
      fila("+51999222333", mismoMomento),
      fila("+51999111222", mismoMomento),
    ]);
    expect(ordenada.map((f) => f.e164)[0]).toBe("+51999111222");
  });
});

describe("resumir", () => {
  it("cuenta por motivo y devuelve ceros cuando no hay nada", () => {
    const momento = new Date("2026-08-21T10:00:00.000Z");
    expect(resumir([])).toEqual({
      total: 0,
      porMotivo: { escalado: 0, deuda: 0, ajeno: 0 },
    });
    const resumen = resumir([
      fila("+51999111222", momento, "escalado"),
      fila("+51999222333", momento, "deuda"),
      fila("+51999333444", momento, "deuda"),
      fila("+51999444555", momento, "ajeno"),
    ]);
    expect(resumen).toEqual({
      total: 4,
      porMotivo: { escalado: 1, deuda: 2, ajeno: 1 },
    });
  });
});

describe("accionParaMotivo", () => {
  it("dice qué hacer con cada fila, sin excepciones", () => {
    for (const motivo of ["escalado", "deuda", "ajeno"] as const) {
      expect(accionParaMotivo(motivo).length).toBeGreaterThan(0);
    }
  });
});
