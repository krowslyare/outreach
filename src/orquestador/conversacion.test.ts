import { describe, expect, it, vi } from "vitest";

import type { ContextoProspecto } from "../agent/prompt.js";
import type { ProveedorLLM, RespuestaLLM } from "../llm/port.js";
import type { InboundEvent } from "../wa/client.js";
import type { AccountHealth, RecipientState } from "../wa/types.js";
import {
  manejarInbound,
  type ConversacionDeps,
} from "./conversacion.js";

const E164 = "+51999111222";
const NUMERO_HUMANO = "+51999888777";
const EN_HORARIO = new Date("2026-07-27T15:00:00.000Z"); // lunes, 10:00 en Lima

const FICHA: ContextoProspecto = {
  nombre: "Clínica Ejemplo",
  distrito: "Miraflores",
  clasificacion: "Centro odontológico",
  tieneWeb: false,
  resenas: 18,
};

const ESTADO: RecipientState = {
  e164: E164,
  suppressed: false,
  humanTakeover: false,
  firstOutboundAt: null,
  lastOutboundAt: null,
  lastInboundAt: null,
  lastHumanInboundAt: null,
  followUpCount: 0,
};

const SALUD: AccountHealth = {
  dayIndex: 1,
  sentToday: 0,
  lastSentAt: null,
  deviceRate: null,
  deviceRateSample: 0,
  deviceRateBaseline: null,
  killSwitch: {
    tripped: false,
    reason: null,
    trippedAt: null,
  },
};

const RESPUESTA: RespuestaLLM = {
  corte: "fin",
  texto: "Claro, le cuento cómo funciona.",
  herramienta: null,
};

interface OpcionesDobles {
  ficha?: ContextoProspecto | null;
  inboundCreaStub?: boolean;
  estado?: Partial<RecipientState>;
  salud?: Partial<AccountHealth>;
  respuesta?: RespuestaLLM;
  historial?: Array<{ direction: "in" | "out"; body: string }>;
  now?: Date;
  ultimoOutboundAt?: Date | null;
}

let contadorEventos = 0;

function eventoInbound(
  body: string,
  overrides: Partial<InboundEvent> = {},
): InboundEvent {
  return {
    e164: E164,
    body,
    at: EN_HORARIO,
    // Único por evento: repetirlo activaría la idempotencia y las pruebas
    // medirían el corte por duplicado en vez de lo que quieren medir.
    waMessageId: `wa-in-${++contadorEventos}`,
    tipo: "chat",
    tieneMedia: false,
    citaOtroMensaje: false,
    ...overrides,
  };
}

function crearDobles(opciones: OpcionesDobles = {}) {
  const conversacion = [...(opciones.historial ?? [])];
  let ficha = opciones.ficha === undefined ? FICHA : opciones.ficha;
  const generar = vi
    .fn<ProveedorLLM["generar"]>()
    .mockResolvedValue(opciones.respuesta ?? RESPUESTA);
  const enviar = vi
    .fn<ConversacionDeps["enviar"]>()
    .mockResolvedValue("wa-mensaje-1");

  const store: ConversacionDeps["store"] = {
    // Sin saliente previo, el clasificador no tiene con qué correlacionar y
    // trata todo como humano: es el default de estos casos salvo que la prueba
    // diga otra cosa.
    ultimoOutboundAt: vi.fn(() => opciones.ultimoOutboundAt ?? null),
    recordInbound: vi.fn((e164, body) => {
      // El store real incorpora el inbound antes de cargar el historial; el
      // doble replica eso para probar el último turno que realmente ve el agente.
      expect(e164).toBe(E164);
      conversacion.push({ direction: "in", body });
      if (opciones.inboundCreaStub === true && ficha === null) {
        // Store.recordInbound crea este stub auditable para números nuevos.
        // Reproducirlo descubre si luego se confunde con una ficha de campaña.
        ficha = {
          nombre: e164,
          distrito: "",
          clasificacion: "INBOUND DESCONOCIDO",
          tieneWeb: null,
          resenas: null,
        };
      }
      return true;
    }),
    suppress: vi.fn(),
    loadRecipientState: vi.fn(() => ({
      ...ESTADO,
      ...opciones.estado,
    })),
    loadConversacion: vi.fn(() => [...conversacion]),
    loadFichaProspecto: vi.fn(() => ficha),
    loadAccountHealth: vi.fn(() => ({
      ...SALUD,
      ...opciones.salud,
      killSwitch: {
        ...SALUD.killSwitch,
        ...opciones.salud?.killSwitch,
      },
    })),
    recordOutboundLibre: vi.fn(),
    setHumanTakeover: vi.fn(),
  };

  const deps: ConversacionDeps = {
    store,
    proveedor: { nombre: "fake", generar },
    enviar,
    handoff: { numeroHumano: NUMERO_HUMANO },
    config: {
      timezone: "America/Lima",
      windowStartHour: 9,
      windowEndHour: 19,
      activeWeekdays: [1, 2, 3, 4, 5, 6],
      minGapSeconds: 180,
      maxGapSeconds: 900,
      deviceRateDropPoints: 0.15,
      deviceRateMinSample: 30,
      followUpDays: [3, 7],
      maxFollowUps: 2,
    },
    now: () => opciones.now ?? EN_HORARIO,
  };

  return { deps, store, generar, enviar };
}

