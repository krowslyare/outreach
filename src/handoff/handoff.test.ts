import { describe, expect, it, vi } from "vitest";

import type { AgentDecision } from "../agent/agent.js";
import {
  ejecutarHandoff,
  mensajeParaHumano,
  mensajeParaProspecto,
  type HandoffDeps,
  type PortalClient,
  type StoreHandoff,
} from "./handoff.js";

const E164 = "+51999111222";
const NUMERO_HUMANO = "+51999888777";
const NOMBRE = "Clínica Ejemplo";
const DECISION_ESCALAR: Extract<AgentDecision, { kind: "escalar" }> = {
  kind: "escalar",
  motivo: "quiere_contratar",
  resumen: "Quiere contratar el plan Empresa.",
};

interface OpcionesDobles {
  humanTakeover?: boolean;
  enviarRechaza?: boolean;
  portal?: PortalClient;
  log?: (mensaje: string) => void;
}

function crearDobles(opciones: OpcionesDobles = {}): {
  deps: HandoffDeps;
  eventos: string[];
} {
  const eventos: string[] = [];

  // Todos los puertos escriben en el mismo registro porque el orden entre
  // dependencias, y no solo las llamadas dentro de cada una, es la garantía.
  const store: StoreHandoff = {
    loadRecipientState(e164) {
      eventos.push(`store.load:${e164}`);
      return { humanTakeover: opciones.humanTakeover ?? false };
    },
    setHumanTakeover(e164) {
      eventos.push(`store.setHumanTakeover:${e164}`);
    },
    suppress(e164, reason) {
      eventos.push(`store.suppress:${e164}:${reason}`);
    },
    recordOutboundLibre(e164) {
      eventos.push(`store.recordOutboundLibre:${e164}`);
    },
  };

  const deps: HandoffDeps = {
    store,
    numeroHumano: NUMERO_HUMANO,
    now: () => new Date("2026-07-28T04:00:00.000Z"),
    async enviar(e164, texto) {
      eventos.push(`enviar:${e164}:${texto}`);
      if (opciones.enviarRechaza === true) {
        throw new Error("WhatsApp no disponible");
      }
      return "mensaje-1";
    },
    log: opciones.log,
  };

  if (opciones.portal !== undefined) {
    deps.portal = opciones.portal;
  }

  return { deps, eventos };
}

