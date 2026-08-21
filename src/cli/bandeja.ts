// La cola de atención humana, en un comando.
//
//   npm run bandeja
//
// Responde una sola pregunta: ¿a quién le debo una respuesta? No abre WhatsApp
// ni llama a ningún proveedor: lee la base local y imprime. Sirve igual con el
// proceso apagado o con el número baneado, que es justo cuando más falta hace
// saber qué conversaciones quedaron colgando.

import { Store } from "../wa/store.js";
import {
  ETIQUETA_MOTIVO,
  accionParaMotivo,
  esperaHumana,
  linkChat,
  ordenarCola,
  resumir,
  unaLinea,
} from "../bandeja/bandeja.js";

const LIMITE = 50;

const store = new Store();
try {
  const filas = ordenarCola(store.colaAtencion(LIMITE));
  const resumen = resumir(filas);

  if (resumen.total === 0) {
    console.info("Nada pendiente: nadie espera una respuesta.");
    process.exit(0);
  }

  const partes: string[] = [];
  if (resumen.porMotivo.escalado > 0) partes.push(`${resumen.porMotivo.escalado} escalada(s)`);
  if (resumen.porMotivo.deuda > 0) partes.push(`${resumen.porMotivo.deuda} con deuda del bot`);
  if (resumen.porMotivo.ajeno > 0) partes.push(`${resumen.porMotivo.ajeno} fuera de campaña`);

  console.info(
    `Bandeja — ${resumen.total} conversación(es): ${partes.join(" · ")}\n`,
  );

  const ahora = new Date();
  filas.forEach((fila, indice) => {
    const espera = esperaHumana(fila.desde, ahora);
    const varios =
      fila.motivo !== "escalado" && fila.sinResolver > 1
        ? ` · ${fila.sinResolver} mensajes`
        : "";
    console.info(
      `${indice + 1} · ${ETIQUETA_MOTIVO[fila.motivo]} · esperando ${espera}${varios}`,
    );
    console.info(`    ${fila.nombre} · ${fila.e164}`);
    if (fila.ultimoEntrante.length > 0) {
      console.info(`    "${unaLinea(fila.ultimoEntrante)}"`);
    }
    console.info(`    ${accionParaMotivo(fila.motivo)}: ${linkChat(fila.e164)}\n`);
  });
} finally {
  store.close();
}
