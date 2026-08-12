import { describe, expect, it, vi } from "vitest";

import type { ProveedorLLM, RespuestaLLM } from "../llm/port.js";
import type { RecipientState } from "../wa/types.js";
import {
  DEFAULT_SAFETY_CONFIG,
  type AccountHealth,
} from "../wa/types.js";
import {
  ejecutarTanda,
  type DependenciasCampana,
} from "./campaign.js";
import type { VisualAprobado } from "./visual.js";

const NOW = new Date("2026-07-27T15:00:00.000Z");

function health(overrides: Partial<AccountHealth> = {}): AccountHealth {
  return {
    dayIndex: 15,
    sentToday: 0,
    lastSentAt: null,
    deviceRate: null,
    deviceRateSample: 0,
    deviceRateBaseline: null,
    killSwitch: { tripped: false, reason: null, trippedAt: null },
    ...overrides,
  };
}

function recipient(
  e164: string,
  overrides: Partial<RecipientState> = {},
): RecipientState {
  return {
    e164,
    suppressed: false,
    humanTakeover: false,
    firstOutboundAt: null,
    lastOutboundAt: null,
    lastInboundAt: null,
    lastHumanInboundAt: null,
    followUpCount: 0,
    ...overrides,
  };
}

function texto(text: string): RespuestaLLM {
  return {
    corte: "fin",
    texto: text.endsWith("?") ? text : `${text}?`,
    herramienta: null,
  };
}

interface FakeOptions {
  e164s?: string[];
  health?: AccountHealth;
  recipients?: Record<string, RecipientState>;
  respuestas?: RespuestaLLM[];
}

function fakeDeps(options: FakeOptions = {}): {
  deps: DependenciasCampana;
  events: string[];
  generar: ReturnType<typeof vi.fn<ProveedorLLM["generar"]>>;
  sendText: ReturnType<typeof vi.fn<(e164: string, body: string) => Promise<string>>>;
  sendImage: ReturnType<
    typeof vi.fn<
      (e164: string, image: Uint8Array, caption: string) => Promise<string>
    >
  >;
  sleeps: number[];
} {
  const events: string[] = [];
  const sleeps: number[] = [];
  const e164s = options.e164s ?? ["+51900000001"];
  const respuestas = [...(options.respuestas ?? [texto("Mensaje compuesto")])];
  let nextMessageId = 1;

  const generar = vi.fn<ProveedorLLM["generar"]>(async () => {
    events.push("llm");
    const respuesta = respuestas.shift();
    if (respuesta === undefined) throw new Error("falta respuesta fake");
    return respuesta;
  });
  const sendText = vi.fn(
    async (e164: string, _body: string): Promise<string> => {
      events.push(`sendText:${e164}`);
      return `wa-${e164}`;
    },
  );
  const sendImage = vi.fn(
    async (e164: string, _image: Uint8Array, _caption: string): Promise<string> => {
      events.push(`sendImage:${e164}`);
      return `wa-image-${e164}`;
    },
  );

  const deps: DependenciasCampana = {
    store: {
      // El doble respeta el desplazamiento: el runner pagina, y un doble que
      // ignore el offset devolvería la misma página para siempre.
      candidatosParaContactar: (limite, desplazamiento = 0) => {
        events.push(`candidatos:${limite}:${desplazamiento}`);
        return e164s
          .slice(desplazamiento, desplazamiento + limite)
          .map((e164, index) => ({
            e164,
            score: 100 - (desplazamiento + index),
          }));
      },
      loadAccountHealth: () => {
        events.push("account");
        return options.health ?? health();
      },
      loadRecipientState: (e164) => {
        events.push(`recipient:${e164}`);
        return options.recipients?.[e164] ?? recipient(e164);
      },
      loadFichaProspecto: (e164) => {
        events.push(`ficha:${e164}`);
        return {
          nombre: `Clínica ${e164}`,
          distrito: "MIRAFLORES",
          clasificacion: "CENTRO ODONTOLOGICO",
          vertical: "dental",
          tieneWeb: false,
          resenas: 20,
        };
      },
      // El compositor recibe aperturas recientes para no repetir la forma
      // entre prospectos; el doble devuelve vacío porque cada test evalúa un
      // aspecto distinto.
      aperturasRecientes: () => [],
      mensajesEnviados: (e164) => {
        events.push(`historial:${e164}`);
        return [];
      },
      claimSend: (e164, step) => {
        events.push(`claim:${e164}:${step}`);
        return nextMessageId++;
      },
      markSent: () => {
        events.push("markSent");
      },
      markError: () => {
        events.push("markError");
      },
      tripKillSwitch: () => {
        events.push("tripKillSwitch");
      },
    },
    proveedor: { nombre: "fake", generar },
    client: { sendText, sendImage },
    config: {
      ...DEFAULT_SAFETY_CONFIG,
      minGapSeconds: 0,
      maxGapSeconds: 0,
      followUpDays: [0, 0],
    },
    now: () => NOW,
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
      sleeps.push(milliseconds);
    },
    random: () => 0,
  };

  return { deps, events, generar, sendText, sendImage, sleeps };
}

