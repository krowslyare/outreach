import { describe, expect, it } from "vitest";

import { auditarMensaje } from "./auditoria.js";

const CONTEXTO = {
  clasificacion: "CENTRO ODONTOLOGICO",
  aperturasRecientes: [],
};

describe("auditarMensaje", () => {
  it.each([
    "Atendemos a CENTRO ODONTOLOGICO de Lima.",
    "Trabajo con consultorios y de otros profesionales.",
    "Es para profesionales de la salud de Miraflores.",
  ])("rechaza taxonomía cruda: %s", (mensaje) => {
    expect(auditarMensaje(mensaje, CONTEXTO)).toEqual({
      ok: false,
      motivos: expect.arrayContaining([
        expect.stringContaining("taxonomía cruda"),
      ]),
    });
  });

  it("rechaza palabras largas en mayúscula sostenida", () => {
    expect(
      auditarMensaje("Le escribo de Kurogrid para su CLINICA.", CONTEXTO),
    ).toEqual({
      ok: false,
      motivos: ["contiene mayúscula sostenida no permitida: CLINICA"],
    });
  });

  it("permite las siglas expresamente aceptadas", () => {
    expect(
      auditarMensaje(
        "Le escribo de Kurogrid por el RUC de Consultores EIRL.",
        CONTEXTO,
      ),
    ).toEqual({ ok: true });
  });

  it("rechaza una falsa especialización en el rubro", () => {
    expect(
      auditarMensaje(
        "Ayudamos a clínicas veterinarias a presentar sus servicios.",
        {
          clasificacion: "CLÍNICAS VETERINARIAS",
          aperturasRecientes: [],
        },
      ),
    ).toEqual({
      ok: false,
      motivos: ["insinúa especialización o experiencia previa en el rubro"],
    });
    expect(
      auditarMensaje(
        "Diseñamos y mantenemos webs a medida para clínicas dentales.",
        CONTEXTO,
      ),
    ).toEqual({
      ok: false,
      motivos: ["insinúa especialización o experiencia previa en el rubro"],
    });
  });

  it("permite personalizar la propuesta para el negocio concreto", () => {
    expect(
      auditarMensaje(
        "Tenemos una idea para Clínica Patitas: mostrar juntos sus servicios y horarios.",
        {
          clasificacion: "CLÍNICAS VETERINARIAS",
          aperturasRecientes: [],
        },
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    "El plan cuesta S/ 500.",
    "El servicio cuesta soles 500.",
    "La mensualidad mensual sería 500.",
  ])("rechaza precio en el primer contacto: %s", (mensaje) => {
    expect(auditarMensaje(mensaje, CONTEXTO)).toEqual({
      ok: false,
      motivos: ["menciona un precio en el primer contacto"],
    });
  });

  it("rechaza mensajes de más de 700 caracteres", () => {
    const resultado = auditarMensaje("a".repeat(701), CONTEXTO);
    expect(resultado).toEqual({
      ok: false,
      motivos: ["supera el máximo de 700 caracteres (701)"],
    });
  });

  it("rechaza aperturas iguales ignorando acentos y puntuación", () => {
    const resultado = auditarMensaje(
      "Clínica del Niño, le escribo de Kurogrid para consultar algo.",
      {
        clasificacion: "POLICLINICOS",
        aperturasRecientes: [
          "Clinica del nino le escribo: anteriormente usamos otra apertura.",
        ],
      },
    );
    expect(resultado).toEqual({
      ok: false,
      motivos: [
        "repite las primeras cinco palabras de una apertura reciente",
      ],
    });
  });

  it("exige una sola pregunta al final del primer contacto", () => {
    expect(
      auditarMensaje(
        "¿Hoy coordinan por WhatsApp? Nosotros hacemos y mantenemos la web.",
        { ...CONTEXTO, paso: "first" },
      ),
    ).toEqual({
      ok: false,
      motivos: ["la pregunta del primer contacto debe ir al final"],
    });

    expect(
      auditarMensaje(
        "Le escribo de Kurogrid. ¿Coordinan por WhatsApp? ¿Le cuento la idea?",
        { ...CONTEXTO, paso: "first" },
      ),
    ).toEqual({
      ok: false,
      motivos: ["el primer contacto debe tener una sola pregunta (2)"],
    });
  });

  it("limita el primer contacto a 320 caracteres", () => {
    expect(
      auditarMensaje(`${"a".repeat(320)}?`, {
        ...CONTEXTO,
        paso: "first",
      }),
    ).toEqual({
      ok: false,
      motivos: ["el primer contacto supera 320 caracteres (321)"],
    });
  });

  it("reserva mensualidad y pago inicial para la apertura modelo", () => {
    const texto =
      "Le escribo de Kurogrid. Diseñamos la web sin pago inicial por el desarrollo y la mantenemos por una mensualidad. ¿Le cuento?";

    expect(
      auditarMensaje(texto, {
        ...CONTEXTO,
        paso: "first",
        intencionApertura: "permiso",
      }),
    ).toEqual({
      ok: false,
      motivos: [
        "la apertura permiso repite el ángulo comercial reservado para modelo",
      ],
    });
    expect(
      auditarMensaje(texto, {
        ...CONTEXTO,
        paso: "first",
        intencionApertura: "modelo",
      }),
    ).toEqual({ ok: true });
  });

  it("acepta un mensaje que no activa ninguna regla", () => {
    expect(
      auditarMensaje(
        "Le escribo de Kurogrid por su centro odontológico. ¿Con quién podría conversarlo?",
        CONTEXTO,
      ),
    ).toEqual({ ok: true });
  });
});

describe("formatos de precio peruanos", () => {
  // Un precio colado en la apertura rompe la regla dura de no cotizar antes de
  // que exista interés, así que la detección tiene que cubrir cómo se escribe
  // de verdad en Perú, no solo la forma canónica.
  it.each([
    "Le dejo la web por S/. 500 al mes",
    "Son 500 soles mensuales",
    "Cuesta S/199",
    "Serían 199 soles",
    "La mensualidad es de 449",
    "Son S/ 649 cada mes",
  ])("rechaza el precio escrito como: %s", (texto) => {
    const resultado = auditarMensaje(texto, CONTEXTO);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.motivos.join(" ")).toMatch(/precio/i);
  });

  it("no confunde un número inocente con un precio", () => {
    const resultado = auditarMensaje(
      "Le escribo de Kurogrid. ¿Atienden en 2 sedes o solo en una?",
      CONTEXTO,
    );
    expect(resultado.ok).toBe(true);
  });
});
