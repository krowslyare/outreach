import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProveedorLLM, RespuestaLLM } from "./port.js";
import {
  ESQUEMA_TEXTO,
  construirPrompt,
  esquemaConHerramientas,
  interpretarEstructurado,
} from "./structured.js";
import {
  ejecutarSubproceso,
  motivoError,
  type EjecutorSubproceso,
} from "./subprocess.js";

const TIMEOUT_DEFAULT_MS = 120_000;
const MODELO_DEFAULT = "gpt-5.4";

/**
 * El puerto define cinco niveles y el CLI de Codex acepta cuatro. Los dos de
 * arriba colapsan a "high" en vez de pasarse tal cual: un valor que el CLI no
 * conoce lo hace terminar con código distinto de cero, y eso el agente lo
 * traduce a "el proveedor falló" y escala la conversación. Degradar es mejor
 * que romper.
 */
const ESFUERZO_CODEX: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

export interface CodexOpts {
  modelo?: string;
  timeoutMs?: number;
  /** Sustituye el proceso real en tests; recibe también rutas temporales. */
  ejecutar?: EjecutorSubproceso;
}

export function proveedorCodex(opts: CodexOpts = {}): ProveedorLLM {
  const ejecutar = opts.ejecutar ?? ejecutarSubproceso;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_DEFAULT_MS;
  const modelo = opts.modelo ?? MODELO_DEFAULT;

  return {
    nombre: "codex",
    async generar(solicitud) {
      let directorio: string | undefined;

      try {
        directorio = await mkdtemp(join(tmpdir(), "outreach-codex-"));
        const rutaEsquema = join(directorio, "schema.json");
        const rutaSalida = join(directorio, "output.json");
        const herramientas = solicitud.herramientas ?? [];
        const esquema =
          herramientas.length === 0
            ? ESQUEMA_TEXTO
            : esquemaConHerramientas(herramientas);

        await writeFile(rutaEsquema, JSON.stringify(esquema), "utf8");

        const resultado = await ejecutar(
          "codex",
          [
            "exec",
            "-m",
            modelo,
            // El esfuerzo venía en la solicitud y este adaptador lo tiraba: todo
            // corría en el default del CLI, así que pedir "medium" para
            // conversar o "high" para componer no cambiaba nada.
            "-c",
            `model_reasoning_effort=${ESFUERZO_CODEX[solicitud.esfuerzo ?? "medium"] ?? "medium"}`,
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--output-schema",
            rutaEsquema,
            "-o",
            rutaSalida,
            construirPrompt(solicitud, esquema),
          ],
          { timeoutMs },
        );

        if (resultado.timeout) {
          return error(`Codex excedió el timeout de ${timeoutMs} ms`);
        }
        if (resultado.codigo !== 0) {
          return error(
            `Codex terminó con código ${resultado.codigo ?? "desconocido"}${detalleStderr(resultado.stderr)}`,
          );
        }

        const salida = await readFile(rutaSalida, "utf8");
        let valor: unknown;
        try {
          valor = JSON.parse(salida) as unknown;
        } catch {
          return error("Codex escribió JSON inválido en el archivo de salida");
        }

        return (
          interpretarEstructurado(valor, herramientas) ??
          error("Codex devolvió un objeto que no cumple el esquema esperado")
        );
      } catch (causa) {
        return error(`No se pudo ejecutar Codex: ${motivoError(causa)}`);
      } finally {
        if (directorio !== undefined) {
          // El esquema puede contener datos de negocio; se intenta borrar aun
          // cuando el CLI falla o produce una salida ilegible.
          await rm(directorio, { recursive: true, force: true }).catch(() => {});
        }
      }
    },
  };
}

function detalleStderr(stderr: string): string {
  const limpio = stderr.trim();
  return limpio.length === 0 ? "" : `: ${limpio}`;
}

function error(motivo: string): RespuestaLLM {
  return { corte: "error", texto: "", herramienta: null, motivo };
}
