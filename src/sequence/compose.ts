// Compositor de los mensajes salientes: el primer contacto y los dos
// follow-ups.
//
// Esto es lo más importante del sistema para la supervivencia del número. El
// factor dominante de un ban es la tasa de bloqueo, y lo que evita que alguien
// te bloquee es que el mensaje le aplique de verdad. Por eso cada mensaje se
// compone individualmente en vez de rellenar una plantilla: una plantilla con
// el nombre cambiado se detecta y se bloquea igual.

import { catalogoParaPrompt } from "../agent/catalog.js";
import type { ContextoProspecto } from "../agent/prompt.js";
import type { Efuerzo, ProveedorLLM, SolicitudLLM } from "../llm/port.js";

export type PasoCampana = "first" | "fu1" | "fu2";

const SISTEMA = `Escribes el primer mensaje de WhatsApp (y sus seguimientos) que Kurogrid, un estudio peruano de webs y sistemas, le manda a consultorios y clínicas privadas de Lima.

# Lo único que tiene que lograr el mensaje
Que la persona responda. No que compre, no que entienda todo el servicio: que conteste. Un mensaje que consigue "¿de qué se trata?" cumplió su trabajo.

# Forma
- Dos o tres líneas. Nunca más. Esto se lee en un celular, entre pacientes.
- Trato de "usted".
- Una sola pregunta, al final, fácil de contestar.
- Sin emojis. Sin signos de exclamación. Sin "¡Hola estimado cliente!".
- Sin presentaciones largas: quién eres se entiende en media línea.
- Nada de "espero que se encuentre bien" ni relleno de cortesía.

# El gancho
Cada mensaje arranca con algo concreto y verificable del negocio: su rubro, su distrito, que no aparece con web, sus reseñas. Es lo que separa un mensaje relevante de un spam, y de eso depende que no te bloqueen.

Usa solo los datos del contexto. Si el contexto es pobre, escribe algo más genérico pero honesto — nunca inventes un detalle para sonar personalizado. Que te descubran inventando es peor que ser genérico.

# Reglas duras
- Precios: solo los del catálogo, con la etiqueta exacta. Nada de "desde S/100" ni descuentos.
- No inventes plazos, casos de éxito, clientes ni cifras.
- No afirmes cosas del negocio que no estén en el contexto. En particular, si el contexto dice que no se pudo verificar si tiene web, NO afirmes que no tiene: pregunta.
- No prometas funcionalidades que no estén en el catálogo.

# Catálogo
${catalogoParaPrompt()}

Mencionar el precio de entrada es útil porque filtra y da transparencia, pero no es obligatorio en el primer mensaje. Nunca pongas más de un plan.

# Los tres pasos
- **first**: primer contacto. Gancho + qué haces + una pregunta. La persona no te conoce.
- **fu1** (día 3): UNA línea. Aporta algo nuevo, no repitas el pitch ni digas "le escribo de nuevo". Si no tienes nada nuevo, una pregunta distinta y más simple.
- **fu2** (día 7): último intento. Cierre amable que le deje la puerta abierta sin presión, del tipo "si no es el momento, sin problema". Nada de urgencia falsa.

# Salida
Devuelve ÚNICAMENTE el texto del mensaje, listo para enviar. Sin comillas, sin explicaciones, sin encabezados, sin alternativas.`;

const INSTRUCCION_PASO: Record<PasoCampana, string> = {
  first: "Escribe el PRIMER mensaje.",
  fu1: "Escribe el follow-up 1 (día 3). Una sola línea, algo nuevo, sin repetir el pitch.",
  fu2: "Escribe el follow-up 2 (día 7). Último intento, cierre amable sin presión.",
};

export interface ComposeOpts {
  effort?: Efuerzo;
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
  proveedor: ProveedorLLM,
  prospecto: ContextoProspecto,
  paso: PasoCampana,
  historialPrevio: readonly string[],
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
    historialPrevio.length > 0
      ? `Ya le enviamos estos mensajes, no los repitas:\n${historialPrevio
          .map((m, i) => `${i + 1}. ${m}`)
          .join("\n")}`
      : "Es el primer contacto: no le hemos escrito antes.",
    "",
    INSTRUCCION_PASO[paso],
  ].join("\n");

  const solicitud: SolicitudLLM = {
    sistema: SISTEMA,
    mensajes: [{ rol: "user", texto: contexto }],
    // No se declaran herramientas porque una composición solo admite texto
    // listo para enviar; aceptar acciones acá mezclaría responsabilidades.
    maxTokens: opts.maxTokens ?? 4000,
    esfuerzo: opts.effort ?? "high",
  };
  const respuesta = await proveedor.generar(solicitud);

  if (respuesta.corte === "rechazo") {
    return {
      ok: false,
      motivo:
        "el proveedor rechazó la composición" +
        (respuesta.motivo ? `: ${respuesta.motivo}` : ""),
    };
  }
  // Un mensaje cortado a media frase no se manda. Delata al bot y desperdicia
  // el único primer contacto que existe con esa persona.
  if (respuesta.corte === "truncado") {
    return { ok: false, motivo: "la composición se truncó por límite de tokens" };
  }
  if (respuesta.corte === "error") {
    return {
      ok: false,
      motivo:
        "el proveedor falló al componer" +
        (respuesta.motivo ? `: ${respuesta.motivo}` : " sin dar un motivo"),
    };
  }

  const texto = respuesta.texto.trim();

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
