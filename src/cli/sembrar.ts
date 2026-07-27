// Mete un número a mano en la cola de campaña, para probar contra un teléfono
// propio antes de escribirle a un desconocido.
//
//   npm run sembrar -- --e164 +51987654321 --nombre "Consultorio de prueba"
//   npm run sembrar -- --e164 +51987654321 --nombre "X" --distrito Surco --con-web
//
// Existe porque importRecipients solo entiende prospectos salidos del harvest, y
// un número personal no está en RENIPRESS. Va por el MISMO camino que un
// prospecto real —importRecipients, no un insert aparte— para que la prueba
// ejercite el código que se va a usar en producción y no una ruta paralela.

import type { ScoredProspect } from "../types.js";
import { Store } from "../wa/store.js";

function valor(args: readonly string[], nombre: string): string | undefined {
  const posicional = args.indexOf(`--${nombre}`);
  if (posicional >= 0) return args[posicional + 1];
  const inline = args.find((a) => a.startsWith(`--${nombre}=`));
  return inline?.slice(`--${nombre}=`.length);
}

const args = process.argv.slice(2);
const e164 = valor(args, "e164")?.trim();
const nombre = valor(args, "nombre")?.trim();
const distrito = valor(args, "distrito")?.trim() ?? "MIRAFLORES";
const clasificacion = valor(args, "clasificacion")?.trim() ?? "CENTRO ODONTOLOGICO";
const conWeb = args.includes("--con-web");

if (e164 === undefined || !/^\+51\d{9}$/.test(e164)) {
  throw new Error(
    "--e164 requiere un móvil peruano en E.164, por ejemplo +51987654321",
  );
}
if (nombre === undefined || nombre === "") {
  throw new Error(
    "--nombre es obligatorio: es lo que el compositor usa para personalizar, " +
      "y sin eso la prueba no se parece a un envío real",
  );
}

// sourceId con prefijo propio para poder distinguir después qué filas son de
// prueba. No usa el prefijo 'inbound:' porque ése marca a los ajenos a la
// campaña, y éste sí tiene que comportarse como un prospecto de verdad.
const prospecto: ScoredProspect = {
  source: "renipress",
  sourceId: `prueba:${e164}`,
  name: nombre,
  classification: clasificacion,
  category: "I-2",
  district: distrito,
  ubigeo: "150122",
  address: "—",
  lat: null,
  lng: null,
  phones: [{ raw: e164, e164, kind: "mobile" }],
  web: {
    checkedAt: new Date().toISOString(),
    placeId: null,
    websiteUri: conWeb ? "https://ejemplo.pe" : null,
    rating: null,
    userRatingCount: null,
    matchConfidence: 1,
    verificadoSinWeb: !conWeb,
  },
  score: 100,
  signals: [],
  eligible: true,
  blockers: [],
};

const store = new Store();
try {
  store.importRecipients([prospecto]);
  const cola = store.candidatosParaContactar(50);
  const posicion = cola.findIndex((candidato) => candidato.e164 === e164);
  console.info(`Sembrado ${e164} — ${nombre} (${distrito}, ${clasificacion})`);
  if (posicion < 0) {
    console.info(
      "NO está en la cola: revisa si ya está suprimido, tomado por un humano o " +
        "si ya respondió alguien desde ese número.",
    );
  } else {
    // La cabeza de la cola se imprime porque el riesgo de una prueba no es que
    // falle: es pasarse de `--max` y que el segundo mensaje salga hacia un
    // prospecto real. Hay que poder ver a quién le tocaría antes de mandar.
    console.info(`\nPróximos en la cola (--max N toma los primeros N):`);
    for (const [indice, candidato] of cola.slice(0, 5).entries()) {
      const marca = candidato.e164 === e164 ? " ← el que acabas de sembrar" : "";
      console.info(
        `  ${indice + 1}. ${candidato.e164}  score ${candidato.score ?? "—"}${marca}`,
      );
    }
    if (posicion > 0) {
      console.warn(
        `\n⚠️  Tu número de prueba está en la posición ${posicion + 1}. ` +
          `Con --max ${posicion + 1} le escribirías antes a ${posicion} prospecto(s) REAL(es).`,
      );
    }
  }
} finally {
  store.close();
}
