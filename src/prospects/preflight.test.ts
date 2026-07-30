import { describe, expect, it } from "vitest";

import { alertasDeIdentidad } from "./preflight.js";

describe("preflight de identidad comercial", () => {
  it("alerta el caso Gozzing Surco contra Oro Dental Piura", () => {
    expect(
      alertasDeIdentidad(
        { name: "CENTRO ODONTOLÓGICO GOZZING", district: "SANTIAGO DE SURCO" },
        {
          description: "Más de 15 años diseñando hermosas sonrisas",
          category: "Health/beauty",
          address: "Callao 666, Piura 20001, Perú",
          websites: ["https://facebook.com/orodentalpiura/"],
        },
      ),
    ).toEqual([
      "el perfil no contiene ninguna parte específica del nombre esperado",
      "la dirección del perfil no contiene el distrito esperado (SANTIAGO DE SURCO)",
    ]);
  });

  it("no alerta cuando nombre y distrito sí coinciden", () => {
    expect(
      alertasDeIdentidad(
        { name: "Veterinaria Patitas", district: "SURCO" },
        {
          description: "Patitas, clínica veterinaria",
          category: "Veterinario",
          address: "Av. Primavera 123, Surco",
          websites: ["https://instagram.com/patitas"],
        },
      ),
    ).toEqual([]);
  });

  it("una dirección vacía no inventa una contradicción", () => {
    expect(
      alertasDeIdentidad(
        { name: "Odontop", district: "SURCO" },
        {
          description: "Odontop",
          category: "Dentista",
          address: null,
          websites: [],
        },
      ),
    ).toEqual([]);
  });
});
