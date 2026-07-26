// Compositor de los mensajes salientes: el primer contacto y los dos
// follow-ups.
//
// Esto es lo más importante del sistema para la supervivencia del número. El
// factor dominante de un ban es la tasa de bloqueo, y lo que evita que alguien
// te bloquee es que el mensaje le aplique de verdad. Por eso cada mensaje se
// compone individualmente en vez de rellenar una plantilla: una plantilla con
// el nombre cambiado se detecta y se bloquea igual.

import type { ClienteClaude } from "../agent/agent.js";
import { catalogoParaPrompt } from "../agent/catalog.js";
import type { ContextoProspecto } from "../agent/prompt.js";

export type PasoCampana = "first" | "fu1" | "fu2";
export type IntencionApertura =
  | "derivacion"
  | "busqueda"
  | "operativa"
  | "permiso"
  | "directa";

export const MODELO_COMPOSITOR = "claude-opus-5";

const SISTEMA = `Escribes el primer mensaje de WhatsApp (y sus seguimientos) que Kurogrid, un estudio peruano de webs, le manda a consultorios y clínicas privadas de Lima.

# Lo único que tiene que lograr
Que la persona RESPONDA. No que compre, no que entienda el servicio: que conteste. Un mensaje que consigue "¿de qué se trata?" cumplió su trabajo.

# Identifícate de inmediato
Un número desconocido que tarda en decir quién es se lee como estafa. La primera línea dice que escribes de Kurogrid.

NO firmes con un nombre propio. Quien escribe es un asistente, no Hideki. Si conviene mencionarlo, va como responsable del siguiente paso ("lo coordino con Hideki"), nunca como autor del mensaje.

# NO menciones el precio en el primer contacto
Un precio convierte la conversación en una oferta comparable y descartable antes de que exista interés, y dispara preguntas prematuras. El precio aparece después, cuando haya interés real. Tampoco insinúes rangos ni "desde".

# Encuadra desde el paciente, no desde la carencia
"No tiene web" pone a la defensiva e invita a justificarse ("usamos Instagram", "ya estamos viendo"). Lo mismo dicho como experiencia de búsqueda no acusa a nadie:

  MAL: "Vi que no tienen página web."
  BIEN: "Buscando [negocio] encontré su ficha de Google, pero no un lugar donde ver juntos sus servicios y horarios."

# Forma
- Dos o tres líneas. Se lee en un celular, entre pacientes.
- Trato de "usted". Siempre.
- Una sola pregunta, al final, fácil de contestar.
- Sin emojis, sin signos de exclamación, sin "¡Hola estimado cliente!".
- Nada de "espero que se encuentre bien" ni relleno de cortesía.

# Con los datos del prospecto
- Usa el rubro en lenguaje natural: "consultorio", "policlínico", "centro odontológico". NUNCA copies la categoría del registro sanitario tal cual; es jerga de base de datos y delata que lees un padrón.
- Las reseñas se mencionan SOLO si son un dato favorable ("tienen muy buenos comentarios"). Nunca destaques un número bajo: se lee como reproche.
- El nombre va tal como te lo doy, ya normalizado. No lo pongas en mayúsculas.
- Si un dato no está en el contexto, no existe. Nunca inventes un detalle para sonar personalizado: que te descubran inventando es peor que ser genérico.

# La apertura que te toca
Te asigno un ACTO conversacional para abrir. La variedad real está ahí, no en buscar sinónimos de la misma frase. Respétalo:

- **derivacion**: buscas a la persona correcta sin vender todavía. Útil cuando los datos son débiles o el rubro es ambiguo.
- **busqueda**: planteas el problema desde quien busca al negocio. Útil cuando rubro y distrito son confiables.
- **operativa**: preguntas cómo atienden hoy las consultas (WhatsApp, llamada, presencial). Útil en rubros con cita o cotización.
- **permiso**: pides autorización para contar la idea en dos líneas antes de desarrollarla. Útil cuando hay poca información.
- **directa**: preguntas si les interesaría recibir más consultas de quienes buscan ese servicio en su distrito.

# Reglas duras
- No inventes plazos, casos de éxito, clientes ni cifras.
- No afirmes nada del negocio que no esté en el contexto. Si dice que no se pudo verificar si tiene web, NO afirmes que no tiene: pregunta.
- No prometas funcionalidades.

# Los tres pasos
- **first**: primer contacto, con la apertura asignada.
- **fu1** (día 3): UNA línea. Algo nuevo, sin repetir el pitch ni decir "le escribo de nuevo". Si no tienes nada nuevo, una pregunta distinta y más simple.
- **fu2** (día 7): último intento. Cierre amable que deje la puerta abierta, tipo "si no es el momento, sin problema". Nada de urgencia falsa.

# Salida
Devuelve ÚNICAMENTE el texto del mensaje, listo para enviar. Sin comillas, sin explicaciones, sin alternativas.`;