describe("ejecutarTanda", () => {
  it("termina cuando canSendNow niega sin componer nada", async () => {
    const { deps, events, generar } = fakeDeps({
      e164s: ["+51900000001", "+51900000002"],
      health: health({
        killSwitch: {
          tripped: true,
          reason: "pausado por seguridad",
          trippedAt: NOW,
        },
      }),
    });

    const resumen = await ejecutarTanda(deps);

    expect(resumen.motivoTerminacion).toBe(
      "kill switch activo: pausado por seguridad",
    );
    expect(generar).not.toHaveBeenCalled();
    expect(events).toEqual(["candidatos:100:0", "account"]);
  });

  it("salta al destinatario negado por canContact y sigue con el próximo", async () => {
    const first = "+51900000001";
    const second = "+51900000002";
    const { deps, generar, sendText } = fakeDeps({
      e164s: [first, second],
      recipients: {
        [first]: recipient(first, { suppressed: true }),
        [second]: recipient(second),
      },
    });

    const resumen = await ejecutarTanda(deps);

    expect(resumen.saltadosPorDestinatario).toBe(1);
    expect(resumen.enviados).toBe(1);
    expect(generar).toHaveBeenCalledTimes(1);
    expect(generar.mock.calls[0]?.[0].mensajes[0]?.texto).toContain(
      "Apertura asignada para este prospecto: derivacion",
    );
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(second, "Mensaje compuesto?");
  });

  it("deriva el paso distinguiendo 'nada enviado' de 'solo el primero'", async () => {
    // followUpCount cuenta follow-ups SIN contar el primer mensaje, así que
    // vale 0 en dos estados distintos: nada enviado y primero ya enviado.
    // Derivar el paso solo de ese número hace que se reintente 'first', que
    // claimSend rechaza por idempotencia, y el prospecto nunca recibe un
    // follow-up. firstOutboundAt es lo que separa los dos casos.
    const e164s = ["+51900000001", "+51900000002", "+51900000003"];
    const antiguo = new Date(NOW.getTime() - 10 * 86_400_000);
    const { deps, events } = fakeDeps({
      e164s,
      recipients: {
        // nada enviado → first
        [e164s[0]!]: recipient(e164s[0]!, { followUpCount: 0 }),
        // primero enviado, cero follow-ups → fu1 (NO first otra vez)
        [e164s[1]!]: recipient(e164s[1]!, {
          firstOutboundAt: antiguo,
          lastOutboundAt: antiguo,
          followUpCount: 0,
        }),
        // primero + fu1 → fu2
        [e164s[2]!]: recipient(e164s[2]!, {
          firstOutboundAt: antiguo,
          lastOutboundAt: antiguo,
          followUpCount: 1,
        }),
      },
      respuestas: [texto("Primero"), texto("Segundo"), texto("Tercero")],
    });

    const resumen = await ejecutarTanda(deps);

    expect(resumen.enviados).toBe(3);
    // claim:<e164>:<paso> es donde queda registrado el paso que se reclamó.
    const pasos = events
      .filter((e) => e.startsWith("claim:"))
      .map((e) => e.split(":").at(-1));
    expect(pasos).toEqual(["first", "fu1", "fu2"]);
  });

  it("filtra por paso sin rellenar el cupo con prospectos de otros pasos", async () => {
    const e164s = ["+51900000001", "+51900000002", "+51900000003"];
    const antiguo = new Date(NOW.getTime() - 10 * 86_400_000);
    const { deps, generar, sendText, events } = fakeDeps({
      e164s,
      recipients: {
        [e164s[0]!]: recipient(e164s[0]!),
        [e164s[1]!]: recipient(e164s[1]!, {
          firstOutboundAt: antiguo,
          lastOutboundAt: antiguo,
          followUpCount: 0,
        }),
        [e164s[2]!]: recipient(e164s[2]!, {
          firstOutboundAt: antiguo,
          lastOutboundAt: antiguo,
          followUpCount: 1,
        }),
      },
    });

    const resumen = await ejecutarTanda(deps, { paso: "fu1", max: 3 });

    expect(resumen.enviados).toBe(1);
    expect(resumen.saltadosPorDestinatario).toBe(2);
    expect(generar).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(e164s[1], "Mensaje compuesto?");
    expect(events.filter((evento) => evento.startsWith("claim:"))).toEqual([
      `claim:${e164s[1]}:fu1`,
    ]);
  });

  it("una composición fallida se registra y no tumba la tanda", async () => {
    const { deps, sendText } = fakeDeps({
      e164s: ["+51900000001", "+51900000002"],
      respuestas: [
        {
          corte: "rechazo",
          texto: "",
          herramienta: null,
        },
        texto("Segundo sí compuesto"),
      ],
    });

    const resumen = await ejecutarTanda(deps);

    expect(resumen.fallosComposicion).toBe(1);
    expect(resumen.enviados).toBe(1);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(
      "+51900000002",
      "Segundo sí compuesto?",
    );
  });

  it("dryRun compone para revisión pero no envía", async () => {
    const { deps, sendText } = fakeDeps();

    const resumen = await ejecutarTanda(deps, { dryRun: true });

    expect(sendText).not.toHaveBeenCalled();
    expect(resumen.enviados).toBe(0);
    expect(resumen.mensajesCompuestos).toEqual([
      {
        e164: "+51900000001",
        nombre: "Clínica +51900000001",
        paso: "first",
        intencionApertura: "derivacion",
        texto: "Mensaje compuesto?",
        tipo: "text",
      },
    ]);
  });

  it("dry-run visual no llama al LLM y expone imagen y caption para revisión", async () => {
    const e164 = "+51900000001";
    const antiguo = new Date(NOW.getTime() - 10 * 86_400_000);
    const { deps, generar, sendImage } = fakeDeps({
      e164s: [e164],
      recipients: {
        [e164]: recipient(e164, {
          firstOutboundAt: antiguo,
          lastOutboundAt: antiguo,
        }),
      },
    });
    const visual: VisualAprobado = {
      e164,
      paso: "fu1",
      nombre: "Clínica Curada",
      ruta: "/aprobados/hero.png",
      imagen: new Uint8Array([1, 2, 3]),
      ancho: 1664,
      alto: 936,
    };

    const resumen = await ejecutarTanda(deps, {
      dryRun: true,
      visuales: new Map([[e164, visual]]),
    });

    expect(generar).not.toHaveBeenCalled();
    expect(sendImage).not.toHaveBeenCalled();
    expect(resumen.mensajesCompuestos).toEqual([
      expect.objectContaining({
        e164,
        paso: "fu1",
        intencionApertura: "visual",
        tipo: "image",
        imagen: "/aprobados/hero.png",
        texto: expect.stringMatching(/propuesta visual inicial[\s\S]*Clínica Curada/u),
      }),
    ]);
  });

  it("envía solo el visual aprobado y conserva la idempotencia del paso", async () => {
    const elegido = "+51900000001";
    const excluido = "+51900000002";
    const antiguo = new Date(NOW.getTime() - 10 * 86_400_000);
    const { deps, generar, sendText, sendImage, events } = fakeDeps({
      e164s: [excluido, elegido],
      recipients: {
        [elegido]: recipient(elegido, {
          firstOutboundAt: antiguo,
          lastOutboundAt: antiguo,
        }),
      },
    });
    const visual: VisualAprobado = {
      e164: elegido,
      paso: "fu1",
      ruta: "/aprobados/hero.png",
      imagen: new Uint8Array([1, 2, 3]),
      ancho: 1664,
      alto: 936,
    };

    const resumen = await ejecutarTanda(deps, {
      visuales: new Map([[elegido, visual]]),
    });

    expect(resumen.enviados).toBe(1);
    expect(generar).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(sendImage).toHaveBeenCalledWith(
      elegido,
      visual.imagen,
      expect.stringContaining("hace unos días"),
    );
    expect(events).toContain(`claim:${elegido}:fu1`);
    expect(events).not.toContain(`recipient:${excluido}`);
  });

  it("recompone con otra apertura cuando la auditoría detecta repetición", async () => {
    const repetido = "Le escribo de Kurogrid. Tenemos una propuesta concreta.";
    const { deps, generar } = fakeDeps({
      e164s: ["+51900000001", "+51900000002"],
      respuestas: [
        texto(repetido),
        texto(repetido),
        texto("Buscando la clínica, pensé en una web propia para sus pacientes"),
      ],
    });

    const resumen = await ejecutarTanda(deps, { max: 2, dryRun: true });

    expect(generar).toHaveBeenCalledTimes(3);
    expect(resumen.fallosComposicion).toBe(0);
    expect(resumen.mensajesCompuestos).toHaveLength(2);
    expect(resumen.mensajesCompuestos[1]?.texto).toBe(
      "Buscando la clínica, pensé en una web propia para sus pacientes?",
    );
    expect(
      generar.mock.calls.slice(1).map(([solicitud]) => solicitud.mensajes[0]?.texto),
    ).toEqual([
      expect.stringContaining("Apertura asignada para este prospecto: busqueda"),
      expect.stringContaining("Apertura asignada para este prospecto: busqueda"),
    ]);
  });

  it("no compone antes de verificar ambas puertas", async () => {
    const { deps, events } = fakeDeps();

    await ejecutarTanda(deps, { dryRun: true });

    expect(events.slice(0, 6)).toEqual([
      "candidatos:100:0",
      "account",
      "recipient:+51900000001",
      "ficha:+51900000001",
      "historial:+51900000001",
      "llm",
    ]);
  });

  it("respeta max al pedir y procesar candidatos", async () => {
    const { deps, events, generar } = fakeDeps({
      e164s: [
        "+51900000001",
        "+51900000002",
        "+51900000003",
        "+51900000004",
      ],
      respuestas: [texto("Uno"), texto("Dos")],
    });

    const resumen = await ejecutarTanda(deps, { max: 2, dryRun: true });

    expect(events[0]).toBe("candidatos:100:0");
    expect(generar).toHaveBeenCalledTimes(2);
    expect(resumen.mensajesCompuestos).toHaveLength(2);
    // Alcanzar el tope de la tanda es un motivo distinto a quedarse sin
    // prospectos, y conviene poder distinguirlos al leer el resumen.
    expect(resumen.motivoTerminacion).toBe("alcanzado el máximo de la tanda (2)");
  });

  it("pasa la vertical al store para aislar la cohorte", async () => {
    const { deps } = fakeDeps();
    const original = deps.store.candidatosParaContactar;
    const candidatos = vi.fn(original);
    deps.store.candidatosParaContactar = candidatos;

    await ejecutarTanda(deps, { max: 1, dryRun: true, vertical: "dental" });

    expect(candidatos).toHaveBeenCalledWith(100, 0, "dental");
  });

  it("soloFollowUps nunca abre un chat nuevo y conserva los follow-ups elegibles", async () => {
    const nuevo = "+51900000001";
    const seguimiento = "+51900000002";
    const antiguo = new Date(NOW.getTime() - 10 * 86_400_000);
    const { deps } = fakeDeps({
      e164s: [nuevo, seguimiento],
      recipients: {
        [nuevo]: recipient(nuevo),
        [seguimiento]: recipient(seguimiento, {
          firstOutboundAt: antiguo,
          lastOutboundAt: antiguo,
          followUpCount: 0,
        }),
      },
      respuestas: [texto("Seguimiento")],
    });

    const resumen = await ejecutarTanda(deps, {
      max: 10,
      dryRun: true,
      soloFollowUps: true,
    });

    expect(resumen.mensajesCompuestos).toHaveLength(1);
    expect(resumen.mensajesCompuestos[0]).toMatchObject({
      e164: seguimiento,
      paso: "fu1",
    });
    expect(resumen.saltadosPorDestinatario).toBe(1);
  });
});

