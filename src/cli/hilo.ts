// La conversación completa con un número, para leerla antes de contestar.
//
//   npm run hilo +51987654321
//
// La bandeja muestra el último mensaje; esto muestra TODO el hilo en orden,
// con quién dijo qué, cuándo, qué llegó de un autorespondedor y qué envío
// falló. Es el contexto que falta cuando vas a responder a mano desde el link
// de wa.me y no quieres hacerlo a ciegas.

import { Store } from "../wa/store.js";

const E164 = /^\+51\d{9}$/;

const e164 = process.argv[2]?.trim();
if (e164 === undefined || !E164.test(e164)) {
  throw new Error(
    "uso: npm run hilo -- +51987654321",
  );
}

const FORMATO = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const store = new Store();
try {
  const ficha = store.loadFichaProspecto(e164);
  const filas = store.transcripcion(e164);
  if (filas.length === 0) {
    console.info(`Sin mensajes registrados con ${e164}.`);
    process.exit(0);
  }

  console.info(
    `Hilo con ${ficha?.nombre ?? "(sin ficha)"} · ${e164} — ${filas.length} mensaje(s)\n`,
  );

  for (const fila of filas) {
    const quien =
      fila.direction === "in"
        ? fila.clase === "automatico"
          ? "autoresp."
          : "prospecto "
        : "nosotros  ";
    console.info(`${FORMATO.format(fila.momento)}  ${quien}  ${fila.body.split("\n").join("\n              ")}`);
    if (fila.error !== null) {
      console.info(`              ⚠ error al enviar: ${fila.error}`);
    }
  }
} finally {
  store.close();
}
