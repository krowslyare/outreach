// Descubrimiento genérico con Google Places Text Search.
//
// Hace como máximo una request por variante (20 resultados por request). Aun
// con --import, todo entra PENDIENTE: Places sin websiteUri no prueba que no
// exista una web.

import "./env.js";

import {
  asManualInput,
  discoverPlaces,
  shortlistFromPlaces,
  type DiscoveredProspect,
} from "../prospects/places-discovery.js";
import {
  VERTICALES,
  esVerticalId,
  type VerticalId,
} from "../prospects/verticals.js";
import { Store } from "../wa/store.js";

function valor(args: readonly string[], nombre: string): string | undefined {
  const pos = args.indexOf(`--${nombre}`);
  if (pos >= 0) return args[pos + 1];
  return args
    .find((arg) => arg.startsWith(`--${nombre}=`))
    ?.slice(`--${nombre}=`.length);
}

function entero(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`valor debe ser un entero entre 1 y ${max}`);
  }
  return parsed;
}

const args = process.argv.slice(2);
const verticalRaw = valor(args, "vertical")?.trim().toLowerCase();
if (verticalRaw === undefined || !esVerticalId(verticalRaw)) {
  throw new Error(
    "--vertical es obligatorio; mira las opciones con npm run prospectos -- --verticales",
  );
}
const vertical: VerticalId = verticalRaw;
const district = valor(args, "distrito")?.trim();
if (!district) throw new Error("--distrito es obligatorio");
const max = entero(valor(args, "max"), 20, 60);
const variants = entero(valor(args, "variantes"), 1, 3);
const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY no está configurada");

const config = VERTICALES[vertical];
const customQuery = valor(args, "consulta")?.trim();
const queries = customQuery
  ? [customQuery]
  : config.placeQueries.slice(0, variants);
console.info(
  `${config.label} en ${district}: ${queries.length} request(s) a Places, ` +
    `máximo ${Math.min(max, queries.length * 20)} resultados antes de filtros.`,
);

const byPhone = new Map<string, DiscoveredProspect>();
for (const query of queries) {
  const raw = await discoverPlaces({
    apiKey,
    query,
    district,
    pageSize: Math.min(20, max),
  });
  for (const item of shortlistFromPlaces(raw, vertical, district, query)) {
    const previous = byPhone.get(item.e164);
    if (previous === undefined || item.score > previous.score) {
      byPhone.set(item.e164, item);
    }
  }
}
const shortlist = [...byPhone.values()]
  .sort(
    (left, right) =>
      right.score - left.score || left.name.localeCompare(right.name),
  )
  .slice(0, max);

if (args.includes("--import")) {
  const store = new Store();
  try {
    for (const item of shortlist) {
      store.upsertManualProspect(asManualInput(item, vertical));
    }
  } finally {
    store.close();
  }
  console.info(
    `Importados ${shortlist.length} como pendientes. Ninguno quedó autorizado para campaña.\n`,
  );
}

if (shortlist.length === 0) {
  console.info("No quedaron negocios operativos con móvil y sin web reportada.");
} else {
  console.info(`Shortlist (${shortlist.length}):\n`);
  for (const item of shortlist) {
    console.info(
      `${item.name}\n` +
        `  ${item.e164} · score ${item.score} · ${item.rating ?? "—"}/5 · ${item.reviewCount ?? 0} reseñas\n` +
        `  ${item.address || district}\n` +
        `  ${item.googleMapsUri ?? "(sin link de Maps)"}\n`,
    );
  }
}
