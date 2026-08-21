// Plantillas para lo que la API oficial NO permite con texto libre.
//
// En Cloud API, todo mensaje business-initiated sale de una plantilla
// pre-aprobada por Meta. Las plantillas se registran y aprueban en el portal
// de Meta —acá solo se las nombra—, con esta correspondencia:
//
//   WHATSAPP_PLANTILLA_FOLLOWUP      follow-ups (fu1/fu2) fuera de ventana.
//                                    Categoría recomendada: utility.
//   WHATSAPP_PLANTILLA_NOTIFICACION  el aviso de handoff hacia NUMERO_HUMANO.
//                                    Categoría recomendada: utility.
//
// El cuerpo de la plantilla lleva huecos {{1}}…{{n}}. Este módulo valida que
// los valores lleguen completos ANTES de tocar la red: Graph rechaza un envío
// mal armado con un error genérico, y quien opera merece saber si el problema
// es la configuración local o la plataforma.

/** Una plantilla tal como quedó registrada en el portal de Meta. */
export interface PlantillaAprobada {
  /** El nombre EXACTO de la plantilla aprobada. */
  nombre: string;
  /** Código de idioma de ESA versión aprobada (es, es_PE, en…). */
  idioma: string;
  /**
   * Cuántos huecos {{n}} tiene el body aprobado. Va en la configuración y no
   * se adivina al enviar: si Meta aprobió tres huecos y acá se mandan dos, el
   * rechazo debe ocurrir antes de la red, con un motivo que se entienda.
   */
  parametros: number;
}

/**
 * Qué hueco llena cada posición. Documentación viva para quien registra la
 * plantilla en Meta: si cambia este orden, cambió el orden de los {{n}} allá.
 */
export const PARAMETROS_POR_PROPOSITO = {
  /** [1] = el mensaje completo ya compuesto y auditado. */
  followup: ["mensaje"],
  /** [1] = el resumen del lead para entrar en contexto sin abrir nada más. */
  notificacion: ["resumen"],
} as const;

export type PropositoPlantilla = keyof typeof PARAMETROS_POR_PROPOSITO;

const PREFIJO_POR_PROPOSITO: Record<PropositoPlantilla, string> = {
  followup: "WHATSAPP_PLANTILLA_FOLLOWUP",
  notificacion: "WHATSAPP_PLANTILLA_NOTIFICACION",
};

/**
 * Lee la plantilla configurada para un propósito, o undefined si no hay.
 *
 * Sin plantilla NO hay fallback silencioso a texto libre: fuera de ventana ese
 * envío rebota en Meta con #131047/#131026, y un error de plataforma confuso
 * donde debía haber uno de configuración es exactamente el tipo de trampa que
 * este repo existe para evitar.
 */
export function plantillaDesdeEntorno(
  entorno: NodeJS.ProcessEnv,
  proposito: PropositoPlantilla,
): PlantillaAprobada | undefined {
  const prefijo = PREFIJO_POR_PROPOSITO[proposito];
  const nombre = entorno[prefijo]?.trim();
  if (nombre === undefined || nombre === "") return undefined;
  return {
    nombre,
    idioma: entorno[`${prefijo}_IDIOMA`]?.trim() || "es",
    parametros: PARAMETROS_POR_PROPOSITO[proposito].length,
  };
}

/** El objeto `template` del payload de Graph, o el motivo exacto del rechazo. */
export function cuerpoPlantilla(
  plantilla: PlantillaAprobada,
  valores: readonly string[],
): { ok: true; template: unknown } | { ok: false; motivo: string } {
  if (valores.length !== plantilla.parametros) {
    return {
      ok: false,
      motivo:
        `la plantilla "${plantilla.nombre}" espera ${plantilla.parametros} ` +
        `parámetro(s) y recibió ${valores.length}`,
    };
  }
  for (const valor of valores) {
    if (valor.trim() === "") {
      return {
        ok: false,
        motivo: "hay un parámetro vacío: Meta rechaza huecos sin contenido",
      };
    }
  }
  return {
    ok: true,
    template: {
      name: plantilla.nombre,
      language: { code: plantilla.idioma },
      components: [
        {
          type: "body",
          parameters: valores.map((valor) => ({ type: "text", text: valor })),
        },
      ],
    },
  };
}
