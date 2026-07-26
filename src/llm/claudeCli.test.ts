import { describe, expect, it, vi } from "vitest";

import { proveedorClaudeCli } from "./claudeCli.js";
import type { SolicitudLLM } from "./port.js";
import type { EjecutorSubproceso } from "./subprocess.js";

const solicitud: SolicitudLLM = {
  sistema: "Sé breve.",
  mensajes: [{ rol: "user", texto: "Hola" }],
  herramientas: [
    {
      nombre: "escalar",
      descripcion: "Escala a una persona.",
      esquema: {
        type: "object",
        properties: { motivo: { type: "string" } },
        required: ["motivo"],
        additionalProperties: false,
      },
    },
  ],
  maxTokens: 100,
};

function salidaClaude(result: string, stopReason = "end_turn"): string {
  return JSON.stringify({
    is_error: false,
    stop_reason: stopReason,
    session_id: "sesion-prueba",
    usage: {},
    result,
  });
}

describe("proveedorClaudeCli", () => {
  it("parsea JSON cercado y traduce una herramienta", async () => {
    const ejecutar: EjecutorSubproceso = vi.fn(
      async (comando, argumentos, opciones) => {
        expect(comando).toBe("claude");
        expect(argumentos[0]).toBe("-p");
        expect(argumentos.slice(-2)).toEqual(["--output-format", "json"]);
        expect(opciones).toEqual({ timeoutMs: 2_000 });
        return {
          codigo: 0,
          stdout: salidaClaude(
            '```json\n{"accion":"escalar","input":{"motivo":"pide_humano"}}\n```',
          ),
          stderr: "",
          timeout: false,
        };
      },
    );

    await expect(
      proveedorClaudeCli({ ejecutar, timeoutMs: 2_000 }).generar(solicitud),
    ).resolves.toEqual({
      corte: "fin",
      texto: "",
      herramienta: {
        nombre: "escalar",
        input: { motivo: "pide_humano" },
      },
    });
  });

  it("degrada un result con JSON inválido a texto crudo", async () => {
    const ejecutar: EjecutorSubproceso = async () => ({
      codigo: 0,
      stdout: salidaClaude("  Respuesta todavía utilizable  "),
      stderr: "",
      timeout: false,
    });

    await expect(
      proveedorClaudeCli({ ejecutar }).generar(solicitud),
    ).resolves.toEqual({
      corte: "fin",
      texto: "Respuesta todavía utilizable",
      herramienta: null,
    });
  });

  it("convierte timeout en error sin lanzar", async () => {
    const ejecutar: EjecutorSubproceso = async () => ({
      codigo: null,
      stdout: "",
      stderr: "",
      timeout: true,
    });

    await expect(
      proveedorClaudeCli({ ejecutar, timeoutMs: 50 }).generar(solicitud),
    ).resolves.toMatchObject({
      corte: "error",
      motivo: "Claude CLI excedió el timeout de 50 ms",
    });
  });

  it("convierte un exit code no cero en error sin lanzar", async () => {
    const ejecutar: EjecutorSubproceso = async () => ({
      codigo: 2,
      stdout: "",
      stderr: "sesión vencida",
      timeout: false,
    });

    await expect(
      proveedorClaudeCli({ ejecutar }).generar(solicitud),
    ).resolves.toMatchObject({
      corte: "error",
      motivo: "Claude CLI terminó con código 2: sesión vencida",
    });
  });

  it("convierte un envoltorio JSON inválido en error sin lanzar", async () => {
    const ejecutar: EjecutorSubproceso = async () => ({
      codigo: 0,
      stdout: "no-json",
      stderr: "",
      timeout: false,
    });

    await expect(
      proveedorClaudeCli({ ejecutar }).generar(solicitud),
    ).resolves.toMatchObject({
      corte: "error",
      motivo: "Claude CLI devolvió un envoltorio JSON inválido",
    });
  });
});