describe("manejarInbound", () => {
  it("suprime un opt-out sin consultar al agente ni enviar", async () => {
    const { deps, store, generar, enviar } = crearDobles();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(
      manejarInbound(deps, eventoInbound("No me escribas más")),
    ).resolves.toEqual({ accion: "suprimido" });

    expect(store.recordInbound).toHaveBeenCalledWith(
      E164,
      "No me escribas más",
      EN_HORARIO,
      expect.objectContaining({ clase: "humano" }),
    );
    expect(store.suppress).toHaveBeenCalledWith(E164, "opt-out detectado");
    // Un opt-out es una orden absoluta: ni siquiera debe llegar al componente
    // que podría producir texto para ese destinatario.
    expect(generar).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("ignora un número sin ficha porque responder sin contexto sería improvisar", async () => {
    const { deps, generar, enviar } = crearDobles({
      ficha: null,
      inboundCreaStub: true,
    });

    await expect(
      manejarInbound(deps, eventoInbound("Hola, quisiera información")),
    ).resolves.toEqual({
      accion: "ignorado",
      razon: "número fuera de la campaña",
    });

    expect(generar).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  it("ignora una conversación con humanTakeover sin hablar encima de Hideki", async () => {
    const { deps, generar, enviar } = crearDobles({
      estado: { humanTakeover: true },
    });

    await expect(
      manejarInbound(deps, eventoInbound("¿A qué hora conversamos?")),
    ).resolves.toEqual({
      accion: "ignorado",
      razon: "conversación tomada por humano",
    });

    // Esta ausencia de efectos es la garantía principal del takeover: el bot
    // no prepara ni manda una respuesta mientras la conversación es humana.
    expect(generar).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  it("ignora un destinatario ya suprimido", async () => {
    const { deps, generar, enviar } = crearDobles({
      estado: { suppressed: true },
    });

    await expect(
      manejarInbound(deps, eventoInbound("¿Siguen ahí?")),
    ).resolves.toEqual({
      accion: "ignorado",
      razon: "destinatario suprimido",
    });

    expect(generar).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  it("responde una vez en horario hábil y registra el envío libre", async () => {
    const { deps, store, enviar } = crearDobles();

    await expect(
      manejarInbound(deps, eventoInbound("Cuénteme más")),
    ).resolves.toEqual({
      accion: "respondido",
      texto: "Claro, le cuento cómo funciona.",
    });

    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar).toHaveBeenCalledWith(
      E164,
      "Claro, le cuento cómo funciona.",
    );
    expect(store.recordOutboundLibre).toHaveBeenCalledWith(
      E164,
      "Claro, le cuento cómo funciona.",
      "wa-mensaje-1",
      EN_HORARIO,
    );
  });

  it("difiere una respuesta fuera de horario para no delatar al bot", async () => {
    const madrugada = new Date("2026-07-27T08:00:00.000Z"); // lunes, 03:00 en Lima
    const { deps, enviar } = crearDobles({ now: madrugada });

    const resultado = await manejarInbound(
      deps,
      eventoInbound("Cuénteme más", { at: madrugada }),
    );

    expect(resultado).toMatchObject({ accion: "diferido" });
    expect(resultado.accion === "diferido" && resultado.razon).toContain(
      "fuera de la ventana horaria",
    );
    expect(enviar).not.toHaveBeenCalled();
  });

  it("difiere una respuesta cuando el kill switch está activo", async () => {
    const { deps, enviar } = crearDobles({
      salud: {
        killSwitch: {
          tripped: true,
          reason: "caída de entregas",
          trippedAt: EN_HORARIO,
        },
      },
    });

    const resultado = await manejarInbound(deps, eventoInbound("Cuénteme más"));

    expect(resultado).toEqual({
      accion: "diferido",
      razon: "kill switch activo: caída de entregas",
    });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("responde aunque sentToday esté muy por encima del tope diario", async () => {
    const { deps, enviar } = crearDobles({
      salud: { dayIndex: 1, sentToday: 999 },
    });

    await expect(
      manejarInbound(deps, eventoInbound("Cuénteme más")),
    ).resolves.toMatchObject({ accion: "respondido" });

    // El tope controla iniciativa fría. Quien ya escribió dejó de ser un
    // desconocido, así que usar sentToday para callarlo sería la política equivocada.
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("escala, activa takeover y avisa al número de Hideki", async () => {
    const { deps, store, enviar } = crearDobles({
      respuesta: {
        corte: "fin",
        texto: "",
        herramienta: {
          nombre: "escalar_a_humano",
          input: {
            motivo: "pide_reunion",
            resumen: "Quiere coordinar una llamada esta semana.",
          },
        },
      },
    });

    await expect(
      manejarInbound(deps, eventoInbound("¿Podemos reunirnos?")),
    ).resolves.toEqual({
      accion: "escalado",
      motivo: "pide_reunion",
    });

    expect(store.setHumanTakeover).toHaveBeenCalledWith(E164);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar).toHaveBeenCalledWith(
      NUMERO_HUMANO,
      expect.stringContaining("Quiere coordinar una llamada esta semana."),
    );
    expect(enviar).not.toHaveBeenCalledWith(E164, expect.any(String));
  });

  it("marca perdido y suprime al prospecto sin enviar", async () => {
    const { deps, store, enviar } = crearDobles({
      respuesta: {
        corte: "fin",
        texto: "",
        herramienta: {
          nombre: "marcar_perdido",
          input: { motivo: "ya_tiene_proveedor" },
        },
      },
    });

    await expect(
      manejarInbound(deps, eventoInbound("Ya trabajamos con otra empresa")),
    ).resolves.toEqual({
      accion: "perdido",
      motivo: "ya_tiene_proveedor",
    });

    expect(store.suppress).toHaveBeenCalledWith(
      E164,
      "perdido: ya_tiene_proveedor",
    );
    expect(enviar).not.toHaveBeenCalled();
  });

  it("entrega el historial en orden y deja el inbound como último turno", async () => {
    const { deps, generar } = crearDobles({
      historial: [
        { direction: "in", body: "Primer mensaje" },
        { direction: "out", body: "Nuestra respuesta" },
      ],
    });

    await manejarInbound(deps, eventoInbound("Último mensaje"));

    const solicitud = generar.mock.calls[0]?.[0];
    const mensajes = solicitud?.mensajes;
    // El primer user es el contexto estructurado de la ficha; los siguientes
    // son la conversación y deben conservar dirección y orden cronológico.
    expect(mensajes?.slice(1)).toEqual([
      { rol: "user", texto: "Primer mensaje" },
      { rol: "assistant", texto: "Nuestra respuesta" },
      { rol: "user", texto: "Último mensaje" },
    ]);
  });
});
