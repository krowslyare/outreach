import { describe, expect, it, vi } from "vitest";

import { proveedorAnthropic } from "./anthropic.js";
import type { SolicitudLLM } from "./port.js";

const herramienta = {
  nombre: "escalar",
  descripcion: "Escala la conversación.",
  esquema: {
    type: "object",
    properties: { motivo: { type: "string" } },
    required: ["motivo"],
    additionalProperties: false,
  },
} as const;

const solicitud: SolicitudLLM = {
  sistema: "Sé breve.",
  mensajes: [
    { rol: "user", texto: "Hola" },
    { rol: "assistant", texto: "¿Cómo te ayudo?" },
  ],
  herramientas: [herramienta],
  maxTokens: 321,
  esfuerzo: "high",
};

function sdkCon(respuesta: unknown) {
  const create = vi.fn(async () => respuesta);
  return {
    sdk: { beta: { messages: { create } } },
    create,
  };
}

describe("proveedorAnthropic", () => {
  it("traduce la solicitud y concatena texto", async () => {
    const doble = sdkCon({
      stop_reason: "end_turn",
      content: [
        { type: "text", text: " Hola " },
        { type: "text", text: "mundo " },
      ],
    });
    const proveedor = proveedorAnthropic({
      sdk: doble.sdk,
      modelo: "claude-prueba",
    });

    await expect(proveedor.generar(solicitud)).resolves.toEqual({
      corte: "fin",
      texto: "Hola mundo",
      herramienta: null,
    });
    expect(doble.create).toHaveBeenCalledWith({
      model: "claude-prueba",
      max_tokens: 321,
      system: [
        {
          type: "text",
          text: "Sé breve.",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        { role: "user", content: "Hola" },
        { role: "assistant", content: "¿Cómo te ayudo?" },
      ],
      tools: [
        {
          name: "escalar",
          description: "Escala la conversación.",
          input_schema: herramienta.esquema,
          strict: true,
        },
      ],
      output_config: { effort: "high" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  });

  it("traduce una invocación de herramienta", async () => {
    const doble = sdkCon({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          name: "escalar",
          input: { motivo: "pide_humano" },
        },
      ],
    });

    await expect(
      proveedorAnthropic({ sdk: doble.sdk }).generar(solicitud),
    ).resolves.toEqual({
      corte: "fin",
      texto: "",
      herramienta: {
        nombre: "escalar",
        input: { motivo: "pide_humano" },
      },
    });
  });

  it("marca max_tokens como truncado", async () => {
    const doble = sdkCon({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "A media" }],
    });

    await expect(
      proveedorAnthropic({ sdk: doble.sdk }).generar(solicitud),
    ).resolves.toMatchObject({
      corte: "truncado",
      texto: "A media",
    });
  });

  it("marca refusal como rechazo antes de usar el contenido", async () => {
    const doble = sdkCon({
      stop_reason: "refusal",
      stop_details: { category: "safety" },
      content: [],
    });

    await expect(
      proveedorAnthropic({ sdk: doble.sdk }).generar(solicitud),
    ).resolves.toEqual({
      corte: "rechazo",
      texto: "",
      herramienta: null,
      motivo: "Anthropic rechazó la solicitud (safety)",
    });
  });

  it("normaliza un fallo del SDK en vez de lanzarlo", async () => {
    const create = vi.fn(async () => {
      throw new Error("sin conexión");
    });
    const proveedor = proveedorAnthropic({
      sdk: { beta: { messages: { create } } },
    });

    await expect(proveedor.generar(solicitud)).resolves.toMatchObject({
      corte: "error",
      motivo: "Anthropic falló: sin conexión",
    });
  });
});
