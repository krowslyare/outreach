import { describe, expect, it } from "vitest";

import {
  VENTANA_AUTOMATICA_MS,
  clasificarInbound,
  type SenalesInbound,
} from "./clasificar.js";

const OUTBOUND = new Date("2026-03-02T15:00:00.000Z");

function senales(overrides: Partial<SenalesInbound> = {}): SenalesInbound {
  return {
    body: "Gracias por comunicarte con nosotros, en breve te atenderemos.",
    tipo: "chat",
    tieneMedia: false,
    citaOtroMensaje: false,
    at: new Date(OUTBOUND.getTime() + 2_000),
    ultimoOutboundAt: OUTBOUND,
    ...overrides,
  };
}

describe("clasificarInbound", () => {
  it("reconoce el saludo de bienvenida que llega a los segundos", () => {
    expect(clasificarInbound(senales()).clase).toBe("automatico");
  });

  it("reconoce el mensaje de ausencia fuera de horario", () => {
    const resultado = clasificarInbound(
      senales({
        body:
          "En estos momentos no podemos atenderte. Nuestro horario de atención " +
          "es de lunes a viernes de 9am a 6pm.",
      }),
    );
    expect(resultado.clase).toBe("automatico");
  });

  // Las cuatro reglas de abajo son la razón de ser del módulo: el error caro es
  // tratar a una persona como robot, así que cada veto se testea por separado.
  it("una cita a nuestro mensaje es humana aunque el texto parezca plantilla", () => {
    const resultado = clasificarInbound(senales({ citaOtroMensaje: true }));
    expect(resultado.clase).toBe("humano");
  });

  it("un audio es humano aunque llegue instantáneo", () => {
    expect(clasificarInbound(senales({ tipo: "ptt", body: "" })).clase).toBe(
      "humano",
    );
  });

  it("una imagen con caption de plantilla sigue siendo humana", () => {
    expect(clasificarInbound(senales({ tieneMedia: true })).clase).toBe("humano");
  });

  it("sin saliente previo no hay ventana que medir: humano", () => {
    expect(clasificarInbound(senales({ ultimoOutboundAt: null })).clase).toBe(
      "humano",
    );
  });

  it("la misma plantilla fuera de la ventana es humana", () => {
    const resultado = clasificarInbound(
      senales({
        at: new Date(OUTBOUND.getTime() + VENTANA_AUTOMATICA_MS + 1),
      }),
    );
    expect(resultado.clase).toBe("humano");
  });

  it("un timestamp anterior al saliente no se clasifica como automático", () => {
    const resultado = clasificarInbound(
      senales({ at: new Date(OUTBOUND.getTime() - 1_000) }),
    );
    expect(resultado.clase).toBe("humano");
    expect(resultado.motivo).toMatch(/anterior/);
  });

  // El caso que hizo descartar "latencia sola = automático": una secretaria
  // mirando el chat contesta más rápido que muchos autorespondedores.
  it("una respuesta humana rapidísima no es un autorespondedor", () => {
    const resultado = clasificarInbound(
      senales({
        body: "¿De qué se trata?",
        at: new Date(OUTBOUND.getTime() + 3_000),
      }),
    );
    expect(resultado.clase).toBe("humano");
    expect(resultado.motivo).toMatch(/plantilla/);
  });

  it("un interés inmediato no se confunde con plantilla", () => {
    const resultado = clasificarInbound(
      senales({
        body: "Hola, sí me interesa. ¿Cuánto sería?",
        at: new Date(OUTBOUND.getTime() + 5_000),
      }),
    );
    expect(resultado.clase).toBe("humano");
  });

  it("un saludo humano corto y rápido no es plantilla", () => {
    for (const body of ["Buenas", "Hola", "Sí?", "Dígame", "Con quién hablo"]) {
      expect(clasificarInbound(senales({ body })).clase).toBe("humano");
    }
  });
});
