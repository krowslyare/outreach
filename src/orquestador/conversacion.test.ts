import { describe, expect, it, vi } from "vitest";

import type { ContextoProspecto } from "../agent/prompt.js";
import type { ProveedorLLM, RespuestaLLM } from "../llm/port.js";
import type { InboundEvent } from "../wa/client.js";
import type { AccountHealth, RecipientState } from "../wa/types.js";
import {
  atenderNumero,
  manejarInbound,
  reintentarPendientes,
  type ConversacionDeps,
} from "./conversacion.js";

const E164 = "+51999111222";
const NUMERO_HUMANO = "+51999888777";
const EN_HORARIO = new Date("2026-07-27T15:00:00.000Z"); // lunes, 10:00 en Lima

const FICHA: ContextoProspecto = {
  nombre: "Clínica Ejemplo",
  distrito: "Miraflores",
  clasificacion: "Centro odontológico",
  vertical: "dental",
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
  pendientes?: Array<{ e164: string; waMessageId: string; at: Date }>;
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
          vertical: null,
          tieneWeb: null,
          resenas: null,
        };
      }
      return "nuevo" as const;
    }),
    suppress: vi.fn(),
    marcarInboundAtendido: vi.fn(),
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
    // Honra el filtro por número como el store real: ahora la consulta ocurre
    // dentro del candado y el filtro es parte de la garantía, no un detalle.
    inboundsPendientes: vi.fn((_limite: number, soloE164?: string) => {
      const todos = opciones.pendientes ?? [];
      return soloE164 === undefined
        ? todos
        : todos.filter((p) => p.e164 === soloE164);
    }),
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
  it("no manda una respuesta vieja si llega otro mensaje mientras compone", async () => {
    const { deps, store, enviar } = crearDobles({
      pendientes: [{ e164: E164, waMessageId: "wa-primero", at: EN_HORARIO }],
      historial: [{ direction: "in", body: "¿Me cuenta cómo funciona?" }],
    });
    let lecturas = 0;
    vi.mocked(store.inboundsPendientes).mockImplementation((_limite, soloE164) => {
      lecturas += 1;
      const primero = { e164: E164, waMessageId: "wa-primero", at: EN_HORARIO };
      const segundo = { e164: E164, waMessageId: "wa-segundo", at: EN_HORARIO };
      const pendientes = lecturas === 1 ? [primero] : [primero, segundo];
      return soloE164 === undefined
        ? pendientes
        : pendientes.filter((pendiente) => pendiente.e164 === soloE164);
    });

    await expect(atenderNumero(deps, E164)).resolves.toEqual({
      accion: "diferido",
      razon: "llegó otro mensaje mientras se componía la respuesta",
    });

    expect(enviar).not.toHaveBeenCalled();
    expect(store.marcarInboundAtendido).not.toHaveBeenCalled();
  });

  it("cancela la respuesta si el humano toma el chat mientras el modelo compone", async () => {
    const { deps, store, generar, enviar } = crearDobles({
      pendientes: [{ e164: E164, waMessageId: "wa-takeover", at: EN_HORARIO }],
      historial: [{ direction: "in", body: "Hola, buenas tardes" }],
    });
    let lecturasEstado = 0;
    vi.mocked(store.loadRecipientState).mockImplementation(() => ({
      ...ESTADO,
      humanTakeover: lecturasEstado++ > 0,
    }));

    await expect(atenderNumero(deps, E164)).resolves.toEqual({
      accion: "ignorado",
      razon: "conversación tomada por humano",
    });

    expect(generar).toHaveBeenCalledTimes(1);
    expect(enviar).not.toHaveBeenCalled();
    expect(store.recordOutboundLibre).not.toHaveBeenCalled();
  });

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

  it("sella un mensaje vacío sin consultar al agente ni hacer handoff", async () => {
    const { deps, store, generar, enviar } = crearDobles();

    await expect(manejarInbound(deps, eventoInbound(""))).resolves.toEqual({
      accion: "ignorado",
      razon: "mensaje sin contenido legible",
    });

    expect(store.recordInbound).toHaveBeenCalledWith(
      E164,
      "",
      EN_HORARIO,
      expect.objectContaining({ clase: "humano" }),
    );
    expect(store.marcarInboundAtendido).toHaveBeenCalled();
    expect(generar).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
    expect(store.setHumanTakeover).not.toHaveBeenCalled();
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
    const { deps, store, enviar } = crearDobles({ now: madrugada });

    const resultado = await manejarInbound(
      deps,
      eventoInbound("Cuénteme más", { at: madrugada }),
    );

    expect(resultado).toMatchObject({ accion: "diferido" });
    expect(resultado.accion === "diferido" && resultado.razon).toContain(
      "fuera de la ventana horaria",
    );
    expect(enviar).not.toHaveBeenCalled();
    // No se envió nada, así que la respuesta se sigue debiendo: marcarlo
    // atendido lo descartaría para siempre en la próxima reconexión.
    expect(store.marcarInboundAtendido).not.toHaveBeenCalled();
  });

  // El P1 del review: si el LLM, el handoff o el envío fallan DESPUÉS de que la
  // fila se guardó, el evento no puede quedar marcado como atendido — si no, una
  // reconexión lo descarta por duplicado y el prospecto nunca recibe respuesta.
  it("no marca atendido un inbound cuyo procesamiento falló", async () => {
    const { deps, store, enviar } = crearDobles();
    enviar.mockRejectedValueOnce(new Error("WhatsApp se cayó"));

    await expect(
      manejarInbound(deps, eventoInbound("Sí, me interesa")),
    ).rejects.toThrow("WhatsApp se cayó");

    expect(store.marcarInboundAtendido).not.toHaveBeenCalled();
  });

  it("marca atendido un inbound que llegó a un final", async () => {
    const { deps, store } = crearDobles();
    const evento = eventoInbound("Cuénteme más");

    await manejarInbound(deps, evento);

    expect(store.marcarInboundAtendido).toHaveBeenCalledWith(
      evento.waMessageId,
      EN_HORARIO,
    );
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

  it("escala, activa takeover, avisa al humano y le responde al prospecto", async () => {
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
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(enviar).toHaveBeenCalledWith(
      NUMERO_HUMANO,
      expect.stringContaining("Quiere coordinar una llamada esta semana."),
    );
    // Antes esta línea afirmaba lo contrario —que al prospecto NO se le
    // escribía— y por eso el "me interesa" quedaba sin respuesta hasta que un
    // humano abriera WhatsApp.
    expect(enviar).toHaveBeenCalledWith(
      E164,
      expect.stringContaining("¿Cómo prefiere"),
    );
  });

  it("contesta una duda concreta en el mismo mensaje que ejecuta el handoff", async () => {
    const respuestaConcreta =
      "La opción que reúne todo eso es Empresa + — S/ 649 mensual.";
    const { deps, enviar } = crearDobles({
      respuesta: {
        corte: "fin",
        texto: "",
        herramienta: {
          nombre: "escalar_a_humano",
          input: {
            motivo: "quiere_contratar",
            resumen: "Quiere todo y preguntó el precio.",
            respuesta_concreta: respuestaConcreta,
          },
        },
      },
    });

    await expect(
      manejarInbound(deps, eventoInbound("Todo si es posible, ¿es caro?")),
    ).resolves.toEqual({
      accion: "escalado",
      motivo: "quiere_contratar",
    });

    expect(
      enviar.mock.calls.some(
        ([destino, texto]) =>
          destino === E164 && texto.startsWith(respuestaConcreta),
      ),
    ).toBe(true);
    expect(enviar).toHaveBeenCalledWith(
      E164,
      expect.stringContaining("¿Cómo prefiere"),
    );
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

describe("las puertas cubren también el handoff", () => {
  const FUERA_DE_HORARIO = new Date("2026-07-28T04:00:00.000Z"); // 23:00 en Lima

  // REGRESIÓN: el handoff pasó a mandarle un acuse al prospecto, y el bloque de
  // escalamiento corría ANTES de las puertas. Con eso, un "me interesa" a las
  // 3am producía un mensaje automático a las 3am.
  it("un escalamiento fuera de horario no envía nada", async () => {
    const { deps, enviar, store } = crearDobles({
      now: FUERA_DE_HORARIO,
      respuesta: {
        corte: "fin",
        texto: "",
        herramienta: {
          nombre: "escalar_a_humano",
          input: { motivo: "quiere_contratar", resumen: "Quiere contratar." },
        },
      },
    });

    await expect(
      manejarInbound(deps, eventoInbound("Me interesa")),
    ).resolves.toMatchObject({ accion: "diferido" });

    expect(enviar).not.toHaveBeenCalled();
    // Sin lock: la conversación no se tomó, así que al abrir la ventana el
    // barrido puede volver a decidir y esta vez sí escalar.
    expect(store.setHumanTakeover).not.toHaveBeenCalled();
    // Sin marcar: la deuda tiene que seguir viva.
    expect(store.marcarInboundAtendido).not.toHaveBeenCalled();
  });

  // Con el kill switch activo eran DOS envíos desde una cuenta que hay que
  // dejar quieta: el aviso al humano y el acuse al prospecto.
  it("con el kill switch activo no envía ni escala", async () => {
    const { deps, enviar, generar } = crearDobles({
      salud: {
        killSwitch: { tripped: true, reason: "caída de entrega", trippedAt: EN_HORARIO },
      },
    });

    await expect(
      manejarInbound(deps, eventoInbound("Me interesa")),
    ).resolves.toMatchObject({ accion: "diferido" });

    expect(enviar).not.toHaveBeenCalled();
    // Tampoco se gasta una llamada al LLM cuyo resultado no se podría usar.
    expect(generar).not.toHaveBeenCalled();
  });
});

describe("reintentarPendientes", () => {
  const FUERA_DE_HORARIO = new Date("2026-07-28T04:00:00.000Z"); // 23:00 en Lima

  function pendiente(id: string) {
    return { e164: E164, waMessageId: id, at: EN_HORARIO };
  }

  // Éste es el caso que motivó todo: escribió 21:40, la ventana estaba cerrada,
  // el mensaje quedó sin marcar "para reintentarlo" y nadie lo reintentaba.
  it("contesta al abrir la ventana lo que quedó diferido", async () => {
    const { deps, enviar, store } = crearDobles({
      pendientes: [pendiente("wa-in-diferido")],
      historial: [{ direction: "in", body: "¿Cuánto cuesta?" }],
    });

    await expect(reintentarPendientes(deps)).resolves.toEqual({
      numeros: 1,
      respondidos: 1,
      siguenDiferidos: 0,
    });

    expect(enviar).toHaveBeenCalledTimes(1);
    expect(store.marcarInboundAtendido).toHaveBeenCalledWith(
      "wa-in-diferido",
      EN_HORARIO,
    );
  });

  // Tres mensajes seguidos merecen UNA respuesta que los lea a los tres, no
  // tres respuestas encadenadas que se leen como un bot atragantado.
  it("agrupa varios pendientes del mismo número en una sola respuesta", async () => {
    const { deps, enviar, generar, store } = crearDobles({
      pendientes: [pendiente("wa-1"), pendiente("wa-2"), pendiente("wa-3")],
      historial: [
        { direction: "in", body: "Hola" },
        { direction: "in", body: "¿quién habla?" },
        { direction: "in", body: "¿cuánto cuesta?" },
      ],
    });

    await expect(reintentarPendientes(deps)).resolves.toEqual({
      numeros: 1,
      respondidos: 1,
      siguenDiferidos: 0,
    });

    expect(generar).toHaveBeenCalledTimes(1);
    expect(enviar).toHaveBeenCalledTimes(1);
    // Los tres se saldan con esa única respuesta; si no, reaparecen para siempre.
    for (const id of ["wa-1", "wa-2", "wa-3"]) {
      expect(store.marcarInboundAtendido).toHaveBeenCalledWith(id, EN_HORARIO);
    }
  });

  // Si sigue fuera de horario, la deuda tiene que seguir viva.
  it("no marca nada si la respuesta se vuelve a diferir", async () => {
    const { deps, enviar, store } = crearDobles({
      pendientes: [pendiente("wa-in-diferido")],
      historial: [{ direction: "in", body: "¿Cuánto cuesta?" }],
      now: FUERA_DE_HORARIO,
    });

    await expect(reintentarPendientes(deps)).resolves.toEqual({
      numeros: 1,
      respondidos: 0,
      siguenDiferidos: 1,
    });

    expect(enviar).not.toHaveBeenCalled();
    expect(store.marcarInboundAtendido).not.toHaveBeenCalled();
  });

  // Un barrido que tarda más que su intervalo se solapa con el siguiente: los
  // dos tomaban la misma foto y el segundo mandaba una respuesta duplicada. Un
  // mensaje repetido es la señal más clara de que del otro lado hay un bot.
  it("dos barridos solapados no contestan dos veces", async () => {
    const { deps, enviar, store } = crearDobles({
      pendientes: [pendiente("wa-solapado")],
      historial: [{ direction: "in", body: "¿Cuánto cuesta?" }],
    });
    // El doble simula el store real: lo marcado deja de estar pendiente.
    const atendidos = new Set<string>();
    vi.mocked(store.marcarInboundAtendido).mockImplementation((id) => {
      atendidos.add(id);
    });
    vi.mocked(store.inboundsPendientes).mockImplementation((_limite, soloE164) =>
      [pendiente("wa-solapado")].filter(
        (p) =>
          !atendidos.has(p.waMessageId) &&
          (soloE164 === undefined || p.e164 === soloE164),
      ),
    );

    await Promise.all([reintentarPendientes(deps), reintentarPendientes(deps)]);

    expect(enviar).toHaveBeenCalledTimes(1);
  });

  // atender compone con el historial COMPLETO, así que cubre todo lo pendiente
  // en ese momento. Saldar solo una parte hacía que el resto disparara otra
  // respuesta después, ya contestada.
  it("salda todos los pendientes del número, no solo los de la foto", async () => {
    const { deps, store } = crearDobles({
      pendientes: [pendiente("wa-1"), pendiente("wa-2"), pendiente("wa-3")],
      historial: [{ direction: "in", body: "hola" }],
    });

    // El barrido toma una foto de UN solo id; adentro del candado aparecen tres.
    await reintentarPendientes(deps, 1);

    for (const id of ["wa-1", "wa-2", "wa-3"]) {
      expect(store.marcarInboundAtendido).toHaveBeenCalledWith(id, EN_HORARIO);
    }
  });

  it("un número que falla no impide atender al siguiente", async () => {
    const otro = "+51999333444";
    const { deps, store, enviar } = crearDobles({
      pendientes: [
        { e164: otro, waMessageId: "wa-otro", at: EN_HORARIO },
        pendiente("wa-mio"),
      ],
      historial: [{ direction: "in", body: "¿Cuánto cuesta?" }],
    });
    // El primero revienta al enviar; el segundo tiene que salir igual.
    enviar.mockRejectedValueOnce(new Error("WhatsApp no disponible"));

    await expect(reintentarPendientes(deps)).resolves.toEqual({
      numeros: 2,
      respondidos: 1,
      siguenDiferidos: 0,
    });

    expect(store.marcarInboundAtendido).not.toHaveBeenCalledWith(
      "wa-otro",
      expect.anything(),
    );
    expect(store.marcarInboundAtendido).toHaveBeenCalledWith("wa-mio", EN_HORARIO);
  });
});
