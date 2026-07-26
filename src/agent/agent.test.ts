import { describe, expect, it } from "vitest";

import type {
  ProveedorLLM,
  RespuestaLLM,
  SolicitudLLM,
} from "../llm/port.js";
import {
  decidirRespuesta,
  interpretar,
  type Turno,
} from "./agent.js";
import type { ContextoProspecto } from "./prompt.js";

const prospecto: ContextoProspecto = {
  nombre: "Clínica Ejemplo",
  distrito: "Miraflores",
  clasificacion: "Clínica",
  tieneWeb: false,
  resenas: 42,
};

const respuestaTexto: RespuestaLLM = {
  corte: "fin",
  texto: "Respuesta del agente",
  herramienta: null,
};

function proveedorCapturador(respuesta: RespuestaLLM = respuestaTexto): {
  proveedor: ProveedorLLM;
  solicitud: () => SolicitudLLM;
} {
  let capturada: SolicitudLLM | undefined;

  return {
    proveedor: {
      nombre: "fake",
      async generar(solicitud) {
        capturada = solicitud;
        return respuesta;
      },
    },
    solicitud() {
      if (capturada === undefined) {
        throw new Error("El proveedor todavía no recibió una solicitud");
      }
      return capturada;
    },
  };
}

describe("interpretar", () => {
  it("escala un rechazo sin lanzar", () => {
    expect(
      interpretar({
        corte: "rechazo",
        texto: "",
        herramienta: null,
      }),
    ).toEqual({
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
      resumen:
        "El proveedor rechazó generar una respuesta. Requiere revisión manual.",
    });
  });

  it("incluye el motivo del rechazo en el resumen", () => {
    const decision = interpretar({
      corte: "rechazo",
      texto: "",
      herramienta: null,
      motivo: "clasificador de seguridad",
    });

    expect(decision).toMatchObject({
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
    });
    expect(decision.kind === "escalar" && decision.resumen).toContain(
      "clasificador de seguridad",
    );
  });

  it("corte error escala en vez de responder", () => {
    const decision = interpretar({
      corte: "error",
      texto: "",
      herramienta: null,
      motivo: "timeout del proveedor",
    });

    expect(decision).toMatchObject({
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
    });
    expect(decision.kind === "escalar" && decision.resumen).toContain(
      "timeout del proveedor",
    );
  });

  it("traduce escalar_a_humano conservando motivo y resumen", () => {
    expect(
      interpretar({
        corte: "fin",
        texto: "",
        herramienta: {
          nombre: "escalar_a_humano",
          input: {
            motivo: "pide_reunion",
            resumen: "Quiere coordinar una llamada para revisar el plan Empresa.",
          },
        },
      }),
    ).toEqual({
      kind: "escalar",
      motivo: "pide_reunion",
      resumen: "Quiere coordinar una llamada para revisar el plan Empresa.",
    });
  });

  it("traduce marcar_perdido conservando el motivo", () => {
    expect(
      interpretar({
        corte: "fin",
        texto: "",
        herramienta: {
          nombre: "marcar_perdido",
          input: { motivo: "ya_tiene_proveedor" },
        },
      }),
    ).toEqual({ kind: "perdido", motivo: "ya_tiene_proveedor" });
  });

  it("usa defaults si el input de las herramientas está incompleto", () => {
    expect(
      interpretar({
        corte: "fin",
        texto: "",
        herramienta: {
          nombre: "escalar_a_humano",
          input: {},
        },
      }),
    ).toEqual({
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
      resumen: "",
    });

    expect(
      interpretar({
        corte: "fin",
        texto: "",
        herramienta: {
          nombre: "marcar_perdido",
          input: {},
        },
      }),
    ).toEqual({ kind: "perdido", motivo: "otro" });
  });

  it("recorta los extremos del texto", () => {
    expect(
      interpretar({
        corte: "fin",
        texto: "  Respuesta válida.  ",
        herramienta: null,
      }),
    ).toEqual({
      kind: "responder",
      texto: "Respuesta válida.",
    });
  });

  it("escala si el contenido de texto está en blanco", () => {
    expect(
      interpretar({
        corte: "fin",
        texto: " \n\t ",
        herramienta: null,
      }),
    ).toMatchObject({
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
    });
  });

  it("ignora una herramienta desconocida cuando también hay texto", () => {
    expect(
      interpretar({
        corte: "fin",
        texto: "Respuesta válida",
        herramienta: {
          nombre: "herramienta_desconocida",
          input: { dato: "irrelevante" },
        },
      }),
    ).toEqual({ kind: "responder", texto: "Respuesta válida" });
  });
});