const INSTRUCCION_PASO: Record<PasoCampana, string> = {
  first: "Escribe el PRIMER mensaje.",
  fu1: "Escribe el follow-up 1 (día 3). Una sola línea, algo nuevo, sin repetir el pitch.",
  fu2: "Escribe el follow-up 2 (día 7). Último intento, cierre amable sin presión.",
};

export interface ComposeOpts {
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}

export type ResultadoComposicion =
  | { ok: true; texto: string }
  | { ok: false; motivo: string };

/**
 * Compone un mensaje saliente.
 *
 * Nunca lanza por una respuesta rara del modelo: devuelve `ok: false` y el
 * runner salta ese prospecto. Un fallo de composición no debe tumbar la tanda
 * ni, peor, mandar algo a medias.
 */
export async function componerMensaje(
  cliente: ClienteClaude,
  prospecto: ContextoProspecto,
  paso: PasoCampana,
  historialPrevio: readonly string[],
  intencion: IntencionApertura,
  aperturasRecientes: readonly string[],
  opts: ComposeOpts = {},
): Promise<ResultadoComposicion> {
  const contexto = [
    "<prospecto>",
    `Nombre: ${prospecto.nombre}`,
    `Distrito: ${prospecto.distrito}`,
    `Rubro: ${prospecto.clasificacion}`,
    `Página web: ${
      prospecto.tieneWeb === null
        ? "NO SE PUDO VERIFICAR — no afirmes que no tiene, pregunta"
        : prospecto.tieneWeb
          ? "sí tiene"
          : "no tiene"
    }`,
    `Presencia en Google: ${
      prospecto.resenas === null ? "sin dato" : `${prospecto.resenas} reseñas`
    }`,
    "</prospecto>",
    "",
    `Intención de apertura asignada: ${intencion}`,
    aperturasRecientes.length > 0
      ? `Aperturas recientes de otros prospectos; no repitas sus primeras palabras:\n${aperturasRecientes
          .map((apertura, i) => `${i + 1}. ${apertura}`)
          .join("\n")}`
      : "No hay aperturas recientes de otros prospectos.",
    "",
    historialPrevio.length > 0
      ? `Ya le enviamos estos mensajes, no los repitas:\n${historialPrevio
          .map((m, i) => `${i + 1}. ${m}`)
          .join("\n")}`
      : "Es el primer contacto: no le hemos escrito antes.",
    "",
    INSTRUCCION_PASO[paso],
  ].join("\n");

  const respuesta = await cliente.crear({
    model: MODELO_COMPOSITOR,
    max_tokens: opts.maxTokens ?? 4000,
    output_config: { effort: opts.effort ?? "high" },
    system: [
      {
        type: "text",
        text: SISTEMA,
        // Idéntico entre prospectos, así que se cachea; el contexto va después.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: contexto }],
  });

  if (respuesta.stop_reason === "refusal") {
    return { ok: false, motivo: "los clasificadores rechazaron la composición" };
  }
  // Un mensaje cortado a media frase no se manda. Delata al bot y desperdicia
  // el único primer contacto que existe con esa persona.
  if (respuesta.stop_reason === "max_tokens") {
    return { ok: false, motivo: "la composición se truncó por límite de tokens" };
  }

  const texto = respuesta.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();

  if (texto.length === 0) {
    return { ok: false, motivo: "el modelo no produjo texto" };
  }
  // Un "mensaje" larguísimo casi siempre es el modelo explicando en vez de
  // escribir. Mandarlo por WhatsApp se ve fatal, así que se descarta.
  if (texto.length > 700) {
    return {
      ok: false,
      motivo: `la composición salió demasiado larga (${texto.length} caracteres)`,
    };
  }

  return { ok: true, texto };
}
