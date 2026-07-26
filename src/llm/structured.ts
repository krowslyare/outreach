import type {
  HerramientaLLM,
  RespuestaLLM,
  SolicitudLLM,
} from "./port.js";

export const ESQUEMA_TEXTO = {
  type: "object",
  properties: {
    texto: { type: "string" },
  },
  required: ["texto"],
  additionalProperties: false,
} as const;

export function esquemaConHerramientas(
  herramientas: readonly HerramientaLLM[],
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      accion: {
        type: "string",
        enum: ["texto", ...herramientas.map((herramienta) => herramienta.nombre)],
      },
      texto: { type: "string" },
      input: { type: "object" },
    },
    required: ["accion"],
    additionalProperties: false,
  };
}

export function construirPrompt(
  solicitud: SolicitudLLM,
  esquema: Record<string, unknown>,
): string {
  const conversacion = solicitud.mensajes
    .map(
      (mensaje) =>
        `<mensaje rol="${mensaje.rol}">\n${mensaje.texto}\n</mensaje>`,
    )
    .join("\n\n");

  const herramientas =
    solicitud.herramientas === undefined ||
    solicitud.herramientas.length === 0
      ? "No hay herramientas disponibles. Responde con texto."
      : [
          "Herramientas disponibles:",
          ...solicitud.herramientas.map(
            (herramienta) =>
              `- ${herramienta.nombre}: ${herramienta.descripcion}\n  Input JSON Schema: ${JSON.stringify(herramienta.esquema)}`,
          ),
          'Elige "texto" para responder normalmente o el nombre exacto de una herramienta para invocarla.',
        ].join("\n");

  return [
    "<sistema>",
    solicitud.sistema,
    "</sistema>",
    "",
    "<conversacion>",
    conversacion,
    "</conversacion>",
    "",
    herramientas,
    "",
    "Devuelve ÚNICAMENTE un objeto JSON que cumpla este JSON Schema:",
    JSON.stringify(esquema),
    "No uses Markdown ni cercas de código.",
  ].join("\n");
}

export function interpretarEstructurado(
  valor: unknown,
  herramientas: readonly HerramientaLLM[],
): RespuestaLLM | null {
  if (!esRegistro(valor)) return null;

  if (herramientas.length === 0) {
    if (typeof valor.texto !== "string") return null;
    return {
      corte: "fin",
      texto: valor.texto.trim(),
      herramienta: null,
    };
  }

  if (typeof valor.accion !== "string") return null;
  if (valor.accion === "texto") {
    if (typeof valor.texto !== "string") return null;
    return {
      corte: "fin",
      texto: valor.texto.trim(),
      herramienta: null,
    };
  }

  if (
    !herramientas.some((herramienta) => herramienta.nombre === valor.accion)
  ) {
    return null;
  }

  return {
    corte: "fin",
    texto: typeof valor.texto === "string" ? valor.texto.trim() : "",
    herramienta: {
      nombre: valor.accion,
      input: esRegistro(valor.input) ? valor.input : {},
    },
  };
}

export function parsearJsonTolerante(texto: string): unknown {
  const limpio = texto
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return JSON.parse(limpio) as unknown;
}

export function esRegistro(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}
