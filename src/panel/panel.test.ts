import { describe, expect, it } from "vitest";

import type { AccountHealth } from "../wa/types.js";
import type { ClienteCompleto, FilaColaAtencion } from "../wa/store.js";
import { lineasPanel } from "./panel.js";

const AHORA = new Date("2026-08-21T15:00:00.000Z");

const SALUD_OK: AccountHealth = {
  dayIndex: 1,
  sentToday: 0,
  lastSentAt: null,
  deviceRate: 0.93,
  deviceRateSample: 60,
  deviceRateBaseline: 0.95,
  killSwitch: { tripped: false, reason: null, trippedAt: null },
};

function filaBandeja(
  e164: string,
  motivo: FilaColaAtencion["motivo"],
  desde: Date,
): FilaColaAtencion {
  return {
    e164,
    nombre: `Nombre ${e164}`,
    motivo,
    desde,
    ultimoEntrante: "hola",
    sinResolver: 1,
  };
}

function cliente(
  nombreComercial: string,
  estado: ClienteCompleto["estado"],
  faltantes: number,
): ClienteCompleto {
  const total = 8;
  return {
    e164: "+51999111222",
    nombreComercial,
    plan: "presencia",
    estado,
    notas: null,
    creadoEn: AHORA,
    publicadoEn: null,
    requisitos: Array.from({ length: total }, (_, i) => ({
      clave: `clave-${i}`,
      etiqueta: `etiqueta ${i}`,
      resuelto: i >= faltantes,
      resueltoEn: null,
    })),
  };
}

function panel(overrides: Partial<Parameters<typeof lineasPanel>[0]> = {}) {
  return lineasPanel({
    ahora: AHORA,
    salud: SALUD_OK,
    bandeja: [],
    clientes: [],
    porRevisar: 0,
    listosParaContactar: 0,
    ...overrides,
  }).join("\n");
}

describe("lineasPanel", () => {
  it("con todo en orden, dice que no hay nada pendiente", () => {
    const texto = panel();
    expect(texto).toContain("Kill switch inactivo");
    expect(texto).toContain("Nadie espera una respuesta.");
    expect(texto).toContain("Todavía no hay fichas.");
    expect(texto).toContain("0 prospecto(s) por revisar");
  });

  it("con el kill switch activo, eso va primero y con su motivo", () => {
    const texto = panel({
      salud: {
        ...SALUD_OK,
        killSwitch: {
          tripped: true,
          reason: "auth_failure",
          trippedAt: AHORA,
        },
      },
    });
    expect(texto).toContain("Kill switch ACTIVO: auth_failure");
    expect(texto.indexOf("Kill switch")).toBeLessThan(
      texto.indexOf("Bandeja"),
    );
  });

  it("resume la bandeja con la espera más vieja", () => {
    const texto = panel({
      bandeja: [
        filaBandeja("+51999111222", "escalado", new Date("2026-08-21T10:00:00.000Z")),
        filaBandeja("+51999222333", "deuda", new Date("2026-08-20T09:30:00.000Z")),
      ],
    });
    expect(texto).toContain("2 conversación(es)");
    expect(texto).toContain("1 escalada(s), 1 con deuda del bot");
    expect(texto).toContain("La más vieja lleva 1 d 5 h");
  });

  it("nombra al cliente con requisitos completos varado en recolección", () => {
    const texto = panel({
      clientes: [cliente("Clínica Sonrisa", "recoleccion", 0)],
    });
    expect(texto).toContain("Clínica Sonrisa: requisitos completos → construccion.");
  });
});
