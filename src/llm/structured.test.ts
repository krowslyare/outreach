import { describe, expect, it } from "vitest";

import type { HerramientaLLM } from "./port.js";
import {
  esquemaConHerramientas,
  interpretarEstructurado,
} from "./structured.js";

const HERRAMIENTAS: readonly HerramientaLLM[] = [
  {
    nombre: "escalar_a_humano",
    descripcion: "Pasa la conversación a Hideki.",
    esquema: {
      type: "object",
      properties: { motivo: { type: "string" }, resumen: { type: "string" } },
      required: ["motivo", "resumen"],
      additionalProperties: false,
    },
  },
];

/**
 * Recorre el esquema y devuelve los incumplimientos del modo estricto de
 * OpenAI: todo objeto debe declarar `additionalProperties: false` y listar
 * TODAS sus propiedades en `required`.
 */
function incumplimientosDelModoEstricto(
  nodo: unknown,
  ruta = "raíz",
): string[] {
  if (typeof nodo !== "object" || nodo === null) return [];
  const objeto = nodo as Record<string, unknown>;
  const fallos: string[] = [];

  if (objeto.type === "object") {
    if (objeto.additionalProperties !== false) {
      fallos.push(`${ruta}: falta additionalProperties: false`);
    }
    const propiedades = Object.keys(
      (objeto.properties as Record<string, unknown> | undefined) ?? {},
    );
    const requeridas = new Set(
      Array.isArray(objeto.required) ? (objeto.required as string[]) : [],
    );
    for (const propiedad of propiedades) {
      if (!requeridas.has(propiedad)) {
        fallos.push(`${ruta}: "${propiedad}" no está en required`);
      }
    }
  }

  for (const [clave, valor] of Object.entries(objeto)) {
    fallos.push(...incumplimientosDelModoEstricto(valor, `${ruta}.${clave}`));
  }
  return fallos;
}

describe("esquemaConHerramientas", () => {
  // El fallo que motivó este test: `input` iba como `{type:"object"}` libre.
  // OpenAI responde 400 a la petición ENTERA, así que el agente escalaba cada
  // conversación con un error de esquema en vez de contestar.
  it("cumple el modo estricto de OpenAI", () => {
    expect(incumplimientosDelModoEstricto(esquemaConHerramientas(HERRAMIENTAS)))
      .toEqual([]);
  });

  it("declara input como string, no como objeto de forma libre", () => {
    const esquema = esquemaConHerramientas(HERRAMIENTAS) as {
      properties: { input: { type: string } };
    };
    expect(esquema.properties.input.type).toBe("string");
  });

  it("ofrece texto y el nombre de cada herramienta como acciones", () => {
    const esquema = esquemaConHerramientas(HERRAMIENTAS) as {
      properties: { accion: { enum: string[] } };
    };
    expect(esquema.properties.accion.enum).toEqual([
      "texto",
      "escalar_a_humano",
    ]);
  });
});

describe("interpretarEstructurado con input serializado", () => {
  it("parsea el input que viene como string", () => {
    const respuesta = interpretarEstructurado(
      {
        accion: "escalar_a_humano",
        texto: "",
        input: '{"motivo":"quiere_contratar","resumen":"Pide llamada"}',
      },
      HERRAMIENTAS,
    );
    expect(respuesta?.herramienta).toEqual({
      nombre: "escalar_a_humano",
      input: { motivo: "quiere_contratar", resumen: "Pide llamada" },
    });
  });

  // Estricto al pedir, tolerante al leer: son cuatro proveedores y no todos
  // honran el esquema igual.
  it("acepta el input que viene ya como objeto", () => {
    const respuesta = interpretarEstructurado(
      {
        accion: "escalar_a_humano",
        texto: "",
        input: { motivo: "pide_reunion", resumen: "Quiere reunión" },
      },
      HERRAMIENTAS,
    );
    expect(respuesta?.herramienta?.input).toEqual({
      motivo: "pide_reunion",
      resumen: "Quiere reunión",
    });
  });

  it("tolera comillas de código alrededor del input", () => {
    const respuesta = interpretarEstructurado(
      {
        accion: "escalar_a_humano",
        texto: "",
        input: '```json\n{"motivo":"queja"}\n```',
      },
      HERRAMIENTAS,
    );
    expect(respuesta?.herramienta?.input).toEqual({ motivo: "queja" });
  });

  // Perder el resumen de un escalamiento es mucho mejor que perder el
  // escalamiento: el prospecto caliente igual llega a Hideki.
  it("un input ilegible no tumba el escalamiento", () => {
    for (const input of ["no soy json", "", "[1,2,3]", null, 42]) {
      const respuesta = interpretarEstructurado(
        { accion: "escalar_a_humano", texto: "", input },
        HERRAMIENTAS,
      );
      expect(respuesta?.herramienta).toEqual({
        nombre: "escalar_a_humano",
        input: {},
      });
    }
  });

  it("una acción que no es herramienta conocida se rechaza", () => {
    expect(
      interpretarEstructurado(
        { accion: "borrar_todo", texto: "", input: "{}" },
        HERRAMIENTAS,
      ),
    ).toBeNull();
  });
});
