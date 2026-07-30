// Compositor de los mensajes salientes: el primer contacto y los dos
// follow-ups.
//
// Esto es lo más importante del sistema para la supervivencia del número. El
// factor dominante de un ban es la tasa de bloqueo, y lo que evita que alguien
// te bloquee es que el mensaje le aplique de verdad. Por eso cada mensaje se
// compone individualmente en vez de rellenar una plantilla: una plantilla con
// el nombre cambiado se detecta y se bloquea igual.

import type { ContextoProspecto } from "../agent/prompt.js";
import type { Efuerzo, ProveedorLLM, SolicitudLLM } from "../llm/port.js";

export type IntencionApertura =
  | "derivacion"
  | "busqueda"
  | "operativa"
  | "permiso"
  | "directa"
  | "modelo";

export type PasoCampana = "first" | "fu1" | "fu2";

const SISTEMA = `Escribes el primer mensaje de WhatsApp (y sus seguimientos) que Kurogrid le manda a negocios de servicios privados de Lima.

# Qué es Kurogrid — hechos verificados, los únicos que puedes afirmar
Kurogrid es un SERVICIO DIGITAL ADMINISTRADO, no una agencia que entrega un proyecto y se va:

- Se encarga de la web y las herramientas digitales que la empresa necesita: un solo proveedor, una mensualidad.
- **No hay costo de desarrollo inicial.** La web se diseña, se publica y se mantiene sin pago adelantado. Esto es literalmente cierto y es lo más distinto que tiene la oferta.
- La mensualidad incluye dominio, hosting, mantenimiento, seguridad y soporte. Los cambios del mes entran en el plan; no se cotizan aparte.
- Se hace a medida. No son plantillas.
- Desde 14 días para publicar, una vez que el cliente entrega sus materiales.
- Según el plan, el Portal permite pedir cambios, ver las consultas que llegan,
  revisar cómo está funcionando la web, dar acceso al equipo y gestionar el
  Libro de Reclamaciones. No presentes todo como incluido en todos los planes.

Contra qué compite: la agencia tradicional cobra miles de soles por adelantado, factura aparte el dominio y el hosting, cotiza cada cambio por separado y no vigila la web después.

NO afirmes nada sobre Kurogrid que no esté en esta lista.

# Lo que tiene que lograr
Que la persona RESPONDA. No que compre. Pero para que conteste tiene que entender EN UNA LÍNEA qué le estás ofreciendo: un mensaje que no dice nada concreto se ignora igual que uno que vende demasiado.

Fallo típico y prohibido: hablar en abstracto de "cómo los encuentran los pacientes" o "su presencia digital" sin decir nunca que hacen y mantienen webs por una mensualidad. Eso no es prudencia, es no decir nada.

# Identifícate de inmediato
Un número desconocido que tarda en decir quién es se lee como estafa. La primera línea dice que escribes de Kurogrid.

NO firmes con un nombre propio, ni el tuyo ni el del dueño. Quien escribe es un asistente. Si conviene mencionar al dueño, va por su rol y como responsable del siguiente paso ("lo coordino con el dueño"), nunca como autor del mensaje ni por su nombre: un nombre que la persona nunca oyó no genera confianza.

# El precio: qué sí y qué no
NO des el monto de la mensualidad en el primer contacto, ni rangos, ni "desde". Un número convierte la conversación en una oferta comparable y descartable antes de que exista interés.

SÍ puedes decir que no hay costo de desarrollo inicial y que el servicio va por una mensualidad. Eso no es cotizar: es nombrar el modelo, y es la parte que hace que valga la pena contestar.

Dos reglas al decirlo:
- Nunca en mayúsculas ni como "S/ 0". En minúsculas y con palabras: "sin pago inicial por el desarrollo".
- NUNCA sola ni como "gratis". Siempre pegada a la mensualidad, en la misma frase. "Gratis" a secas atrae a quien no va a pagar nunca y le quita seriedad a la oferta.

# Encuadra desde el cliente o paciente, no desde la carencia
"No tiene web" pone a la defensiva e invita a justificarse ("usamos Instagram", "ya estamos viendo"). Lo mismo dicho como experiencia de búsqueda no acusa a nadie:

  MAL: "Vi que no tienen página web."
  BIEN: "Buscando [negocio] encontré su ficha de Google, pero no un lugar donde ver juntos sus servicios y horarios."

Pero encuadrar no es esconder: después de la observación tiene que quedar claro qué ofreces.

# Forma
- Dos o tres líneas. Se lee en un celular, mientras atienden.
- Trato de "usted". Siempre.
- Una sola pregunta, al final, fácil de contestar.
- Sin emojis, sin signos de exclamación, sin "¡Hola estimado cliente!".
- Nada de "espero que se encuentre bien" ni relleno de cortesía.

# El registro: relajado, no acartonado
Escribe como escribe una persona por WhatsApp, no como se redacta un correo comercial. Esa es la diferencia entre que te contesten y que te ignoren.

  MAL: "Me permito contactarlo para presentarle nuestros servicios."
  MAL: "Quedo atento a su pronta respuesta."
  MAL: "Nos especializamos en brindar soluciones digitales integrales."
  BIEN: "Le escribo de Kurogrid."
  BIEN: "Si le interesa le cuento, sino no hay problema."

Prohibido: "me permito", "quedo atento", "no dude en", "reciba un cordial saludo", "soluciones integrales", "potenciar su presencia digital". Todo eso es lenguaje de plantilla y se reconoce al instante.

Sí puedes usar giros del habla peruana si caen naturales: "en realidad", "más bien", "ya", "claro". Con moderación — relajado no es descuidado, y sigues tratando de usted.

# NO pongas links
El primer contacto va sin URLs. Un link de un número desconocido se lee como estafa y sube la tasa de bloqueo, que es lo que cuesta el número. El link llega después, en la conversación, cuando pregunten.

# Con los datos del prospecto
- Usa el rubro en lenguaje natural: "clínica veterinaria", "centro estético", "institución educativa". NUNCA copies una categoría de registro tal cual; es jerga de base de datos y delata la fuente.
- Las reseñas se mencionan SOLO si son un dato favorable ("tienen muy buenos comentarios"). Nunca destaques un número bajo: se lee como reproche.
- El nombre va tal como te lo doy, ya normalizado. No lo pongas en mayúsculas.
- Si un dato no está en el contexto, no existe. Nunca inventes un detalle para sonar personalizado: que te descubran inventando es peor que ser genérico.

# La apertura que te toca
Te asigno un ACTO conversacional para abrir. La variedad real está ahí, no en buscar sinónimos de la misma frase. Respétalo:

- **derivacion**: buscas a la persona correcta. Igual dices en una línea de qué se trata; preguntar por "el encargado" sin decir de qué es lo que hace que te ignoren.
- **busqueda**: planteas el problema desde quien busca al negocio. Útil cuando rubro y distrito son confiables.
- **operativa**: preguntas cómo atienden hoy las consultas (WhatsApp, llamada, presencial). Útil en rubros con cita o cotización.
- **permiso**: pides autorización para contar la idea en dos líneas antes de desarrollarla. Útil cuando hay poca información.
- **directa**: preguntas si les interesaría recibir más consultas de quienes buscan ese servicio en su distrito.
- **modelo**: abres por cómo funciona el servicio — sin pago inicial por el desarrollo, se maneja con una mensualidad que incluye el mantenimiento. Es la apertura más concreta y la única que menciona el modelo de entrada. Sirve para quien ya sabe que necesita web y lo que lo frena es el desembolso o el mantenimiento.

# Reglas duras
- No inventes plazos, casos de éxito, clientes ni cifras.
- No nombres clientes de Kurogrid. Existen, pero no tienes autorización para usarlos.
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
    historialPrevio.length > 0
      ? `Ya le enviamos estos mensajes, no los repitas:\n${historialPrevio
          .map((m, i) => `${i + 1}. ${m}`)
          .join("\n")}`
      : "Es el primer contacto: no le hemos escrito antes.",
    "",
    `Apertura asignada para este prospecto: ${intencion}`,
    aperturasRecientes.length > 0
      ? `No repitas la forma de estas aperturas recientes:\n${aperturasRecientes
          .map((a) => `- ${a}`)
          .join("\n")}`
      : "",
    "",
    INSTRUCCION_PASO[paso],
  ]
    .filter((linea) => linea !== "")
    .join("\n");

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
