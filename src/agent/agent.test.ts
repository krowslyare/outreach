import { describe, expect, it } from "vitest";

import {
  decidirRespuesta,
  interpretar,
  type ClienteClaude,
  type RespuestaClaude,
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

const respuestaTexto: RespuestaClaude = {
  stop_reason: "end_turn",
  content: [{ type: "text", text: "Respuesta del agente" }],
};

function clienteCapturador(respuesta: RespuestaClaude = respuestaTexto): {
  cliente: ClienteClaude;
  params: () => Record<string, unknown>;
} {
  let capturados: Record<string, unknown> | undefined;

  return {
    cliente: {
      async crear(params) {
        capturados = params;
        return respuesta;
      },
    },
    params() {
      if (capturados === undefined) {
        throw new Error("El cliente todavía no recibió parámetros");
      }
      return capturados;
    },
  };
}

describe("interpretar", () => {
  it("escala un refusal con content vacío sin lanzar", () => {
    expect(
      interpretar({
        stop_reason: "refusal",
        content: [],
      }),
    ).toEqual({
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
      resumen:
        "Los clasificadores de seguridad rechazaron generar una respuesta. Requiere que lo revises a mano.",
    });
  });

  it("incluye la categoría del refusal en el resumen", () => {
    const decision = interpretar({
      stop_reason: "refusal",
      stop_details: { category: "safety" },
      content: [],
    });

    expect(decision).toMatchObject({
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
    });
    expect(decision.kind === "escalar" && decision.resumen).toContain("safety");
  });

  it("traduce escalar_a_humano conservando motivo y resumen", () => {
    expect(
      interpretar({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            name: "escalar_a_humano",
            input: {
              motivo: "pide_reunion",
              resumen: "Quiere coordinar una llamada para revisar el plan Empresa.",
            },
          },
        ],
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
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            name: "marcar_perdido",
            input: { motivo: "ya_tiene_proveedor" },
          },
        ],
      }),
    ).toEqual({ kind: "perdido", motivo: "ya_tiene_proveedor" });
  });

  it("usa defaults si el input de las herramientas está incompleto", () => {
    expect(
      interpretar({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            name: "escalar_a_humano",
            input: {},
          },
        ],
      }),
    ).toEqual({
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
      resumen: "",
    });

    expect(
      interpretar({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            name: "marcar_perdido",
            input: {},
          },
        ],
      }),
    ).toEqual({ kind: "perdido", motivo: "otro" });
  });

  it("concatena los bloques de texto y recorta los extremos", () => {
    expect(
      interpretar({
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "  Primera parte " },
          { type: "text", text: "y segunda parte.  " },
        ],
      }),
    ).toEqual({
      kind: "responder",
      texto: "Primera parte y segunda parte.",
    });
  });

  it("escala si el contenido de texto está en blanco", () => {
    expect(
      interpretar({
        stop_reason: "end_turn",
        content: [{ type: "text", text: " \n\t " }],
      }),
    ).toMatchObject({
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
    });
  });

  it("ignora una herramienta desconocida cuando también hay texto", () => {
    expect(
      interpretar({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            name: "herramienta_desconocida",
            input: { dato: "irrelevante" },
          },
          { type: "text", text: "Respuesta válida" },
        ],
      }),
    ).toEqual({ kind: "responder", texto: "Respuesta válida" });
  });
});

