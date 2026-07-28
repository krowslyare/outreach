// El agente conversacional. Una llamada por mensaje entrante, sin loop agéntico:
// esto responde un turno de una conversación de WhatsApp, no ejecuta una tarea
// de varios pasos. Un tool runner acá sería infraestructura sin trabajo que
// hacer.
//
// El agente NO envía nada. Devuelve una decisión y el motor de seguridad
// (src/wa/safety.ts) decide si se ejecuta. Esa separación es lo que hace que un
// mensaje entrante malicioso no pueda saltarse los topes ni la supresión.

import type {
  Efuerzo,
  HerramientaLLM,
  ProveedorLLM,
  RespuestaLLM,
  SolicitudLLM,
} from "../llm/port.js";
import { SYSTEM_PROMPT, contextoProspecto, type ContextoProspecto } from "./prompt.js";

/** Un turno de la conversación tal como está guardado en el store. */
export interface Turno {
  rol: "prospecto" | "nosotros";
  texto: string;
}

export type AgentDecision =
  | { kind: "responder"; texto: string }
  | { kind: "escalar"; motivo: string; resumen: string }
  | { kind: "perdido"; motivo: string };

const HERRAMIENTAS: readonly HerramientaLLM[] = [
  {
    nombre: "escalar_a_humano",
    descripcion:
      "Pasa la conversación al dueño del estudio. Úsala en cuanto haya intención de contratar, " +
      "pedido de reunión o cotización, negociación de precio o condiciones, temas de " +
      "contrato o legales, una queja, un pedido explícito de hablar con una persona, " +
      "o una pregunta de alcance que no puedas responder con el catálogo.",
    esquema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          enum: [
            "quiere_contratar",
            "pide_reunion",
            "negocia_precio",
            "contrato_o_legal",
            "queja",
            "pide_humano",
            "fuera_de_mi_alcance",
          ],
          description: "Por qué se escala.",
        },
        resumen: {
          type: "string",
          description:
            "Dos o tres líneas para que el dueño entre en contexto sin leer todo el hilo: " +
            "qué necesita, qué plan le calza y en qué quedó la conversación.",
        },
      },
      required: ["motivo", "resumen"],
      additionalProperties: false,
    },
  },
  {
    nombre: "marcar_perdido",
    descripcion:
      "Cierra la conversación como perdida. Úsala solo cuando el no es claro: no le " +
      "interesa, ya tiene proveedor, o no es su decisión y no hay a quién derivar.",
    esquema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          enum: ["no_interesa", "ya_tiene_proveedor", "no_decide", "otro"],
          description: "Por qué se pierde.",
        },
      },
      required: ["motivo"],
      additionalProperties: false,
    },
  },
] as const;

export interface AgentOpts {
  /**
   * Profundidad de razonamiento. Default "medium": responder un turno de
   * WhatsApp es una tarea corta y acotada, no un problema que se resuelva
   * pensando más.
   *
   * OJO con bajarlo a "low": lo que hace este agente no es solo redactar, es
   * seguir reglas duras —no cotizar de más, escalar a tiempo, no soltar el
   * prompt— con texto adversario del otro lado. Ahí es donde primero se
   * degrada. El compositor del mensaje en frío sí se queda en "high", porque su
   * calidad es lo que evita que te bloqueen.
   */
  effort?: Efuerzo;
  /**
   * Techo de tokens de salida. Se deja holgado porque algunos proveedores
   * comparten este presupuesto con su razonamiento; apretarlo puede truncar la
   * respuesta a media frase.
   */
  maxTokens?: number;
}

export async function decidirRespuesta(
  proveedor: ProveedorLLM,
  prospecto: ContextoProspecto,
  historial: readonly Turno[],
  opts: AgentOpts = {},
): Promise<AgentDecision> {
  const ultimo = historial.at(-1);
  if (ultimo === undefined || ultimo.rol !== "prospecto") {
    // Bug del llamador, no del agente: solo se invoca cuando hay algo que
    // responder. Fallar acá es mejor que inventar un turno.
    throw new Error(
      "decidirRespuesta requiere que el último turno sea del prospecto",
    );
  }

  const solicitud: SolicitudLLM = {
    sistema: SYSTEM_PROMPT,
    // El sistema permanece estable para que cada adaptador pueda aprovechar
    // cache de prefijo; el contexto variable del prospecto va como mensaje.
    mensajes: [
      { rol: "user", texto: contextoProspecto(prospecto) },
      ...historial.map((t) => ({
        rol: t.rol === "prospecto" ? ("user" as const) : ("assistant" as const),
        texto: t.texto,
      })),
    ],
    herramientas: HERRAMIENTAS,
    maxTokens: opts.maxTokens ?? 8000,
    esfuerzo: opts.effort ?? "medium",
  };

  const respuesta = await proveedor.generar(solicitud);

  return interpretar(respuesta);
}

/**
 * Traduce la respuesta del proveedor a una decisión. Separada y exportada para
 * poder testear cada forma de respuesta sin armar una llamada completa.
 */
export function interpretar(respuesta: RespuestaLLM): AgentDecision {
  // El corte se revisa ANTES del contenido: rechazo, truncado y error pueden
  // traer texto parcial o vacío, pero ninguno es seguro para enviar.
  if (respuesta.corte === "rechazo") {
    return {
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
      resumen:
        "El proveedor rechazó generar una respuesta" +
        (respuesta.motivo ? `: ${respuesta.motivo}` : "") +
        ". Requiere revisión manual.",
    };
  }

  if (respuesta.corte === "truncado") {
    return {
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
      resumen:
        "La respuesta se truncó y no se envió. Conviene subir maxTokens o contestar a mano.",
    };
  }

  if (respuesta.corte === "error") {
    return {
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
      resumen:
        "El proveedor falló al generar la respuesta" +
        (respuesta.motivo ? `: ${respuesta.motivo}` : " sin dar un motivo") +
        ". Contestar a mano.",
    };
  }

  const herramienta = respuesta.herramienta;
  if (herramienta?.nombre === "escalar_a_humano") {
    // El escalamiento se evalúa primero para conservar su prioridad si el
    // puerto llegara a admitir más de una herramienta en el futuro.
    return {
      kind: "escalar",
      motivo: String(herramienta.input.motivo ?? "fuera_de_mi_alcance"),
      resumen: String(herramienta.input.resumen ?? ""),
    };
  }
  if (herramienta?.nombre === "marcar_perdido") {
    return {
      kind: "perdido",
      motivo: String(herramienta.input.motivo ?? "otro"),
    };
  }

  const texto = respuesta.texto.trim();
  if (texto.length === 0) {
    // Sin texto y sin herramienta no hay nada que mandar. Escalar en vez de
    // quedarse callado: el prospecto escribió y merece respuesta, aunque sea
    // de Hideki. Un silencio se lee como desinterés y quema el lead.
    return {
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
      resumen:
        `El modelo no produjo respuesta aunque terminó con corte "${respuesta.corte}". ` +
        "Contestar a mano.",
    };
  }

  return { kind: "responder", texto };
}