describe("ejecutarHandoff", () => {
  it("devuelve no_aplica para responder sin tocar dependencias", async () => {
    const { deps, eventos } = crearDobles({
      portal: {
        async crearOportunidad() {
          eventos.push("portal.crearOportunidad");
        },
      },
    });

    await expect(
      ejecutarHandoff(deps, E164, NOMBRE, {
        kind: "responder",
        texto: "Con gusto le cuento.",
      }),
    ).resolves.toEqual({ estado: "no_aplica" });
    expect(eventos).toEqual([]);
  });

  it("suprime una decisión perdida sin notificar", async () => {
    const { deps, eventos } = crearDobles();

    await expect(
      ejecutarHandoff(deps, E164, NOMBRE, {
        kind: "perdido",
        motivo: "no_interesa",
      }),
    ).resolves.toEqual({
      estado: "ejecutado",
      notificado: false,
      portalOk: false,
    });
    // Los rechazos no generan avisos porque ese ruido haría menos útiles los
    // handoffs que sí requieren una acción humana.
    expect(eventos).toEqual([
      `store.suppress:${E164}:perdido: no_interesa`,
    ]);
  });

  it("devuelve ya_estaba sin volver a notificar un takeover existente", async () => {
    const { deps, eventos } = crearDobles({ humanTakeover: true });

    await expect(
      ejecutarHandoff(deps, E164, NOMBRE, DECISION_ESCALAR),
    ).resolves.toEqual({ estado: "ya_estaba" });
    // Los reintentos y eventos duplicados solo consultan el lock para no
    // inundar al humano con el mismo aviso.
    expect(eventos).toEqual([`store.load:${E164}`]);
  });

  it("pone el takeover antes de enviar la notificación", async () => {
    const { deps, eventos } = crearDobles();

    await expect(
      ejecutarHandoff(deps, E164, NOMBRE, DECISION_ESCALAR),
    ).resolves.toEqual({
      estado: "ejecutado",
      notificado: true,
      portalOk: false,
    });

    // Un solo array prueba el orden global: el lock, después el aviso al
    // humano —que es el camino de recuperación si algo falla— y recién al
    // final el acuse al prospecto.
    expect(eventos).toEqual([
      `store.load:${E164}`,
      `store.setHumanTakeover:${E164}`,
      `enviar:${NUMERO_HUMANO}:${mensajeParaHumano(NOMBRE, E164, DECISION_ESCALAR)}`,
      `enviar:${E164}:${mensajeParaProspecto(DECISION_ESCALAR)}`,
      // Lo último que le dijimos tiene que quedar en el hilo guardado, o el
      // historial termina en su "me interesa" como si no le hubiéramos contestado.
      `store.recordOutboundLibre:${E164}`,
    ]);
  });

  it("conserva el takeover y no propaga si enviar rechaza", async () => {
    const { deps, eventos } = crearDobles({ enviarRechaza: true });

    await expect(
      ejecutarHandoff(deps, E164, NOMBRE, DECISION_ESCALAR),
    ).resolves.toEqual({
      estado: "ejecutado",
      notificado: false,
      portalOk: false,
    });
    expect(eventos.map((evento) => evento.split(":")[0])).toEqual([
      "store.load",
      "store.setHumanTakeover",
      "enviar",
      "enviar",
    ]);
  });

  it("reporta portalOk false sin propagar si el portal rechaza", async () => {
    const portal: PortalClient = {
      async crearOportunidad() {
        throw new Error("Portal no disponible");
      },
    };
    const { deps } = crearDobles({ portal });

    await expect(
      ejecutarHandoff(deps, E164, NOMBRE, DECISION_ESCALAR),
    ).resolves.toEqual({
      estado: "ejecutado",
      notificado: true,
      portalOk: false,
    });
  });

  it("funciona sin portal configurado", async () => {
    const { deps } = crearDobles();

    await expect(
      ejecutarHandoff(deps, E164, NOMBRE, DECISION_ESCALAR),
    ).resolves.toEqual({
      estado: "ejecutado",
      notificado: true,
      portalOk: false,
    });
  });

  it("marca portalOk true y entrega todos los datos al portal", async () => {
    const recibidos: Array<{
      e164: string;
      nombre: string;
      motivo: string;
      resumen: string;
    }> = [];
    const portal: PortalClient = {
      async crearOportunidad(datos) {
        recibidos.push(datos);
      },
    };
    const { deps } = crearDobles({ portal });

    await expect(
      ejecutarHandoff(deps, E164, NOMBRE, DECISION_ESCALAR),
    ).resolves.toEqual({
      estado: "ejecutado",
      notificado: true,
      portalOk: true,
    });
    expect(recibidos).toEqual([
      {
        e164: E164,
        nombre: NOMBRE,
        motivo: DECISION_ESCALAR.motivo,
        resumen: DECISION_ESCALAR.resumen,
      },
    ]);
  });

  it("usa el log opcional para fallos de notificación y portal", async () => {
    const log = vi.fn<(mensaje: string) => void>();
    const portal: PortalClient = {
      async crearOportunidad() {
        throw new Error("Portal no disponible");
      },
    };
    const { deps } = crearDobles({
      enviarRechaza: true,
      portal,
      log,
    });

    await ejecutarHandoff(deps, E164, NOMBRE, DECISION_ESCALAR);

    expect(log).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("notificación de handoff"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("acuse al prospecto"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("portal"));
  });

  // El prospecto acaba de decir que le interesa. Que el bot se quede mudo por
  // el lock era el silencio más caro del flujo.
  it("le responde al prospecto, no solo al humano", async () => {
    const { deps, eventos } = crearDobles();

    await ejecutarHandoff(deps, E164, NOMBRE, DECISION_ESCALAR);

    const alProspecto = eventos.find((evento) =>
      evento.startsWith(`enviar:${E164}:`),
    );
    expect(alProspecto).toBeDefined();
    expect(alProspecto).toContain("llamada");
    expect(alProspecto).toContain("reunión");
  });

  // Si el acuse revienta, el lock y el aviso ya ocurrieron: se pierde el acuse,
  // no el control ni la alerta.
  it("un acuse fallido no cambia el resultado del handoff", async () => {
    const { deps } = crearDobles({ enviarRechaza: true });

    await expect(
      ejecutarHandoff(deps, E164, NOMBRE, DECISION_ESCALAR),
    ).resolves.toEqual({
      estado: "ejecutado",
      notificado: false,
      portalOk: false,
    });
  });
});

describe("mensajeParaProspecto", () => {
  it("ofrece las tres opciones y una sola pregunta", () => {
    const mensaje = mensajeParaProspecto(DECISION_ESCALAR);

    expect(mensaje).toContain("llamada");
    expect(mensaje).toContain("reunión");
    expect(mensaje).toContain("por acá");
    expect(mensaje.split("?").length - 1).toBe(1);
  });

  // Ofrecerle a alguien molesto que elija entre llamada y reunión suena a que
  // nadie leyó su queja.
  it("a una queja no le ofrece un menú de opciones", () => {
    const mensaje = mensajeParaProspecto({
      kind: "escalar",
      motivo: "queja",
      resumen: "Está molesto porque le escribimos.",
    });

    expect(mensaje).not.toContain("llamada");
    expect(mensaje).not.toContain("reunión");
  });

  // Un nombre propio que la persona nunca oyó no genera confianza.
  it("nunca dice el nombre del dueño", () => {
    for (const motivo of ["quiere_contratar", "queja", "pide_humano"]) {
      expect(
        mensajeParaProspecto({ kind: "escalar", motivo, resumen: "" }),
      ).not.toMatch(/hideki/i);
    }
  });
});

describe("mensajeParaHumano", () => {
  it("incluye nombre, resumen y un link wa.me sin el signo más", () => {
    const mensaje = mensajeParaHumano(NOMBRE, E164, DECISION_ESCALAR);

    expect(mensaje).toContain(NOMBRE);
    expect(mensaje).toContain(DECISION_ESCALAR.resumen);
    expect(mensaje).toContain("https://wa.me/51999111222");
    expect(mensaje).not.toContain("https://wa.me/+");
  });

  it.each([
    ["quiere_contratar", "QUIERE CONTRATAR"],
    ["queja", "QUEJA"],
    ["pide_reunion", "pide reunión"],
  ])("traduce el motivo %s a su etiqueta", (motivo, etiqueta) => {
    const mensaje = mensajeParaHumano(NOMBRE, E164, {
      kind: "escalar",
      motivo,
      resumen: "Resumen.",
    });

    expect(mensaje).toContain(`🔔 ${etiqueta}`);
  });

  it("usa el motivo crudo cuando no conoce su etiqueta", () => {
    expect(
      mensajeParaHumano(NOMBRE, E164, {
        kind: "escalar",
        motivo: "caso_especial",
        resumen: "Resumen.",
      }),
    ).toContain("🔔 caso_especial");
  });

  it.each(["", "   \n\t"])(
    "reemplaza un resumen vacío o en blanco con el texto de respaldo",
    (resumen) => {
      const mensaje = mensajeParaHumano(NOMBRE, E164, {
        kind: "escalar",
        motivo: "queja",
        resumen,
      });

      expect(mensaje).toContain("(el agente no dejó resumen)");
    },
  );
});