describe("decidirRespuesta", () => {
  it("lanza si el historial está vacío", async () => {
    const { cliente } = clienteCapturador();

    await expect(decidirRespuesta(cliente, prospecto, [])).rejects.toThrow(
      "el último turno sea del prospecto",
    );
  });

  it('lanza si el último turno es de "nosotros"', async () => {
    const { cliente } = clienteCapturador();

    await expect(
      decidirRespuesta(cliente, prospecto, [
        { rol: "prospecto", texto: "Hola" },
        { rol: "nosotros", texto: "¿Cómo podemos ayudarle?" },
      ]),
    ).rejects.toThrow("el último turno sea del prospecto");
  });

  it("no envía parámetros incompatibles con Opus 5", async () => {
    const captura = clienteCapturador();

    await decidirRespuesta(captura.cliente, prospecto, [
      { rol: "prospecto", texto: "Cuénteme más" },
    ]);

    const params = captura.params();
    // Esta lista explícita evita que una futura afinación silenciosa rompa la API con 400.
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
    expect(params).not.toHaveProperty("top_k");
    expect(params).not.toHaveProperty("thinking.budget_tokens");
  });

  it('usa exactamente el modelo "claude-opus-5"', async () => {
    const captura = clienteCapturador();

    await decidirRespuesta(captura.cliente, prospecto, [
      { rol: "prospecto", texto: "Hola" },
    ]);

    expect(captura.params().model).toBe("claude-opus-5");
  });

  it("antepone el contexto del prospecto como mensaje user", async () => {
    const captura = clienteCapturador();

    await decidirRespuesta(captura.cliente, prospecto, [
      { rol: "prospecto", texto: "Hola" },
    ]);

    const messages = captura.params().messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages[0]?.content).toContain("<contexto_prospecto>");
  });

  it("mapea el historial a roles de Claude y conserva el orden", async () => {
    const captura = clienteCapturador();
    const historial: Turno[] = [
      { rol: "prospecto", texto: "Primer mensaje" },
      { rol: "nosotros", texto: "Nuestra respuesta" },
      { rol: "prospecto", texto: "Último mensaje" },
    ];

    await decidirRespuesta(captura.cliente, prospecto, historial);

    const messages = captura.params().messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages.slice(1)).toEqual([
      { role: "user", content: "Primer mensaje" },
      { role: "assistant", content: "Nuestra respuesta" },
      { role: "user", content: "Último mensaje" },
    ]);
  });

  it("marca el último bloque de system como cacheable", async () => {
    const captura = clienteCapturador();

    await decidirRespuesta(captura.cliente, prospecto, [
      { rol: "prospecto", texto: "Hola" },
    ]);

    const system = captura.params().system as Array<Record<string, unknown>>;
    expect(Array.isArray(system)).toBe(true);
    expect(system.at(-1)).toMatchObject({
      cache_control: { type: "ephemeral" },
    });
  });

  it("usa effort high por default y respeta el override", async () => {
    const defaultCapture = clienteCapturador();
    await decidirRespuesta(defaultCapture.cliente, prospecto, [
      { rol: "prospecto", texto: "Hola" },
    ]);
    expect(defaultCapture.params().output_config).toEqual({ effort: "high" });

    const overrideCapture = clienteCapturador();
    await decidirRespuesta(
      overrideCapture.cliente,
      prospecto,
      [{ rol: "prospecto", texto: "Hola" }],
      { effort: "medium" },
    );
    expect(overrideCapture.params().output_config).toEqual({
      effort: "medium",
    });
  });

  it("usa max_tokens 8000 por default y respeta el override", async () => {
    const defaultCapture = clienteCapturador();
    await decidirRespuesta(defaultCapture.cliente, prospecto, [
      { rol: "prospecto", texto: "Hola" },
    ]);
    expect(defaultCapture.params().max_tokens).toBe(8000);

    const overrideCapture = clienteCapturador();
    await decidirRespuesta(
      overrideCapture.cliente,
      prospecto,
      [{ rol: "prospecto", texto: "Hola" }],
      { maxTokens: 1234 },
    );
    expect(overrideCapture.params().max_tokens).toBe(1234);
  });

  it("declara solo las dos herramientas con esquemas estrictos", async () => {
    const captura = clienteCapturador();

    await decidirRespuesta(captura.cliente, prospecto, [
      { rol: "prospecto", texto: "Hola" },
    ]);

    const tools = captura.params().tools as Array<{
      name: string;
      strict: boolean;
      input_schema: { additionalProperties: boolean };
    }>;
    expect(tools).toHaveLength(2);
    expect(tools.map((tool) => tool.name)).toEqual([
      "escalar_a_humano",
      "marcar_perdido",
    ]);
    for (const tool of tools) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false);
    }
  });
});

describe("interpretar — regresiones del review", () => {
  it("no envía texto truncado por límite de tokens", () => {
    // Con pensamiento adaptativo el presupuesto de salida se comparte, así que
    // agotarlo devuelve texto no vacío pero cortado a media frase. Mandarlo se
    // ve peor que no contestar y delata que hay un bot detrás.
    const decision = interpretar({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "Claro, el plan Empresa + incluye aten" }],
    });

    expect(decision.kind).toBe("escalar");
    if (decision.kind !== "escalar") throw new Error("esperaba escalar");
    expect(decision.resumen).toContain("truncó");
  });

  it("el escalamiento gana cuando vienen varias herramientas", () => {
    // "no me interesa, pero quiero hablar con Hideki" puede disparar las dos.
    // Si ganara el orden del contenido, un marcar_perdido descartaría un pedido
    // explícito de hablar con una persona.
    const decision = interpretar({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", name: "marcar_perdido", input: { motivo: "no_interesa" } },
        {
          type: "tool_use",
          name: "escalar_a_humano",
          input: { motivo: "pide_humano", resumen: "Quiere hablar con Hideki." },
        },
      ],
    });

    expect(decision).toEqual({
      kind: "escalar",
      motivo: "pide_humano",
      resumen: "Quiere hablar con Hideki.",
    });
  });

  it("sigue marcando perdido cuando esa es la única herramienta", () => {
    const decision = interpretar({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", name: "marcar_perdido", input: { motivo: "ya_tiene_proveedor" } },
      ],
    });

    expect(decision).toEqual({ kind: "perdido", motivo: "ya_tiene_proveedor" });
  });
});
