import { describe, expect, it } from "vitest";

import { normalizarNombre, rubroNatural } from "./normalizar.js";

describe("normalizarNombre", () => {
  it("convierte el nombre del padrón en una marca legible", () => {
    expect(normalizarNombre("RICARDO ODRIA & ASOCIADOS S.A.")).toBe(
      "Ricardo Odria & Asociados",
    );
  });

  it("preserva acentos, conectores y siglas conocidas que no son sufijo", () => {
    expect(normalizarNombre("CLÍNICA DE LA MUJER SAC NORTE")).toBe(
      "Clínica de la Mujer SAC Norte",
    );
    expect(normalizarNombre("CENTRO MÉDICO DEL NIÑO E.I.R.L.")).toBe(
      "Centro Médico del Niño",
    );
  });
});

describe("rubroNatural", () => {
  it.each([
    [
      "CONSULTORIOS MEDICOS Y DE OTROS PROFESIONALES DE LA SALUD",
      "consultorio",
    ],
    ["CENTRO ODONTOLOGICO", "centro odontológico"],
    ["POLICLINICOS", "policlínico"],
    ["PATOLOGIA CLINICA", "laboratorio"],
    ["DIAGNOSTICO POR IMAGENES", "centro de diagnóstico por imágenes"],
    ["CENTROS DE SALUD O CENTROS MEDICOS", "centro médico"],
    ["CLÍNICAS VETERINARIAS", "clínica veterinaria"],
    ["CENTROS DE ESTÉTICA Y DERMATOLOGÍA", "centro estético"],
    ["COLEGIOS PRIVADOS, NIDOS Y ACADEMIAS", "institución educativa"],
    ["ESTUDIOS JURÍDICOS Y CONTABLES", "estudio profesional"],
    ["HOSPEDAJES Y OPERADORES TURÍSTICOS", "negocio turístico"],
  ])("traduce %s", (clasificacion, esperado) => {
    expect(rubroNatural(clasificacion)).toBe(esperado);
  });

  it("usa un genérico seguro para una categoría desconocida", () => {
    expect(rubroNatural("CATEGORIA NUEVA DEL PADRON")).toBe("consultorio");
  });
});
