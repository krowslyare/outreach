import { describe, expect, it, vi } from "vitest";

import type {
  ClienteClaude,
  RespuestaClaude,
} from "../agent/agent.js";
import type { RecipientState } from "../wa/types.js";
import {
  DEFAULT_SAFETY_CONFIG,
  type AccountHealth,
} from "../wa/types.js";
import {
  ejecutarTanda,
  type DependenciasCampana,
} from "./campaign.js";

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
    followUpCount: 0,
    ...overrides,
  };
}

function texto(text: string): RespuestaClaude {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
  };
}

interface FakeOptions {
  e164s?: string[];
  health?: AccountHealth;
  recipients?: Record<string, RecipientState>;
  respuestas?: RespuestaClaude[];
}

function fakeDeps(options: FakeOptions = {}): {
  deps: DependenciasCampana;
  events: string[];
  crear: ReturnType<typeof vi.fn<ClienteClaude["crear"]>>;
  sendText: ReturnType<typeof vi.fn<(e164: string, body: string) => Promise<string>>>;
  sleeps: number[];
} {
  const events: string[] = [];
  const sleeps: number[] = [];
  const e164s = options.e164s ?? ["+51900000001"];
  const respuestas = [...(options.respuestas ?? [texto("Mensaje compuesto")])];
  let nextMessageId = 1;

  const crear = vi.fn<ClienteClaude["crear"]>(async () => {
    events.push("claude");
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

  const deps: DependenciasCampana = {
    store: {
      candidatosParaContactar: (limite) => {
        events.push(`candidatos:${limite}`);
        return e164s.slice(0, limite).map((e164, index) => ({
          e164,
          score: 100 - index,
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
          tieneWeb: false,
          resenas: 20,
        };
      },
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
    cliente: { crear },
    client: { sendText },
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

  return { deps, events, crear, sendText, sleeps };
}

describe("ejecutarTanda", () => {
  it("termina cuando canSendNow niega sin componer nada", async () => {
    const { deps, events, crear } = fakeDeps({
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
    expect(crear).not.toHaveBeenCalled();
    expect(events).toEqual(["candidatos:20", "account"]);
  });

  it("salta al destinatario negado por canContact y sigue con el próximo", async () => {
    const first = "+51900000001";
    const second = "+51900000002";
    const { deps, crear, sendText } = fakeDeps({
      e164s: [first, second],
      recipients: {
        [first]: recipient(first, { suppressed: true }),
        [second]: recipient(second),
      },
    });

    const resumen = await ejecutarTanda(deps);

    expect(resumen.saltadosPorDestinatario).toBe(1);
    expect(resumen.enviados).toBe(1);
    expect(crear).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(second, "Mensaje compuesto");
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

  it("una composición fallida se registra y no tumba la tanda", async () => {
    const { deps, sendText } = fakeDeps({
      e164s: ["+51900000001", "+51900000002"],
      respuestas: [
        { stop_reason: "refusal", content: [] },
        texto("Segundo sí compuesto"),
      ],
    });

    const resumen = await ejecutarTanda(deps);

    expect(resumen.fallosComposicion).toBe(1);
    expect(resumen.enviados).toBe(1);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(
      "+51900000002",
      "Segundo sí compuesto",
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
        texto: "Mensaje compuesto",
      },
    ]);
  });

  it("no compone antes de verificar ambas puertas", async () => {
    const { deps, events } = fakeDeps();

    await ejecutarTanda(deps, { dryRun: true });

    expect(events.slice(0, 6)).toEqual([
      "candidatos:20",
      "account",
      "recipient:+51900000001",
      "ficha:+51900000001",
      "historial:+51900000001",
      "claude",
    ]);
  });

  it("respeta max al pedir y procesar candidatos", async () => {
    const { deps, events, crear } = fakeDeps({
      e164s: [
        "+51900000001",
        "+51900000002",
        "+51900000003",
        "+51900000004",
      ],
      respuestas: [texto("Uno"), texto("Dos")],
    });

    const resumen = await ejecutarTanda(deps, { max: 2, dryRun: true });

    expect(events[0]).toBe("candidatos:2");
    expect(crear).toHaveBeenCalledTimes(2);
    expect(resumen.mensajesCompuestos).toHaveLength(2);
    expect(resumen.motivoTerminacion).toBe(
      "tanda completada (2 candidatos evaluados)",
    );
  });
});
