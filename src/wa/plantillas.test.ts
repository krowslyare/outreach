import { describe, expect, it } from "vitest";

import {
  cuerpoPlantilla,
  PARAMETROS_POR_PROPOSITO,
  plantillaDesdeEntorno,
} from "./plantillas.js";

describe("plantillaDesdeEntorno", () => {
  const entorno = {
    WHATSAPP_PLANTILLA_FOLLOWUP: "kurogrid_followup",
    WHATSAPP_PLANTILLA_NOTIFICACION: "kurogrid_handoff",
    WHATSAPP_PLANTILLA_NOTIFICACION_IDIOMA: "es_PE",
  } as NodeJS.ProcessEnv;

  it("lee nombre e idioma; el idioma default es es", () => {
    expect(plantillaDesdeEntorno(entorno, "followup")).toEqual({
      nombre: "kurogrid_followup",
      idioma: "es",
      parametros: PARAMETROS_POR_PROPOSITO.followup.length,
    });
    expect(plantillaDesdeEntorno(entorno, "notificacion")?.idioma).toBe("es_PE");
  });

  it("sin configuración devuelve undefined: no hay plantilla inventada", () => {
    expect(plantillaDesdeEntorno({} as NodeJS.ProcessEnv, "followup")).toBeUndefined();
    expect(
      plantillaDesdeEntorno({ WHATSAPP_PLANTILLA_FOLLOWUP: "   " } as NodeJS.ProcessEnv, "followup"),
    ).toBeUndefined();
  });
});

describe("cuerpoPlantilla", () => {
  const plantilla = { nombre: "kurogrid_followup", idioma: "es", parametros: 1 };

  it("arma el payload que espera Graph", () => {
    const armado = cuerpoPlantilla(plantilla, ["retomo mi mensaje de ayer"]);
    if (!armado.ok) throw new Error("el armado válido no debería fallar");
    expect(armado.template).toEqual({
      name: "kurogrid_followup",
      language: { code: "es" },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: "retomo mi mensaje de ayer" }],
        },
      ],
    });
  });

  it("rechaza por conteo o contenido ANTES de tocar la red", () => {
    expect(cuerpoPlantilla(plantilla, []).ok).toBe(false);
    const dos = { ...plantilla, parametros: 2 };
    expect(cuerpoPlantilla(dos, ["uno"]).ok).toBe(false);
    const vacio = cuerpoPlantilla(plantilla, ["   "]);
    expect(vacio.ok).toBe(false);
    if (!vacio.ok) expect(vacio.motivo).toMatch(/parámetro vacío/);
  });
});
