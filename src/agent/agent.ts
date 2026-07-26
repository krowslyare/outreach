// El agente conversacional. Una llamada por mensaje entrante, sin loop agéntico:
// esto responde un turno de una conversación de WhatsApp, no ejecuta una tarea
// de varios pasos. Un tool runner acá sería infraestructura sin trabajo que
// hacer.
//
// El agente NO envía nada. Devuelve una decisión y el motor de seguridad
// (src/wa/safety.ts) decide si se ejecuta. Esa separación es lo que hace que un
// mensaje entrante malicioso no pueda saltarse los topes ni la supresión.

import { SYSTEM_PROMPT, contextoProspecto, type ContextoProspecto } from "./prompt.js";

export const MODELO = "claude-opus-5";

/** Un turno de la conversación tal como está guardado en el store. */
export interface Turno {
  rol: "prospecto" | "nosotros";
  texto: string;
}

export type AgentDecision =
  | { kind: "responder"; texto: string }
  | { kind: "escalar"; motivo: string; resumen: string }
  | { kind: "perdido"; motivo: string };

/**
 * Puerto mínimo hacia la API. Existe para poder testear sin red y sin mockear
 * las internas del SDK; `clienteAnthropic` es la implementación real.
 */
export interface ClienteClaude {
  crear(params: Record<string, unknown>): Promise<RespuestaClaude>;
}

export interface RespuestaClaude {
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  content: ReadonlyArray<{
    type: string;
    text?: string;
    name?: string;
    input?: unknown;
  }>;
}

const TOOLS = [
  {
    name: "escalar_a_humano",
    description:
      "Pasa la conversación a Hideki. Úsala en cuanto haya intención de contratar, " +
      "pedido de reunión o cotización, negociación de precio o condiciones, temas de " +
      "contrato o legales, una queja, un pedido explícito de hablar con una persona, " +
      "o una pregunta de alcance que no puedas responder con el catálogo.",
    strict: true,
    input_schema: {
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
            "Dos o tres líneas para que Hideki entre en contexto sin leer todo el hilo: " +
            "qué necesita, qué plan le calza y en qué quedó la conversación.",
        },
      },
      required: ["motivo", "resumen"],
      additionalProperties: false,
    },
  },
  {
    name: "marcar_perdido",
    description:
      "Cierra la conversación como perdida. Úsala solo cuando el no es claro: no le " +
      "interesa, ya tiene proveedor, o no es su decisión y no hay a quién derivar.",
    strict: true,
    input_schema: {
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
   * Profundidad de razonamiento. Default "high" a propósito: la calidad del
   * mensaje es la principal mitigación de la tasa de bloqueo, y la tasa de
   * bloqueo es lo que cuesta el número. A ~15 mensajes al día el costo de
   * subirle es despreciable frente a perder la cuenta.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Techo de tokens de salida. Cubre pensamiento + texto: en Opus 5 el
   * pensamiento está activo por defecto y comparte este presupuesto, así que
   * apretarlo trunca la respuesta a media frase.
   */
  maxTokens?: number;
}

export async function decidirRespuesta(
  cliente: ClienteClaude,
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

  const respuesta = await cliente.crear({
    model: MODELO,
    max_tokens: opts.maxTokens ?? 8000,
    output_config: { effort: opts.effort ?? "high" },
    // Sin temperature / top_p / top_k: Opus 5 los rechaza con 400.
    // Sin thinking explícito: en Opus 5 el pensamiento adaptativo ya es el default.
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // El system prompt es idéntico entre prospectos, así que se cachea y
        // deja de pagarse completo en cada mensaje. Por eso el contexto del
        // prospecto va en el turno de usuario y no acá.
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: TOOLS,
    messages: [
      { role: "user", content: contextoProspecto(prospecto) },
      ...historial.map((t) => ({
        role: t.rol === "prospecto" ? "user" : "assistant",
        content: t.texto,
      })),
    ],
  });

  return interpretar(respuesta);
}

/**
 * Traduce la respuesta de la API a una decisión. Separada y exportada para
 * poder testear cada forma de respuesta sin armar una llamada completa.
 */
export function interpretar(respuesta: RespuestaClaude): AgentDecision {
  // El stop_reason se revisa ANTES del contenido: en un refusal el content
  // viene vacío o parcial, y leerlo de frente rompe.
  if (respuesta.stop_reason === "refusal") {
    return {
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
      resumen:
        "Los clasificadores de seguridad rechazaron generar una respuesta" +
        (respuesta.stop_details?.category
          ? ` (categoría: ${respuesta.stop_details.category})`
          : "") +
        ". Requiere que lo revises a mano.",
    };
  }

  // Se recorren TODAS las herramientas antes de decidir, no la primera que
  // aparezca. Claude puede emitir varios tool_use en una respuesta, y un
  // mensaje mixto como "no me interesa, pero quiero hablar con Hideki" satisface
  // las dos. Si ganara el orden del contenido, un marcar_perdido podría
  // descartar un pedido explícito de hablar con una persona — que es
  // justamente el caso donde la regla dice escalar de inmediato.
  let perdido: AgentDecision | null = null;

  for (const bloque of respuesta.content) {
    if (bloque.type !== "tool_use") continue;
    const input = (bloque.input ?? {}) as Record<string, unknown>;

    if (bloque.name === "escalar_a_humano") {
      // El escalamiento domina cualquier otra decisión: el costo de escalar de
      // más es una notificación; el de no escalar, un cliente perdido.
      return {
        kind: "escalar",
        motivo: String(input.motivo ?? "fuera_de_mi_alcance"),
        resumen: String(input.resumen ?? ""),
      };
    }
    if (bloque.name === "marcar_perdido" && perdido === null) {
      perdido = { kind: "perdido", motivo: String(input.motivo ?? "otro") };
    }
  }

  if (perdido !== null) return perdido;

  const texto = respuesta.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();

  // Un texto truncado NO se manda. Con pensamiento adaptativo el presupuesto de
  // salida se comparte, así que agotarlo devuelve stop_reason "max_tokens" con
  // texto no vacío pero cortado a media frase. Mandarle eso a un prospecto se
  // ve peor que no contestar, y encima delata que hay un bot detrás.
  if (respuesta.stop_reason === "max_tokens") {
    return {
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
      resumen:
        "La respuesta se truncó por límite de tokens y no se envió. " +
        (texto.length > 0
          ? `Fragmento generado: "${texto.slice(0, 200)}"`
          : "No alcanzó a generar texto.") +
        " Conviene subir maxTokens o contestar a mano.",
    };
  }

  if (texto.length === 0) {
    // Sin texto y sin herramienta no hay nada que mandar. Escalar en vez de
    // quedarse callado: el prospecto escribió y merece respuesta, aunque sea
    // de Hideki. Un silencio se lee como desinterés y quema el lead.
    return {
      kind: "escalar",
      motivo: "fuera_de_mi_alcance",
      resumen:
        `El modelo no produjo respuesta (stop_reason: ${respuesta.stop_reason ?? "desconocido"}). ` +
        "Contestar a mano.",
    };
  }

  return { kind: "responder", texto };
}
