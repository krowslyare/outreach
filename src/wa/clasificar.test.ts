import { describe, expect, it } from "vitest";

import {
  VENTANA_AUTOMATICA_MS,
  VENTANA_AUTOMATICA_INEQUIVOCA_MS,
  VENTANA_AUTOMATICA_TARDIA_MS,
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

  it("reconoce el cierre automático observado en Tempo Skin", () => {
    const resultado = clasificarInbound(
      senales({ body: "En breve nos pondremos en contacto contigo, muchas gracias." }),
    );
    expect(resultado.clase).toBe("automatico");
  });

  it("ignora un evento buttons vacío inmediatamente posterior al saliente", () => {
    const resultado = clasificarInbound(
      senales({ body: "[buttons]", tipo: "buttons", tieneMedia: true }),
    );
    expect(resultado.clase).toBe("automatico");
    expect(resultado.motivo).toMatch(/buttons vacío/);
  });

  it("ignora eventos internos protocol sin responder a ciegas", () => {
    const resultado = clasificarInbound(
      senales({ body: "[protocol]", tipo: "protocol", tieneMedia: true }),
    );
    expect(resultado.clase).toBe("automatico");
    expect(resultado.motivo).toMatch(/protocolo/);
  });

  it("un evento buttons tardío sigue quedando para revisión humana", () => {
    const resultado = clasificarInbound(
      senales({
        body: "[buttons]",
        tipo: "buttons",
        tieneMedia: true,
        at: new Date(OUTBOUND.getTime() + VENTANA_AUTOMATICA_MS + 1),
      }),
    );
    expect(resultado.clase).toBe("humano");
  });

  it("reconoce la bienvenida tardía observada en Free Smile", () => {
    const resultado = clasificarInbound(
      senales({
        body:
          "Consultorio Free Smile le da la bienvenida, por favor nos deja saber su nombre completo? " +
          "Visite nuestra web para más información www.amparonaupari.com/registro",
        at: new Date(OUTBOUND.getTime() + 72_000),
      }),
    );

    expect(resultado.clase).toBe("automatico");
    expect(resultado.motivo).toMatch(/plantilla tardía/);
  });

  it("reconoce la bienvenida tardía observada en Los Pinos", () => {
    const resultado = clasificarInbound(
      senales({
        body:
          "Gracias por comunicarte con Clinica Odontologica Los Pinos. " +
          "¿Cómo podemos ayudarte?",
        at: new Date(OUTBOUND.getTime() + 134_000),
      }),
    );

    expect(resultado.clase).toBe("automatico");
    expect(resultado.motivo).toMatch(/plantilla tardía/);
  });

  it("una pregunta humana tardía no se confunde con la bienvenida de Los Pinos", () => {
    const resultado = clasificarInbound(
      senales({
        body: "Hola, ¿cómo podemos ayudarte?",
        at: new Date(OUTBOUND.getTime() + 134_000),
      }),
    );

    expect(resultado.clase).toBe("humano");
  });

  it("reconoce la plantilla inequívoca de Amorisa aunque llegue 87 minutos después", () => {
    const resultado = clasificarInbound(
      senales({
        body:
          "¡Hola! 👋🏼 Bienvenido(a) a Amorisa Dental Studio.\n\n" +
          "Gracias por escribirnos. Cuéntanos, ¿en qué podemos ayudarte hoy? 😊\n\n" +
          "En breve uno de nuestros asesores responderá tu mensaje.✨",
        at: new Date(OUTBOUND.getTime() + 87 * 60_000),
      }),
    );

    expect(resultado.clase).toBe("automatico");
    expect(resultado.motivo).toMatch(/plantilla inequívoca/);
  });

  it("reconoce la bienvenida tardía de Siluet con pregunta genérica", () => {
    const resultado = clasificarInbound(
      senales({
        body:
          "Gracias por comunicarte con Centro Estetico Siluet By. " +
          "Por favor, haznos saber cómo podemos ayudarte.",
        at: new Date(OUTBOUND.getTime() + 33 * 60_000),
      }),
    );

    expect(resultado.clase).toBe("automatico");
    expect(resultado.motivo).toMatch(/plantilla inequívoca/);
  });

  it("reconoce el aviso de ausencia tardío de Siluet", () => {
    const resultado = clasificarInbound(
      senales({
        body:
          "Gracias por tu mensaje. En este momento no estamos disponibles, " +
          "pero te responderemos tan pronto regresemos.",
        at: new Date(OUTBOUND.getTime() + 9 * 60_000),
      }),
    );

    expect(resultado.clase).toBe("automatico");
    expect(resultado.motivo).toMatch(/plantilla inequívoca/);
  });

  it("no trata una bienvenida humana tardía como la plantilla de Amorisa", () => {
    const resultado = clasificarInbound(
      senales({
        body: "Bienvenida a la clínica. Gracias por escribirnos, ¿de qué se trata?",
        at: new Date(OUTBOUND.getTime() + 87 * 60_000),
      }),
    );

    expect(resultado.clase).toBe("humano");
  });

  it("la plantilla inequívoca también caduca después de un día", () => {
    const resultado = clasificarInbound(
      senales({
        body:
          "Bienvenido(a) a Clínica Demo. Gracias por escribirnos. " +
          "En breve uno de nuestros asesores responderá tu mensaje.",
        at: new Date(
          OUTBOUND.getTime() + VENTANA_AUTOMATICA_INEQUIVOCA_MS + 1,
        ),
      }),
    );

    expect(resultado.clase).toBe("humano");
  });

  it("no amplía la ventana para una bienvenida humana sin el bloque observado", () => {
    const resultado = clasificarInbound(
      senales({
        body: "La doctora le da la bienvenida. ¿En qué podemos ayudarle?",
        at: new Date(OUTBOUND.getTime() + 72_000),
      }),
    );

    expect(resultado.clase).toBe("humano");
  });

  it("la plantilla tardía también caduca", () => {
    const resultado = clasificarInbound(
      senales({
        body:
          "Consultorio Free Smile le da la bienvenida. Indíquenos su nombre completo.",
        at: new Date(OUTBOUND.getTime() + VENTANA_AUTOMATICA_TARDIA_MS + 1),
      }),
    );

    expect(resultado.clase).toBe("humano");
  });

  it("reconoce el menú automático observado en Clínica Dental Olympus", () => {
    const resultado = clasificarInbound(
      senales({
        body:
          "CLÍNICA DENTAL OLYMPUS\n" +
          "Te saluda la asistente del doctor:\n" +
          "Ofrecemos atención en salud bucal especializada:\n" +
          "Limpieza dental profesional\nOrtodoncia especializada\n" +
          "Consulta especializada: S/20\n" +
          "Reserva tu cita enviando:\n" +
          "Nombres completos\nFecha de atención\nHorario deseado",
      }),
    );

    expect(resultado.clase).toBe("automatico");
    expect(resultado.motivo).toMatch(/reserva tu cita enviando/);
  });

  it("no confunde una presentación breve de la asistente con el menú automático", () => {
    const resultado = clasificarInbound(
      senales({
        body: "Hola, le saluda la asistente del doctor. ¿De qué se trata?",
      }),
    );

    expect(resultado.clase).toBe("humano");
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
