import { spawn } from "node:child_process";

export interface OpcionesSubproceso {
  timeoutMs: number;
}

export interface ResultadoSubproceso {
  codigo: number | null;
  stdout: string;
  stderr: string;
  timeout: boolean;
}

export type EjecutorSubproceso = (
  comando: string,
  argumentos: readonly string[],
  opciones: OpcionesSubproceso,
) => Promise<ResultadoSubproceso>;

/**
 * Ejecuta un CLI sin heredar stdin.
 *
 * El stdin cerrado no es un detalle cosmético: Codex espera entrada adicional
 * si ve un pipe abierto, y una campaña completa quedaría detenida en esa llamada.
 */
export const ejecutarSubproceso: EjecutorSubproceso = (
  comando,
  argumentos,
  opciones,
) =>
  new Promise((resolve, reject) => {
    const hijo = spawn(comando, [...argumentos], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let expiro = false;
    let resuelto = false;

    hijo.stdout.setEncoding("utf8");
    hijo.stderr.setEncoding("utf8");
    hijo.stdout.on("data", (trozo: string) => {
      stdout += trozo;
    });
    hijo.stderr.on("data", (trozo: string) => {
      stderr += trozo;
    });

    // SIGTERM da al CLI oportunidad de cerrar sus archivos; SIGKILL evita que
    // un proceso que ignore la señal siga bloqueando toda la tanda.
    const temporizador = setTimeout(() => {
      expiro = true;
      hijo.kill("SIGTERM");
      const forzar = setTimeout(() => {
        if (!resuelto) hijo.kill("SIGKILL");
      }, 1_000);
      forzar.unref();
    }, opciones.timeoutMs);
    temporizador.unref();

    hijo.once("error", (error) => {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(temporizador);
      reject(error);
    });

    hijo.once("close", (codigo) => {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(temporizador);
      resolve({ codigo, stdout, stderr, timeout: expiro });
    });
  });

export function motivoError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
