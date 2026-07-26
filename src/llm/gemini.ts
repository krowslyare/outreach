import type {
  ProveedorLLM,
  RespuestaLLM,
  SolicitudLLM,
} from "./port.js";
import { esRegistro } from "./structured.js";
import { motivoError } from "./subprocess.js";

const MODELO_DEFAULT = "gemini-2.5-flash";
const BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiOpts {
  apiKey?: string;
  modelo?: string;
  /** Fetch inyectable para que los tests nunca salgan a la red. */
  fetch?: typeof fetch;
}

export function proveedorGemini(opts: GeminiOpts = {}): ProveedorLLM {
  const hacerFetch = opts.fetch ?? fetch;
  const modelo = opts.modelo ?? MODELO_DEFAULT;

  return {
    nombre: "gemini",
    async generar(solicitud) {
      const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) {
        return error("Falta GEMINI_API_KEY");
      }

      try {
        const respuesta = await hacerFetch(
          `${BASE_URL}/${encodeURIComponent(modelo)}:generateContent`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(parametrosGemini(solicitud)),
          },
        );

        if (!respuesta.ok) {
          const detalle = (await respuesta.text()).trim();
          return error(
            `Gemini respondió HTTP ${respuesta.status}${detalle.length === 0 ? "" : `: ${detalle}`}`,
          );
        }

        return traducirRespuesta(await respuesta.json());
      } catch (causa) {
        return error(`Gemini falló: ${motivoError(causa)}`);
      }
    },
  };
}

function parametrosGemini(solicitud: SolicitudLLM): Record<string, unknown> {
  return {
    systemInstruction: {
      parts: [{ text: solicitud.sistema }],
    },
    contents: solicitud.mensajes.map((mensaje) => ({
      role: mensaje.rol === "assistant" ? "model" : "user",
      parts: [{ text: mensaje.texto }],
    })),
    ...(solicitud.herramientas !== undefined &&
    solicitud.herramientas.length > 0
      ? {
          tools: [
            {
              functionDeclarations: solicitud.herramientas.map(
                (herramienta) => ({
                  name: herramienta.nombre,
                  description: herramienta.descripcion,
                  parameters: herramienta.esquema,
                }),
              ),
            },
          ],
        }
      : {}),
    generationConfig: {
      maxOutputTokens: solicitud.maxTokens,
    },
  };
}

function traducirRespuesta(valor: unknown): RespuestaLLM {
  if (!esRegistro(valor) || !Array.isArray(valor.candidates)) {
    return error("Gemini devolvió una respuesta inválida");
  }
  const candidato = valor.candidates[0];
  if (!esRegistro(candidato)) {
    return error("Gemini no devolvió candidatos");
  }

  const finishReason =
    typeof candidato.finishReason === "string"
      ? candidato.finishReason
      : undefined;
  const partes =
    esRegistro(candidato.content) && Array.isArray(candidato.content.parts)
      ? candidato.content.parts
      : [];
  const textos: string[] = [];
  let herramienta: RespuestaLLM["herramienta"] = null;

  for (const parte of partes) {
    if (!esRegistro(parte)) continue;
    if (typeof parte.text === "string") textos.push(parte.text);
    if (herramienta === null && esRegistro(parte.functionCall)) {
      const llamada = parte.functionCall;
      if (typeof llamada.name === "string") {
        herramienta = {
          nombre: llamada.name,
          input: esRegistro(llamada.args) ? llamada.args : {},
        };
      }
    }
  }

  if (
    finishReason === "SAFETY" ||
    finishReason === "PROHIBITED_CONTENT"
  ) {
    return {
      corte: "rechazo",
      texto: textos.join("").trim(),
      herramienta,
      motivo: `Gemini rechazó la solicitud (${finishReason})`,
    };
  }

  return {
    corte: finishReason === "MAX_TOKENS" ? "truncado" : "fin",
    texto: textos.join("").trim(),
    herramienta,
  };
}

function error(motivo: string): RespuestaLLM {
  return { corte: "error", texto: "", herramienta: null, motivo };
}
