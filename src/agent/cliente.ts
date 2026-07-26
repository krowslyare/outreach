// Implementación real del puerto ClienteClaude. Aislada del agente para que
// agent.ts no dependa del SDK y se pueda testear con un doble.

import Anthropic from "@anthropic-ai/sdk";

import type { ClienteClaude, RespuestaClaude } from "./agent.js";

/**
 * Fallback por refusal.
 *
 * Los clasificadores de seguridad de Opus 5 pueden rechazar una generación, y
 * un rechazo sin fallback deja la conversación muerta. Acá el escenario es
 * real y no teórico: el que escribe del otro lado es un desconocido y puede
 * mandar cualquier cosa. Con esto, un rechazo se reintenta solo en el modelo
 * de respaldo que Anthropic recomienda para esa categoría, en la misma
 * llamada, en vez de dejar al prospecto sin respuesta.
 *
 * Se usa el modo "default" y no un modelo fijo: el respaldo correcto depende
 * de POR QUÉ se rechazó, y así no queda una migración pendiente cuando un
 * modelo pinneado se deprecie.
 */
const BETA_FALLBACK = "server-side-fallback-2026-07-01";

export function clienteAnthropic(apiKey?: string): ClienteClaude {
  // Sin apiKey explícita el SDK resuelve credenciales del entorno
  // (ANTHROPIC_API_KEY, o un perfil de `ant auth login`).
  const sdk = new Anthropic(apiKey === undefined ? {} : { apiKey });

  return {
    async crear(params) {
      // El SDK reintenta 429 y 5xx solo, con backoff. No hace falta envolverlo.
      const respuesta = await sdk.beta.messages.create({
        ...params,
        betas: [BETA_FALLBACK],
        fallbacks: "default",
        // El tipado del SDK va por detrás de `fallbacks: "default"`; el shape
        // es el documentado para la API. Revisar en cada bump del SDK.
      } as never);

      return respuesta as unknown as RespuestaClaude;
    },
  };
}
