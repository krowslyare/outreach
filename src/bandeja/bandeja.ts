// La mitad humana del circuito de respuestas.
//
// El bot contesta solo mientras hay proceso vivo; todo lo que necesita a una
// persona vive acá: conversaciones escaladas que nadie respondió, entrantes que
// quedaron debiéndose y números ajenos a la campaña que escribieron igual.
//
// Es un read-model puro sobre las filas del store: no llama a WhatsApp ni al
// LLM, así que funciona con el canal bloqueado, con el proceso apagado o desde
// una copia de la base. Eso es a propósito: la deuda con un prospecto no
// desaparece porque el canal esté caído.

import type { FilaColaAtencion } from "../wa/store.js";

export type MotivoBandeja = FilaColaAtencion["motivo"];

/** Etiqueta corta para agrupar visualmente la cola. */
export const ETIQUETA_MOTIVO: Record<MotivoBandeja, string> = {
  escalado: "ESCALADA A TI",
  deuda: "DEUDA DEL BOT",
  ajeno: "FUERA DE CAMPAÑA",
};

/**
 * Qué se supone que haga quien lee la bandeja. Una línea por motivo; si la
 * acción cambia algún día, cambia acá y no en el render.
 */
export function accionParaMotivo(motivo: MotivoBandeja): string {
  switch (motivo) {
    case "escalado":
      return "Responde tú";
    case "deuda":
      return "El bot las contesta al correr: npm run campana -- --escuchar";
    case "ajeno":
      return "Número ajeno a la campaña: decide si respondes a mano.";
  }
}

/**
 * Espera en unidades que una persona usa, no en ISO. De más grande a más chico:
 * días y horas, horas y minutos, minutos. Menos de un minuto es ruido, pero un
 * reloj adelantado no debe imprimir negativos.
 */
export function esperaHumana(desde: Date, ahora: Date): string {
  const segundos = Math.max(0, Math.floor((ahora.getTime() - desde.getTime()) / 1000));
  if (segundos < 60) return "menos de un minuto";

  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `${minutos} min`;

  const horas = Math.floor(minutos / 60);
  if (horas < 24) {
    const resto = minutos % 60;
    return resto === 0 ? `${horas} h` : `${horas} h ${String(resto).padStart(2, "0")} min`;
  }

  const dias = Math.floor(horas / 24);
  const restoHoras = horas % 24;
  return restoHoras === 0 ? `${dias} d` : `${dias} d ${restoHoras} h`;
}

/** El mensaje tal cual llegó, recortado a una línea para no romper el layout. */
export function unaLinea(texto: string, maximo = 72): string {
  const plano = texto.replace(/\s+/g, " ").trim();
  if (plano.length <= maximo) return plano;
  return `${plano.slice(0, maximo - 1)}…`;
}

/** Link directo al chat, mismo formato que usa el aviso de handoff. */
export function linkChat(e164: string): string {
  return `https://wa.me/${e164.replace(/^\+/, "")}`;
}

/**
 * Ordena de lo más viejo a lo más nuevo. La consulta ya sale ordenada del
 * store, pero la bandeja también se alimenta de pruebas y de futuras fuentes;
 * el orden es parte del contrato de este módulo, no del SQL.
 */
export function ordenarCola(
  filas: readonly FilaColaAtencion[],
): FilaColaAtencion[] {
  return [...filas].sort(
    (a, b) => a.desde.getTime() - b.desde.getTime() || a.e164.localeCompare(b.e164),
  );
}

export interface ResumenBandeja {
  total: number;
  porMotivo: Record<MotivoBandeja, number>;
}

/** Conteos por motivo, para el encabezado. Cero en todo si no hay nada. */
export function resumir(filas: readonly FilaColaAtencion[]): ResumenBandeja {
  const porMotivo: Record<MotivoBandeja, number> = {
    escalado: 0,
    deuda: 0,
    ajeno: 0,
  };
  for (const fila of filas) porMotivo[fila.motivo] += 1;
  return { total: filas.length, porMotivo };
}

/**
 * El desglose como frases cortas ("2 escalada(s), 1 con deuda del bot"), listo
 * para encabezados. Lo usan la bandeja y el panel; que los dos digan lo mismo
 * NO es casualidad.
 */
export function partesResumen(filas: readonly FilaColaAtencion[]): string[] {
  const { porMotivo } = resumir(filas);
  const partes: string[] = [];
  if (porMotivo.escalado > 0) partes.push(`${porMotivo.escalado} escalada(s)`);
  if (porMotivo.deuda > 0) partes.push(`${porMotivo.deuda} con deuda del bot`);
  if (porMotivo.ajeno > 0) partes.push(`${porMotivo.ajeno} fuera de campaña`);
  return partes;
}