describe("paginación de candidatos", () => {
  it("no se queda atascado en los primeros por score cuando no son elegibles", async () => {
    // La consulta ordena por score y no sabe de cadencia, así que los ya
    // terminados y los que aún no les toca ocupan los primeros puestos. Sin
    // paginar, esas filas coparían el cupo, canContact las saltaría a todas y
    // ningún prospecto de score más bajo se contactaría jamás.
    const bloqueados = Array.from(
      { length: 120 },
      (_, i) => `+5190000${String(i).padStart(4, "0")}`,
    );
    const alcanzable = "+51999999999";
    const antiguo = new Date(NOW.getTime() - 30 * 86_400_000);

    const recipients: Record<string, ReturnType<typeof recipient>> = {};
    for (const e of bloqueados) {
      // followUpCount 2 = secuencia terminada; canContact los niega siempre.
      recipients[e] = recipient(e, {
        firstOutboundAt: antiguo,
        lastOutboundAt: antiguo,
        followUpCount: 2,
      });
    }
    recipients[alcanzable] = recipient(alcanzable, {});

    const { deps } = fakeDeps({
      e164s: [...bloqueados, alcanzable],
      recipients,
      respuestas: [texto("Hola")],
    });

    const resumen = await ejecutarTanda(deps, { max: 1, dryRun: true });

    expect(resumen.saltadosPorDestinatario).toBe(120);
    expect(resumen.mensajesCompuestos).toHaveLength(1);
    expect(resumen.mensajesCompuestos[0]?.e164).toBe(alcanzable);
  });

  it("--solo deja fuera al resto de la cola", async () => {
    const { deps } = fakeDeps({
      e164s: ["+51900000001", "+51931845435", "+51900000003"],
      respuestas: [texto("Hola")],
    });

    const resumen = await ejecutarTanda(deps, {
      max: 5,
      dryRun: true,
      solo: "+51931845435",
    });

    expect(resumen.mensajesCompuestos).toHaveLength(1);
    expect(resumen.mensajesCompuestos[0]?.e164).toBe("+51931845435");
  });

  it("--solo repetido restringe la tanda a la lista explícita", async () => {
    const objetivoA = "+51931845435";
    const objetivoB = "+51931845436";
    const { deps } = fakeDeps({
      e164s: ["+51900000001", objetivoA, "+51900000003", objetivoB],
      respuestas: [texto("A"), texto("B")],
    });

    const resumen = await ejecutarTanda(deps, {
      max: 10,
      dryRun: true,
      solos: [objetivoA, objetivoB],
    });

    expect(resumen.mensajesCompuestos.map((mensaje) => mensaje.e164)).toEqual([
      objetivoA,
      objetivoB,
    ]);
  });

  // El filtro se aplica a la página ya leída y el desplazamiento avanza por el
  // tamaño crudo. Filtrar antes de contar rompía dos cosas: corría el offset de
  // menos, y si el número buscado no caía en la primera página el `while`
  // cortaba con cero resultados sin llegar nunca a la segunda.
  it("--solo encuentra un número que cae en una página posterior", async () => {
    const objetivo = "+51931845435";
    const relleno = Array.from(
      { length: 150 },
      (_, indice) => `+5190000${String(indice).padStart(4, "0")}`,
    );

    const { deps } = fakeDeps({
      e164s: [...relleno, objetivo],
      respuestas: [texto("Hola")],
    });

    const resumen = await ejecutarTanda(deps, {
      max: 1,
      dryRun: true,
      solo: objetivo,
    });

    expect(resumen.mensajesCompuestos).toHaveLength(1);
    expect(resumen.mensajesCompuestos[0]?.e164).toBe(objetivo);
  });
});