describe("decidirRespuesta", () => {
  it("lanza si el historial está vacío", async () => {
    const { proveedor } = proveedorCapturador();

    await expect(decidirRespuesta(proveedor, prospecto, [])).rejects.toThrow(
      "el último turno sea del prospecto",
    );
  });

  it('lanza si el último turno es de "nosotros"', async () => {
    const { proveedor } = proveedorCapturador();

    await expect(
      decidirRespuesta(proveedor, prospecto, [
        { rol: "prospecto", texto: "Hola" },
        { rol: "nosotros", texto: "¿Cómo podemos ayudarle?" },
      ]),
    ).rejects.toThrow("el último turno sea del prospecto");
  });

  it("envía una solicitud neutral al proveedor", async () => {
    const captura = proveedorCapturador();

    await decidirRespuesta(captura.proveedor, prospecto, [
      { rol: "prospecto", texto: "Cuénteme más" },
    ]);

    expect(captura.solicitud()).toEqual(
      expect.objectContaining({
        sistema: expect.any(String),
        mensajes: expect.any(Array),
        herramientas: expect.any(Array),
        maxTokens: 8000,
        esfuerzo: "high",
      }),
    );
    expect(captura.solicitud()).not.toHaveProperty("model");
    expect(captura.solicitud()).not.toHaveProperty("max_tokens");
    expect(captura.solicitud()).not.toHaveProperty("output_config");
  });

  it("antepone el contexto del prospecto como mensaje user", async () => {
    const captura = proveedorCapturador();

    await decidirRespuesta(captura.proveedor, prospecto, [
      { rol: "prospecto", texto: "Hola" },
    ]);

    expect(captura.solicitud().mensajes[0]).toMatchObject({ rol: "user" });
    expect(captura.solicitud().mensajes[0]?.texto).toContain(
      "<contexto_prospecto>",
    );
  });

  it("mapea el historial a roles neutrales y conserva el orden", async () => {
    const captura = proveedorCapturador();
    const historial: Turno[] = [
      { rol: "prospecto", texto: "Primer mensaje" },
      { rol: "nosotros", texto: "Nuestra respuesta" },
      { rol: "prospecto", texto: "Último mensaje" },
    ];

    await decidirRespuesta(captura.proveedor, prospecto, historial);

    expect(captura.solicitud().mensajes.slice(1)).toEqual([
      { rol: "user", texto: "Primer mensaje" },
      { rol: "assistant", texto: "Nuestra respuesta" },
      { rol: "user", texto: "Último mensaje" },
    ]);
  });

  it("usa effort high por default y respeta el override", async () => {
    const defaultCapture = proveedorCapturador();
    await decidirRespuesta(defaultCapture.proveedor, prospecto, [
      { rol: "prospecto", texto: "Hola" },
    ]);
    expect(defaultCapture.solicitud().esfuerzo).toBe("high");

    const overrideCapture = proveedorCapturador();
    await decidirRespuesta(
      overrideCapture.proveedor,
      prospecto,
      [{ rol: "prospecto", texto: "Hola" }],
      { effort: "medium" },
    );
    expect(overrideCapture.solicitud().esfuerzo).toBe("medium");
  });

  it("usa maxTokens 8000 por default y respeta el override", async () => {
    const defaultCapture = proveedorCapturador();
    await decidirRespuesta(defaultCapture.proveedor, prospecto, [
      { rol: "prospecto", texto: "Hola" },
    ]);
    expect(defaultCapture.solicitud().maxTokens).toBe(8000);

    const overrideCapture = proveedorCapturador();
    await decidirRespuesta(
      overrideCapture.proveedor,
      prospecto,
      [{ rol: "prospecto", texto: "Hola" }],
      { maxTokens: 1234 },
    );
    expect(overrideCapture.solicitud().maxTokens).toBe(1234);
  });

  it("declara solo las dos herramientas con esquemas estrictos", async () => {
    const captura = proveedorCapturador();

    await decidirRespuesta(captura.proveedor, prospecto, [
      { rol: "prospecto", texto: "Hola" },
    ]);

    const herramientas = captura.solicitud().herramientas;
    expect(herramientas).toHaveLength(2);
    expect(herramientas?.map((herramienta) => herramienta.nombre)).toEqual([
      "escalar_a_humano",
      "marcar_perdido",
    ]);
    for (const herramienta of herramientas ?? []) {
      expect(herramienta.descripcion).not.toBe("");
      expect(herramienta.esquema).toMatchObject({
        required: expect.any(Array),
        additionalProperties: false,
      });
    }
  });
});

describe("interpretar — regresiones del review", () => {
  it("no envía texto truncado por límite de tokens", () => {
    const fragmento = "Claro, el plan Empresa + incluye aten";
    const decision = interpretar({
      corte: "truncado",
      texto: fragmento,
      herramienta: null,
    });

    expect(decision.kind).toBe("escalar");
    if (decision.kind !== "escalar") throw new Error("esperaba escalar");
    expect(decision.resumen).toContain("truncó");
    expect(decision.resumen).not.toContain(fragmento);
  });

  it("el escalamiento gana al texto cuando viene la herramienta", () => {
    const decision = interpretar({
      corte: "fin",
      texto: "Texto que no debe enviarse",
      herramienta: {
        nombre: "escalar_a_humano",
        input: {
          motivo: "pide_humano",
          resumen: "Quiere hablar con Hideki.",
        },
      },
    });

    expect(decision).toEqual({
      kind: "escalar",
      motivo: "pide_humano",
      resumen: "Quiere hablar con Hideki.",
    });
  });
});
