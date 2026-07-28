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

/**
 * Esquema de salida cuando hay herramientas.
 *
 * `input` va como STRING con el JSON adentro, no como objeto. No es una
 * preferencia estética: el modo estricto de OpenAI exige `additionalProperties:
 * false` en todo objeto del esquema y que TODAS las propiedades estén en
 * `required`, así que un objeto de forma libre —que es lo que necesita el input
 * de una herramienta, distinto para cada una— no se puede expresar. Declararlo
 * como `{type:"object"}` hace que la API rechace la petición entera con un 400,
 * y el agente termina escalando cada conversación por un error de esquema.
 *
 * Por eso también `texto` e `input` están en `required` aunque uno de los dos
 * sobre según el caso: el modelo manda cadena vacía en el que no aplica.
 */
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
      texto: {
        type: "string",
        description:
          'El mensaje a enviar cuando accion es "texto". Cadena vacía si usas una herramienta.',
      },
      input: {
        type: "string",
        description:
          "El input de la herramienta como JSON serializado en una cadena, " +
          'por ejemplo {"motivo":"quiere_contratar","resumen":"..."}. ' +
          'Cadena vacía si accion es "texto".',
      },
    },
    required: ["accion", "texto", "input"],
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
      input: normalizarInput(valor.input),
    },
  };
}

/**
 * El input de la herramienta, venga como string con JSON o ya como objeto.
 *
 * El esquema pide string, pero se aceptan las dos formas a propósito: son
 * cuatro proveedores y no todos honran el esquema igual. Estricto al pedir,
 * tolerante al leer. Un input ilegible devuelve `{}` en vez de tumbar la
 * respuesta: el agente ya valida los campos que le importan, y perder el
 * resumen de un escalamiento es mucho mejor que perder el escalamiento.
 */
function normalizarInput(valor: unknown): Record<string, unknown> {
  if (esRegistro(valor)) return valor;
  if (typeof valor !== "string" || valor.trim() === "") return {};
  try {
    const parseado = parsearJsonTolerante(valor);
    return esRegistro(parseado) ? parseado : {};
  } catch {
    return {};
  }
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
