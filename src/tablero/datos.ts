// Los datos del tablero, armados y listos para serializar.
//
// Es el mismo read-model que alimentan panel, bandeja y cliente — pero en
// JSON. Nada de lógica nueva de negocio acá: si un cálculo cambia (esperas,
// progreso), cambia en su módulo de origen y los tres vistas lo heredan.

import type { AccountHealth } from "../wa/types.js";
import type {
  ClienteCompleto,
  FilaColaAtencion,
} from "../wa/store.js";
import { ETIQUETA_MOTIVO, esperaHumana, linkChat } from "../bandeja/bandeja.js";
import { ETIQUETA_PLAN, progreso } from "../onboarding/requisitos.js";

/** Lo mínimo que el tablero lee del store. Puerto angosto para testear. */
export interface FuenteTablero {
  loadAccountHealth(ahora: Date): AccountHealth;
  colaAtencion(limite: number): FilaColaAtencion[];
  listarClientes(): ClienteCompleto[];
  contarPorRevisar(limite: number): number;
  contarListosParaContactar(limite: number): number;
}

export interface DatosTablero {
  cuenta: {
    killSwitchActivo: boolean;
    killSwitchMotivo: string | null;
    deviceRate: number | null;
    deviceRateMuestra: number;
    baseline: number | null;
    enviadosHoy: number;
  };
  bandeja: Array<{
    e164: string;
    nombre: string;
    motivo: string;
    etiquetaMotivo: string;
    esperaTexto: string;
    ultimoEntrante: string;
    sinResolver: number;
    link: string;
  }>;
  clientes: Array<{
    e164: string;
    nombreComercial: string;
    estado: string;
    planEtiqueta: string;
    listos: number;
    total: number;
    pct: number;
    faltantes: Array<{ clave: string; etiqueta: string }>;
  }>;
  embudo: { porRevisar: number; listosParaContactar: number };
}

const LIMITE_BANDEJA = 50;
const LIMITE_EMBUDO = 200;

export function datosTablero(
  fuente: FuenteTablero,
  ahora: Date,
): DatosTablero {
  const salud = fuente.loadAccountHealth(ahora);
  const cola = fuente.colaAtencion(LIMITE_BANDEJA);
  const clientes = fuente.listarClientes().map((ficha) => {
    const p = progreso(ficha.requisitos);
    return {
      e164: ficha.e164,
      nombreComercial: ficha.nombreComercial,
      estado: ficha.estado,
      planEtiqueta: ETIQUETA_PLAN[ficha.plan],
      listos: p.listos,
      total: p.total,
      pct: p.total === 0 ? 0 : Math.round((p.listos / p.total) * 100),
      faltantes: p.faltantes.map(({ clave, etiqueta }) => ({ clave, etiqueta })),
    };
  });

  return {
    cuenta: {
      killSwitchActivo: salud.killSwitch.tripped,
      killSwitchMotivo: salud.killSwitch.reason,
      deviceRate: salud.deviceRate,
      deviceRateMuestra: salud.deviceRateSample,
      baseline: salud.deviceRateBaseline,
      enviadosHoy: salud.sentToday,
    },
    bandeja: cola.map((fila) => ({
      e164: fila.e164,
      nombre: fila.nombre,
      motivo: fila.motivo,
      etiquetaMotivo: ETIQUETA_MOTIVO[fila.motivo],
      esperaTexto: esperaHumana(fila.desde, ahora),
      ultimoEntrante: fila.ultimoEntrante,
      sinResolver: fila.sinResolver,
      link: linkChat(fila.e164),
    })),
    clientes,
    embudo: {
      porRevisar: fuente.contarPorRevisar(LIMITE_EMBUDO),
      listosParaContactar: fuente.contarListosParaContactar(LIMITE_EMBUDO),
    },
  };
}
