// Distingue un autorespondedor de WhatsApp Business de una persona escribiendo.
//
// Por qué existe: casi todo establecimiento tiene mensaje de bienvenida
// configurado, y llega segundos después del primer contacto. Sin esta
// distinción ese saludo automático cuenta como "el prospecto respondió", con
// tres consecuencias: la cadencia de follow-ups muere para toda la lista, se
// gasta una llamada al LLM contestándole a un robot, y "en breve un asesor lo
// atenderá" puede leerse como interés y escalar un lead que no existe.
//
// EL ERROR CARO ES EL FALSO "AUTOMÁTICO". Si tratamos a una persona como
// autorespondedor, le seguimos mandando follow-ups a alguien que ya contestó:
// eso es grosero y quema el prospecto. Si tratamos a un robot como persona,
// perdemos dos follow-ups y nada más. Por eso todas las reglas de acá están
// escritas para llegar a "humano" y solo la conjunción completa de señales
// llega a "automático".

/** Un inbound automático se registra pero no corta la cadencia ni llama al LLM. */
export type ClaseInbound = "automatico" | "humano";

/**
 * Cuánto puede tardar un autorespondedor en llegar.
 *
 * Generoso a propósito frente a los ~2s observados: el teléfono del negocio
 * puede estar con mala señal. Pasarse de largo no es peligroso porque la
 * latencia es condición NECESARIA y no suficiente — todavía hacen falta las
 * señales de plantilla. Un minuto después del saludo, además, una persona ya
 * habría escrito algo que no calza con ninguna.
 */
export const VENTANA_AUTOMATICA_MS = 60_000;

/**
 * Frases de plantilla de bienvenida y de ausencia.
 *
 * No pretenden cubrir todas las redacciones posibles: lo que no matchea cae en
 * "humano", que es el lado seguro. Ampliar esta lista solo con redacciones
 * observadas de verdad, nunca con variantes imaginadas.
 */
const PATRONES_PLANTILLA: readonly RegExp[] = [
  /gracias por (comunicarte|comunicarse|contactarnos|escribirnos|tu mensaje|su mensaje)/iu,
  /bienvenid[oa]s? a/iu,
  /en breve (te|le|los)? ?(atender|responder|contactar|escrib)/iu,
  /(un|nuestro) asesor .{0,30}(atender|contactar|responder)/iu,
  /a la brevedad/iu,
  /(nuestro|el) horario de (atenci[oó]n|trabajo)/iu,
  /horario de atenci[oó]n/iu,
  /(en estos momentos|por el momento|actualmente) no (podemos|nos encontramos|estamos)/iu,
  /fuera de(l)? horario/iu,
  /d[eé]janos tu (nombre|mensaje|consulta)/iu,
  /(responderemos|te responderemos|le responderemos) (a la brevedad|apenas|en cuanto|lo antes)/iu,
  /este es un mensaje autom[aá]tico/iu,
  /mensaje autom[aá]tico/iu,
];

/**
 * Lo que se sabe del mensaje entrante al momento de clasificarlo.
 *
 * `ultimoOutboundAt` viene del store y no del reloj: la correlación temporal es
 * contra lo que nosotros mandamos, no contra "hace rato".
 */
export interface SenalesInbound {
  body: string;
  /** `message.type` de whatsapp-web.js. Solo "chat" es texto plano. */
  tipo: string;
  tieneMedia: boolean;
  /** El mensaje cita a otro. Un robot de bienvenida no cita nada. */
  citaOtroMensaje: boolean;
  at: Date;
  ultimoOutboundAt: Date | null;
}

export interface Clasificacion {
  clase: ClaseInbound;
  /** Por qué se clasificó así. Va al log y a la auditoría, no al prospecto. */
  motivo: string;
}

const HUMANO = (motivo: string): Clasificacion => ({ clase: "humano", motivo });

export function clasificarInbound(senales: SenalesInbound): Clasificacion {
  // Audio, imagen, sticker, ubicación, contacto: un mensaje de bienvenida es
  // texto. Cualquier otra cosa es actividad humana, y además el agente no puede
  // leerla, así que tiene que cortar la cadencia y quedar para revisión.
  if (senales.tieneMedia) return HUMANO("trae media");
  if (senales.tipo !== "chat") return HUMANO(`tipo no textual (${senales.tipo})`);

  // Veto duro. Citar nuestro mensaje exige haberlo leído y haber elegido
  // responderlo: ningún autorespondedor hace eso.
  if (senales.citaOtroMensaje) return HUMANO("cita un mensaje previo");

  // Sin un saliente con el que correlacionar no hay ventana que medir. Alguien
  // escribiendo de la nada es, por definición, iniciativa humana.
  if (senales.ultimoOutboundAt === null) {
    return HUMANO("no hay saliente previo con el que correlacionar");
  }

  const latenciaMs = senales.at.getTime() - senales.ultimoOutboundAt.getTime();
  // La latencia negativa no es un caso teórico: el timestamp del inbound lo pone
  // el teléfono del prospecto y puede venir corrido respecto del nuestro. Ante
  // relojes que no concuerdan, no se clasifica como automático.
  if (latenciaMs < 0) return HUMANO("timestamp anterior al saliente");
  if (latenciaMs > VENTANA_AUTOMATICA_MS) {
    return HUMANO(`llegó ${Math.round(latenciaMs / 1000)}s después del saliente`);
  }

  const patron = PATRONES_PLANTILLA.find((p) => p.test(senales.body));
  if (patron === undefined) {
    // Rápido pero sin forma de plantilla. Puede ser una recepcionista mirando el
    // chat que contesta "¿de qué se trata?" en cinco segundos. Es humano.
    return HUMANO("sin señales de plantilla");
  }

  return {
    clase: "automatico",
    motivo: `plantilla ${patron.source} a los ${Math.round(latenciaMs / 1000)}s`,
  };
}
