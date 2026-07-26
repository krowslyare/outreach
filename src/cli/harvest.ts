// Corre la ingesta de RENIPRESS y reporta el embudo. Places es opt-in porque
// cada búsqueda consume crédito; el filtro nacional de gestores nunca lo es.
//
//   npm run harvest
//   npm run harvest -- --all-lima      (suelta el filtro de distrito)
//   npm run harvest -- --enrich --limit 10

import { DiskPlacesCache, enrichAll } from "../harvest/places.js";
import {
  CLASIFICACIONES_MARGEN,
  DISTRITOS_LIMA_ALTO,
  dedupeByMobile,
  filterProspects,
  filterSharedPhones,
  loadRenipress,
} from "../harvest/renipress.js";
import { scoreProspect } from "../score/score.js";

const CSV = "data_renipress_2025.csv";
const allLima = process.argv.includes("--all-lima");
const shouldEnrich = process.argv.includes("--enrich");

function parseLimit(args: string[]): number | undefined {
  const positionalIndex = args.indexOf("--limit");
  const inline = args.find((argument) => argument.startsWith("--limit="));
  const raw =
    positionalIndex >= 0
      ? args[positionalIndex + 1]
      : inline?.slice("--limit=".length);

  if (raw === undefined && positionalIndex < 0 && inline === undefined) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("--limit requiere un entero positivo, por ejemplo --limit 10");
  }
  return parsed;
}

const limit = parseLimit(process.argv.slice(2));

const all = await loadRenipress(CSV);
console.log(`filas parseadas: ${all.length}`);

const selected = filterProspects(all, {
  districts: allLima ? undefined : DISTRITOS_LIMA_ALTO,
  classifications: CLASIFICACIONES_MARGEN,
  requireMobile: true,
});
console.log(
  `segmento (privado + clasificación objetivo + con móvil): ${selected.length}`,
);

const mobiles = new Set<string>();
for (const prospect of selected) {
  for (const phone of prospect.phones) {
    if (phone.kind === "mobile" && phone.e164) mobiles.add(phone.e164);
  }
}
console.log(`celulares únicos: ${mobiles.size}`);

// El denominador tiene que ser nacional: limitarlo al segmento escondería a
// gestores que registraron establecimientos también fuera de Lima.
const sharedPhones = filterSharedPhones(all, selected);
console.log(
  `tras filtrar teléfonos compartidos: ${sharedPhones.kept.length} establecimientos`,
);
console.log(`números de gestores descartados: ${sharedPhones.dropped.length}`);

const { kept, collisions } = dedupeByMobile(sharedPhones.kept);
console.log(`tras dedupe por móvil: ${kept.length} establecimientos`);
console.log(`colisiones (mismo número, varios registros): ${collisions.length}`);

console.log(`\na 15/día = ${Math.round(kept.length / 15)} días de pipeline\n`);

const candidates = limit === undefined ? kept : kept.slice(0, limit);
if (limit !== undefined) {
  console.log(
    `--limit ${limit}: se procesarán ${candidates.length} establecimientos`,
  );
}

if (shouldEnrich) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();

  if (!apiKey) {
    console.error(
      "GOOGLE_PLACES_API_KEY no está definida; se omite el enriquecimiento para no hacer una corrida inválida.",
    );
  } else {
    const enriched = await enrichAll(
      candidates,
      {
        apiKey,
        fetch: globalThis.fetch,
        cache: new DiskPlacesCache(),
      },
      { delayMs: 200 },
    );
    const scored = enriched
      .map(scoreProspect)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.sourceId.localeCompare(right.sourceId),
      );

    console.log("\ntop 20 por score:");
    for (const prospect of scored.slice(0, 20)) {
      const mobile =
        prospect.phones.find((phone) => phone.kind === "mobile")?.e164 ?? "?";
      const hasWebsite = prospect.web.websiteUri === null ? "no" : "sí";
      console.log(
        `  ${prospect.name.slice(0, 38).padEnd(40)} ` +
          `${prospect.district.padEnd(18)} ${mobile.padEnd(14)} ` +
          `web: ${hasWebsite.padEnd(2)} score: ${prospect.score}`,
      );
    }
  }
} else {
  console.log("muestra:");
  for (const prospect of candidates.slice(0, 6)) {
    const mobile =
      prospect.phones.find((phone) => phone.kind === "mobile")?.e164 ?? "?";
    console.log(
      `  ${prospect.name.slice(0, 38).padEnd(40)} ` +
        `${prospect.district.padEnd(18)} ${mobile}`,
    );
  }
}

if (collisions.length > 0) {
  console.log("\nprimeras colisiones (revisar: mismo operador con varios locales):");
  for (const collision of collisions.slice(0, 3)) {
    console.log(`  ${collision.e164} → ${collision.sourceIds.join(", ")}`);
  }
}

if (sharedPhones.dropped.length > 0) {
  console.log("\nprincipales teléfonos compartidos descartados:");
  for (const shared of sharedPhones.dropped.slice(0, 3)) {
    console.log(`  ${shared.e164} → ${shared.count} establecimientos`);
  }
}
