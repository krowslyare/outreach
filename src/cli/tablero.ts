// El tablero en el navegador: npm run tablero.
//
// Un servidor HTTP chico que sirve la página (src/tablero/pagina.ts) y un
// JSON con los mismos read-models que consumen panel y bandeja. Escucha
// ÚNICAMENTE en 127.0.0.1: esto lee conversaciones reales de clientes y no
// tiene autenticación — su frontera es que solo existe en tu máquina.
//
// Las únicas escrituras son las dos que el onboarding necesita a mano:
// marcar requisitos y mover el estado de una ficha. Enviar mensajes NO es una
// acción del tablero, ni lo será: el envío solo sale del proceso con sesión
// vinculada y su motor de seguridad.
//
// El ensamblado está separado del arranque para poder probar el contrato HTTP
// sobre un puerto efímero sin tocar la base real.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import { Store } from "../wa/store.js";
import { esEstadoCliente } from "../onboarding/requisitos.js";
import { datosTablero, type FuenteTablero } from "../tablero/datos.js";
import { PAGINA } from "../tablero/pagina.js";

const LIMITE_CUERPO = 10_000;

function responder(res: ServerResponse, status: number, cuerpo: string): void {
  res.writeHead(status, {
    "content-type": cuerpo.startsWith("<")
      ? "text/html; charset=utf-8"
      : "application/json; charset=utf-8",
  });
  res.end(cuerpo);
}

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const trozo of req) {
    total += (trozo as Buffer).length;
    if (total > LIMITE_CUERPO) throw new Error("cuerpo demasiado grande");
    trozos.push(trozo as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(trozos).toString("utf8") || "{}");
  } catch {
    throw new Error("json inválido");
  }
}

export function ensamblarServidor(store: Store): {
  servidor: Server;
  fuente: FuenteTablero;
} {
  const fuente: FuenteTablero = {
    loadAccountHealth: (ahora) => store.loadAccountHealth(ahora),
    colaAtencion: (limite) => store.colaAtencion(limite),
    listarClientes: () => store.listarClientes(),
    // Los conteos reutilizan las MISMAS consultas del embudo: si una cambia,
    // el tablero no puede quedarse viendo otro número.
    contarPorRevisar: (limite) => store.paraRevisar(limite).length,
    contarListosParaContactar: (limite) =>
      store.candidatosParaContactar(limite).length,
  };

  const servidor = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      // El e164 llega con "+" codificado (%2B); decodificar ANTES de casar.
      const ruta = decodeURIComponent(url.pathname);

      if (req.method === "GET" && ruta === "/") {
        responder(res, 200, PAGINA);
        return;
      }

      if (req.method === "GET" && ruta === "/api/estado") {
        responder(res, 200, JSON.stringify(datosTablero(fuente, new Date())));
        return;
      }

      const requisito = ruta.match(/^\/api\/clientes\/(\+51\d{9})\/requisito$/);
      if (req.method === "POST" && requisito !== null) {
        const cuerpo = (await leerCuerpo(req)) as { clave?: unknown; resuelto?: unknown };
        const e164 = requisito[1]!;
        const clave = typeof cuerpo.clave === "string" ? cuerpo.clave : "";
        const resuelto = cuerpo.resuelto === true;
        if (!store.marcarRequisito(e164, clave, resuelto)) {
          responder(res, 404, JSON.stringify({ error: `"${clave}" no existe en ${e164}` }));
          return;
        }
        responder(res, 200, JSON.stringify({ ok: true }));
        return;
      }

      const estadoRuta = ruta.match(/^\/api\/clientes\/(\+51\d{9})\/estado$/);
      if (req.method === "POST" && estadoRuta !== null) {
        const cuerpo = (await leerCuerpo(req)) as { estado?: unknown };
        const nuevo = typeof cuerpo.estado === "string" ? cuerpo.estado : "";
        if (!esEstadoCliente(nuevo)) {
          responder(res, 400, JSON.stringify({ error: `estado desconocido: "${nuevo}"` }));
          return;
        }
        if (store.cargarCliente(estadoRuta[1]!) === null) {
          responder(res, 404, JSON.stringify({ error: `${estadoRuta[1]} no es cliente` }));
          return;
        }
        store.cambiarEstadoCliente(estadoRuta[1]!, nuevo);
        responder(res, 200, JSON.stringify({ ok: true }));
        return;
      }

      responder(res, 404, JSON.stringify({ error: "ruta desconocida" }));
    })().catch((error: unknown) => {
      // Un fallo en un request no tumba el tablero; el navegador muestra el
      // motivo y el polling sigue.
      responder(res, 500, JSON.stringify({ error: String(error) }));
    });
  });

  return { servidor, fuente };
}

function esEjecucionDirecta(): boolean {
  const entrada = process.argv[1];
  if (entrada === undefined) return false;
  return import.meta.url === pathToFileURL(entrada).href;
}

if (esEjecucionDirecta()) {
  const puerto = process.env.PUERTO_TABLERO
    ? Number(process.env.PUERTO_TABLERO)
    : 4173;
  const { servidor } = ensamblarServidor(new Store());
  servidor.listen(puerto, "127.0.0.1", () => {
    console.info(
      `\nTablero local: http://127.0.0.1:${puerto}\n` +
        "Solo escucha en localhost. Refresco cada 5s; Ctrl-C para salir.\n",
    );
  });
}
