import { describe, expect, it, vi } from "vitest";

import { proveedorGemini } from "./gemini.js";
import type { SolicitudLLM } from "./port.js";

const herramienta = {
  nombre: "agendar",
  descripcion: "Agenda una llamada.",
  esquema: {
    type: "object",
    properties: { hora: { type: "string" } },
    required: ["hora"],
    additionalProperties: false,
  },
} as const;

const solicitud: SolicitudLLM = {
  sistema: "Responde en español.",
  mensajes: [
    { rol: "user", texto: "Hola" },
    { rol: "assistant", texto: "Hola, ¿qué necesita?" },
  ],
  herramientas: [herramienta],
  maxTokens: 456,
};

function fetchCon(cuerpo: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(cuerpo), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("proveedorGemini", () => {
  it("traduce la solicitud y concatena parts de texto", async () => {
    const hacerFetch = fetchCon({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [{ text: "Hola " }, { text: "mundo" }],
          },
        },
      ],
    });
    const proveedor = proveedorGemini({
      apiKey: "key-prueba",
      modelo: "gemini-prueba",
      fetch: hacerFetch,
    });

    await expect(proveedor.generar(solicitud)).resolves.toEqual({
      corte: "fin",
      texto: "Hola mundo",
      herramienta: null,
    });

    expect(hacerFetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(hacerFetch).mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-prueba:generateContent",
    );
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      "x-goog-api-key": "key-prueba",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      systemInstruction: { parts: [{ text: "Responde en español." }] },
      contents: [
        { role: "user", parts: [{ text: "Hola" }] },
        {
          role: "model",
          parts: [{ text: "Hola, ¿qué necesita?" }],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "agendar",
              description: "Agenda una llamada.",
              parameters: herramienta.esquema,
            },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 456 },
    });
  });

  it("traduce functionCall a herramienta", async () => {
    const hacerFetch = fetchCon({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              {
                functionCall: {
                  name: "agendar",
                  args: { hora: "10:00" },
                },
              },
            ],
          },
        },
      ],
    });

    await expect(
      proveedorGemini({ apiKey: "key", fetch: hacerFetch }).generar(solicitud),
    ).resolves.toEqual({
      corte: "fin",
      texto: "",
      herramienta: {
        nombre: "agendar",
        input: { hora: "10:00" },
      },
    });
  });

  it("marca MAX_TOKENS como truncado", async () => {
    const hacerFetch = fetchCon({
      candidates: [
        {
          finishReason: "MAX_TOKENS",
          content: { parts: [{ text: "Respuesta corta" }] },
        },
      ],
    });

    await expect(
      proveedorGemini({ apiKey: "key", fetch: hacerFetch }).generar(solicitud),
    ).resolves.toMatchObject({
      corte: "truncado",
      texto: "Respuesta corta",
    });
  });

  it.each(["SAFETY", "PROHIBITED_CONTENT"])(
    "marca %s como rechazo",
    async (finishReason) => {
      const hacerFetch = fetchCon({
        candidates: [{ finishReason, content: { parts: [] } }],
      });

      await expect(
        proveedorGemini({ apiKey: "key", fetch: hacerFetch }).generar(
          solicitud,
        ),
      ).resolves.toMatchObject({
        corte: "rechazo",
        motivo: `Gemini rechazó la solicitud (${finishReason})`,
      });
    },
  );
});
