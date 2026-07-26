import { access, writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { proveedorCodex } from "./codex.js";
import type { SolicitudLLM } from "./port.js";
import type { EjecutorSubproceso } from "./subprocess.js";

const solicitudTexto: SolicitudLLM = {
  sistema: "Sé breve.",
  mensajes: [{ rol: "user", texto: "Saluda" }],
  maxTokens: 100,
};

const solicitudHerramienta: SolicitudLLM = {
  ...solicitudTexto,
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
};

function rutaDespues(argumentos: readonly string[], bandera: string): string {
  const indice = argumentos.indexOf(bandera);
  const valor = argumentos[indice + 1];
  if (indice < 0 || valor === undefined) {
    throw new Error(`Falta ${bandera}`);
  }
  return valor;
}

describe("proveedorCodex", () => {
  it("lee la salida estructurada y siempre limpia el temporal", async () => {
    let directorio: string | undefined;
    const ejecutar: EjecutorSubproceso = vi.fn(
      async (comando, argumentos, opciones) => {
        expect(comando).toBe("codex");
        expect(argumentos.slice(0, 8)).toEqual([
          "exec",
          "-m",
          "modelo-prueba",
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "--output-schema",
          expect.any(String),
        ]);
        expect(opciones).toEqual({ timeoutMs: 3_000 });
        const rutaSalida = rutaDespues(argumentos, "-o");
        directorio = rutaSalida.slice(0, rutaSalida.lastIndexOf("/"));
        await writeFile(rutaSalida, '{"texto":"Hola 👋"}', "utf8");
        return { codigo: 0, stdout: "", stderr: "", timeout: false };
      },
    );

    const respuesta = proveedorCodex({
      ejecutar,
      modelo: "modelo-prueba",
      timeoutMs: 3_000,
    }).generar(solicitudTexto);

    await expect(respuesta).resolves.toEqual({
      corte: "fin",
      texto: "Hola 👋",
      herramienta: null,
    });
    expect(directorio).toBeDefined();
    await expect(access(directorio!)).rejects.toThrow();
  });

  it("interpreta una elección de herramienta", async () => {
    const ejecutar: EjecutorSubproceso = async (_comando, argumentos) => {
      await writeFile(
        rutaDespues(argumentos, "-o"),
        JSON.stringify({
          accion: "escalar",
          input: { motivo: "pide_humano" },
        }),
        "utf8",
      );
      return { codigo: 0, stdout: "", stderr: "", timeout: false };
    };

    await expect(
      proveedorCodex({ ejecutar }).generar(solicitudHerramienta),
    ).resolves.toEqual({
      corte: "fin",
      texto: "",
      herramienta: {
        nombre: "escalar",
        input: { motivo: "pide_humano" },
      },
    });
  });

  it("convierte JSON inválido en error sin lanzar", async () => {
    const ejecutar: EjecutorSubproceso = async (_comando, argumentos) => {
      await writeFile(rutaDespues(argumentos, "-o"), "{incompleto", "utf8");
      return { codigo: 0, stdout: "", stderr: "", timeout: false };
    };

    await expect(
      proveedorCodex({ ejecutar }).generar(solicitudTexto),
    ).resolves.toMatchObject({
      corte: "error",
      motivo: "Codex escribió JSON inválido en el archivo de salida",
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
      proveedorCodex({ ejecutar, timeoutMs: 25 }).generar(solicitudTexto),
    ).resolves.toMatchObject({
      corte: "error",
      motivo: "Codex excedió el timeout de 25 ms",
    });
  });

  it("convierte un exit code no cero en error sin lanzar", async () => {
    const ejecutar: EjecutorSubproceso = async () => ({
      codigo: 7,
      stdout: "",
      stderr: "credenciales ausentes",
      timeout: false,
    });

    await expect(
      proveedorCodex({ ejecutar }).generar(solicitudTexto),
    ).resolves.toMatchObject({
      corte: "error",
      motivo: "Codex terminó con código 7: credenciales ausentes",
    });
  });
});
