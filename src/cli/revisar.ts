// Revisión manual del tramo "no se sabe si tiene web".
//
//   npm run revisar                      lista los pendientes con su link
//   npm run revisar -- --con-web +51...  tiene web: se suprime
//   npm run revisar -- --sin-web +51...  confirmado sin web: sube de score
//
// Estos prospectos YA son contactables: el mensaje en frío no afirma nada sobre
// su web. Lo que cambia al revisarlos es la prioridad — un verificado puntúa 40
// y un "no se sabe" 22— así que esto es lo que más mueve el orden de la cola.
//
// El link va a la ficha de Google Maps por place_id, que es donde se ve el sitio
// del negocio en dos segundos. Se abre en el navegador, no acá: verificar esto
// automáticamente es justo lo que Places ya intentó y no pudo.

import "./env.js";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PUNTOS_SIN_WEB_SIN_VERIFICAR,
  PUNTOS_SIN_WEB_VERIFICADO,
} from "../score/score.js";
import { Store } from "../wa/store.js";

const DIRECTORIO_CACHE = ".places-cache";
const DELTA_VERIFICAR = PUNTOS_SIN_WEB_VERIFICADO - PUNTOS_SIN_WEB_SIN_VERIFICAR;

function valor(args: readonly string[], nombre: string): string | undefined {
  const posicional = args.indexOf(`--${nombre}`);
  if (posicional >= 0) return args[posicional + 1];
  return args
    .find((a) => a.startsWith(`--${nombre}=`))
    ?.slice(`--${nombre}=`.length);
}

/** El place_id quedó en el caché del harvest; sin él no hay link que dar. */
function linkDeMapas(sourceId: string): string | null {
  try {
    const crudo = readFileSync(join(DIRECTORIO_CACHE, `${sourceId}.json`), "utf8");
    const { placeId } = JSON.parse(crudo) as { placeId: string | null };
    return typeof placeId === "string"
      ? `https://www.google.com/maps/place/?q=place_id:${placeId}`
      : null;
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const conWeb = valor(args, "con-web")?.trim();
const sinWeb = valor(args, "sin-web")?.trim();

const store = new Store();
try {
  const marcar = conWeb ?? sinWeb;
  if (marcar !== undefined) {
    if (!/^\+51\d{9}$/.test(marcar)) {
      throw new Error(
        `${marcar} no es un móvil peruano en E.164, por ejemplo +51987654321`,
      );
    }
    const tieneWeb = conWeb !== undefined;
    const ok = store.resolverWeb(marcar, tieneWeb, DELTA_VERIFICAR);
    if (!ok) {
      console.info(
        `${marcar} no estaba pendiente de revisión (o ya se resolvió). Nada que hacer.`,
      );
    } else if (tieneWeb) {
      console.info(`${marcar}: tiene web → suprimido, no entra a la cola.`);
    } else {
      console.info(
        `${marcar}: verificado SIN web → +${DELTA_VERIFICAR} de score, sube en la cola.`,
      );
    }
    process.exit(0);
  }

  const pendientes = store.paraRevisar(200);
  if (pendientes.length === 0) {
    console.info("No queda nada por revisar.");
    process.exit(0);
  }

  console.info(
    `${pendientes.length} por revisar. Abre el link, mira si tiene web y marca:\n`,
  );
  for (const p of pendientes) {
    const link = linkDeMapas(p.sourceId) ?? "(sin place_id en el caché)";
    const resenas = p.resenas === null ? "sin reseñas" : `${p.resenas} reseñas`;
    console.info(
      `${p.nombre}\n` +
        `  ${p.distrito} · score ${p.score ?? "—"} · ${resenas}\n` +
        `  ${link}\n` +
        `  npm run revisar -- --sin-web ${p.e164}   (confirmado sin web)\n` +
        `  npm run revisar -- --con-web ${p.e164}   (sí tiene web)\n`,
    );
  }
} finally {
  store.close();
}
