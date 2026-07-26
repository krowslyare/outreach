import Anthropic from "@anthropic-ai/sdk";

import type {
  ProveedorLLM,
  RespuestaLLM,
  SolicitudLLM,
} from "./port.js";
import { esRegistro } from "./structured.js";
import { motivoError } from "./subprocess.js";

const BETA_FALLBACK = "server-side-fallback-2026-07-01";
const MODELO_DEFAULT = "claude-opus-5";

interface ClienteAnthropic {
  beta: {
    messages: {
      create(params: Record<string, unknown>): Promise<unknown>;
    };
  };
}

export interface AnthropicOpts {
  apiKey?: string;
  modelo?: string;
  /** Punto de inyección para probar la traducción sin tocar la red. */
  sdk?: ClienteAnthropic;
}

export function proveedorAnthropic(opts: AnthropicOpts = {}): ProveedorLLM {
  let sdk = opts.sdk;

  return {
    nombre: "anthropic",
    async generar(solicitud) {
      try {
        // Se crea tarde para que seleccionar el proveedor no exija credenciales
        // antes de que exista una llamada real.
        sdk ??= new Anthropic(
          opts.apiKey === undefined ? {} : { apiKey: opts.apiKey },
        ) as unknown as ClienteAnthropic;

        const respuesta = await sdk.beta.messages.create(
          parametrosAnthropic(solicitud, opts.modelo ?? MODELO_DEFAULT),
        );
        return traducirRespuesta(respuesta);
      } catch (error) {
        return respuestaError(`Anthropic falló: ${motivoError(error)}`);
      }
    },
  };
}

function parametrosAnthropic(
  solicitud: SolicitudLLM,
  modelo: string,
): Record<string, unknown> {
  return {
    model: modelo,
    max_tokens: solicitud.maxTokens,
    system: [
      {
        type: "text",
        text: solicitud.sistema,
        // El sistema suele repetirse entre prospectos; marcarlo permite que
        // Anthropic ahorre latencia y costo sin filtrar ese detalle al puerto.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: solicitud.mensajes.map((mensaje) => ({
      role: mensaje.rol,
      content: mensaje.texto,
    })),
    ...(solicitud.herramientas !== undefined &&
    solicitud.herramientas.length > 0
      ? {
          tools: solicitud.herramientas.map((herramienta) => ({
            name: herramienta.nombre,
            description: herramienta.descripcion,
            input_schema: herramienta.esquema,
            strict: true,
          })),
        }
      : {}),
    ...(solicitud.esfuerzo === undefined
      ? {}
      : { output_config: { effort: solicitud.esfuerzo } }),
    betas: [BETA_FALLBACK],
    fallbacks: "default",
  };
}

function traducirRespuesta(valor: unknown): RespuestaLLM {
  if (!esRegistro(valor)) {
    return respuestaError("Anthropic devolvió una respuesta inválida");
  }

  const stopReason =
    typeof valor.stop_reason === "string" ? valor.stop_reason : null;
  const contenido = Array.isArray(valor.content) ? valor.content : [];
  const textos: string[] = [];
  let herramienta: RespuestaLLM["herramienta"] = null;

  for (const bloque of contenido) {
    if (!esRegistro(bloque)) continue;
    if (bloque.type === "text" && typeof bloque.text === "string") {
      textos.push(bloque.text);
    }
    if (
      herramienta === null &&
      bloque.type === "tool_use" &&
      typeof bloque.name === "string"
    ) {
      herramienta = {
        nombre: bloque.name,
        input: esRegistro(bloque.input) ? bloque.input : {},
      };
    }
  }

  if (stopReason === "refusal") {
    const detalles = esRegistro(valor.stop_details)
      ? valor.stop_details.category
      : undefined;
    return {
      corte: "rechazo",
      texto: textos.join("").trim(),
      herramienta,
      motivo:
        typeof detalles === "string"
          ? `Anthropic rechazó la solicitud (${detalles})`
          : "Anthropic rechazó la solicitud",
    };
  }

  return {
    corte: stopReason === "max_tokens" ? "truncado" : "fin",
    texto: textos.join("").trim(),
    herramienta,
  };
}

function respuestaError(motivo: string): RespuestaLLM {
  return { corte: "error", texto: "", herramienta: null, motivo };
}
