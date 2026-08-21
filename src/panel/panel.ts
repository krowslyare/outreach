// El resumen de la mañana, en un comando.
//
// Tres preguntas, en el orden en que importan:
//   1. ¿Puedo operar hoy? (kill switch, salud del número)
//   2. ¿A quién le debo algo? (la bandeja, resumida)
//   3. ¿Dónde está el negocio? (clientes y embudo)
//
// Es un read-model puro: recibe datos y devuelve líneas. El CLI es el que toca
// el store; así el formato se testea sin base ni reloj.

import type { AccountHealth } from "../wa/types.js";
import type { FilaColaAtencion, ClienteCompleto } from "../wa/store.js";
import { esperaHumana, partesResumen } from "../bandeja/bandeja.js";
import { progreso } from "../onboarding/requisitos.js";

export interface DatosPanel {
  ahora: Date;
  salud: AccountHealth;
  bandeja: readonly FilaColaAtencion[];
  clientes: readonly ClienteCompleto[];
  /** Prospectos con web "no se sabe", esperando revisión manual. */
  porRevisar: number;
  /** Aprobados y elegibles que la campaña puede contactar. */
  listosParaContactar: number;
}

const FECHA = new Intl.DateTimeFormat("es-PE", {
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

function lineasSalud(salud: AccountHealth): string[] {
  if (salud.killSwitch.tripped) {
    return [
      "Cuenta",
      `  Kill switch ACTIVO: ${salud.killSwitch.reason ?? "sin detalle"}.`,
      "  Nada envía hasta levantarlo a mano. Revisar antes de operar.",
    ];
  }
  const tasa =
    salud.deviceRate === null
      ? "sin muestra todavía"
      : `${(salud.deviceRate * 100).toFixed(0)}% de ACK_DEVICE ` +
        `(muestra ${salud.deviceRateSample}` +
        (salud.deviceRateBaseline !== null
          ? `, baseline ${(salud.deviceRateBaseline * 100).toFixed(0)}%`
          : "") +
        ")";
  return ["Cuenta", `  Kill switch inactivo · deviceRate: ${tasa}.`];
}

function lineasBandeja(
  bandeja: readonly FilaColaAtencion[],
  ahora: Date,
): string[] {
  if (bandeja.length === 0) {
    return ["Bandeja", "  Nadie espera una respuesta."];
  }
  const masVieja = bandeja.reduce((a, b) => (a.desde <= b.desde ? a : b));
  return [
    "Bandeja",
    `  ${bandeja.length} conversación(es): ${partesResumen(bandeja).join(", ")}.` +
      ` La más vieja lleva ${esperaHumana(masVieja.desde, ahora)}.`,
    "  Detalle: npm run bandeja",
  ];
}

function lineasClientes(clientes: readonly ClienteCompleto[]): string[] {
  if (clientes.length === 0) {
    return [
      "Clientes",
      "  Todavía no hay fichas. Se abren con npm run cliente.",
    ];
  }
  const activos = clientes.filter((c) => c.estado !== "baja");
  const publicados = clientes.filter((c) => c.estado === "publicado").length;

  // El atasco típico del onboarding: requisitos completos pero la ficha no se
  // movió. Nombrarlo convierte un dato en una acción.
  const varados = clientes.filter(
    (c) =>
      c.estado === "recoleccion" &&
      progreso(c.requisitos).faltantes.length === 0,
  );

  const lineas = [
    "Clientes",
    `  ${activos.length} activo(s) de ${clientes.length} · ${publicados} publicado(s).`,
  ];
  for (const cliente of varados.slice(0, 3)) {
    lineas.push(
      `  ${cliente.nombreComercial}: requisitos completos → construccion.`,
    );
  }
  return lineas;
}

/** Las líneas del panel, listas para imprimir. */
export function lineasPanel(datos: DatosPanel): string[] {
  return [
    `Panel — ${FECHA.format(datos.ahora)}`,
    "",
    ...lineasSalud(datos.salud),
    "",
    ...lineasBandeja(datos.bandeja, datos.ahora),
    "",
    ...lineasClientes(datos.clientes),
    "",
    "Embudo",
    `  ${datos.porRevisar} prospecto(s) por revisar (web sin verificar).`,
    `  ${datos.listosParaContactar} aprobado(s) listo(s) para campaña.`,
  ];
}
