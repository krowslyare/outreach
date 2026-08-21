// El panel en un comando: npm run panel.
//
// Solo lectura y sin red: abre la base, junta los cuatro read-models e imprime.
// Pensado para correrlo antes de decidir qué hacer con el día.

import { Store } from "../wa/store.js";
import { lineasPanel } from "../panel/panel.js";

const LIMITE_BANDEJA = 50;
const LIMITE_EMBUDO = 200;

const store = new Store();
try {
  const ahora = new Date();
  const lineas = lineasPanel({
    ahora,
    salud: store.loadAccountHealth(ahora),
    bandeja: store.colaAtencion(LIMITE_BANDEJA),
    clientes: store.listarClientes(),
    porRevisar: store.paraRevisar(LIMITE_EMBUDO).length,
    listosParaContactar: store.candidatosParaContactar(LIMITE_EMBUDO).length,
  });
  console.info(lineas.join("\n"));
} finally {
  store.close();
}
