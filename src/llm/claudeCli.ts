/**
 * Adaptador para Claude Code en modo no interactivo.
 *
 * ADVERTENCIA: una medición real mostró un overhead aproximado de 12,500
 * tokens del system prompt de Claude Code en CADA invocación. Este adaptador
 * sirve como alternativa operativa, pero no tiene el costo de un cliente API
 * directo ni comparte su cache de prefijo.
 */

import type { ProveedorLLM, RespuestaLLM } from "./port.js";
import {
  ESQUEMA_TEXTO,
  construirPrompt,
  esquemaConHerramientas,
  esRegistro,
  interpretarEstructurado,
  parsearJsonTolerante,
} from "./structured.js";
import {
  ejecutarSubproceso,
  motivoError,
  type EjecutorSubproceso,
} from "./subprocess.js";

const TIMEOUT_DEFAULT_MS = 120_000;

export interface ClaudeCliOpts {
  timeoutMs?: number;
  ejecutar?: EjecutorSubproceso;
}

export function proveedorClaudeCli(opts: ClaudeCliOpts = {}): ProveedorLLM {
  const ejecutar = opts.ejecutar ?? ejecutarSubproceso;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_DEFAULT_MS;

  return {
    nombre: "claude-cli",
    async generar(solicitud) {
      try {
        const herramientas = solicitud.herramientas ?? [];
        const esquema =
          herramientas.length === 0
            ? ESQUEMA_TEXTO
            : esquemaConHerramientas(herramientas);
        const resultado = await ejecutar(
          "claude",
          [
            "-p",
            construirPrompt(solicitud, esquema),
            "--output-format",
            "json",
          ],
          { timeoutMs },
        );

        if (resultado.timeout) {
          return error(`Claude CLI excedió el timeout de ${timeoutMs} ms`);
        }
        if (resultado.codigo !== 0) {
          return error(
            `Claude CLI terminó con código ${resultado.codigo ?? "desconocido"}${detalleStderr(resultado.stderr)}`,
          );
        }

        let envoltorio: unknown;
        try {
          envoltorio = JSON.parse(resultado.stdout) as unknown;
        } catch {
          return error("Claude CLI devolvió un envoltorio JSON inválido");
        }
        if (!esRegistro(envoltorio)) {
          return error("Claude CLI devolvió una respuesta inválida");
        }
        if (envoltorio.is_error === true) {
          return error(
            typeof envoltorio.result === "string"
              ? envoltorio.result
              : "Claude CLI marcó la respuesta como error",
          );
        }

        const crudo =
          typeof envoltorio.result === "string" ? envoltorio.result : "";
        const corte = traducirCorte(envoltorio.stop_reason);
        if (corte !== "fin") {
          return {
            corte,
            texto: crudo.trim(),
            herramienta: null,
            ...(corte === "rechazo"
              ? { motivo: "Claude CLI rechazó la solicitud" }
              : {}),
          };
        }

        try {
          const interpretada = interpretarEstructurado(
            parsearJsonTolerante(crudo),
            herramientas,
          );
          if (interpretada !== null) return interpretada;
        } catch {
          // Claude no garantiza salida estructurada. El texto crudo todavía
          // puede salvar la conversación, por eso no se descarta por formato.
        }

        return { corte: "fin", texto: crudo.trim(), herramienta: null };
      } catch (causa) {
        return error(`No se pudo ejecutar Claude CLI: ${motivoError(causa)}`);
      }
    },
  };
}

function traducirCorte(stopReason: unknown): RespuestaLLM["corte"] {
  if (stopReason === "max_tokens") return "truncado";
  if (stopReason === "refusal") return "rechazo";
  return "fin";
}

function detalleStderr(stderr: string): string {
  const limpio = stderr.trim();
  return limpio.length === 0 ? "" : `: ${limpio}`;
}

function error(motivo: string): RespuestaLLM {
  return { corte: "error", texto: "", herramienta: null, motivo };
}
