// Contrato del pipeline. Tres etapas, cada una agrega información sin borrar la anterior:
//
//   RawProspect  (registro oficial: quién es, dónde, qué teléfono)
//        ↓ enrich
//   EnrichedProspect  (+ Places: ¿tiene web?, ¿cuántas reseñas?)
//        ↓ score
//   ScoredProspect  (+ fit para el plan, y el por qué)
//
// La fuente es siempre un registro oficial, nunca Places. Places solo verifica
// presencia web. Razón: no hay llave común entre Places y los registros, y
// matchear nombre comercial contra razón social falla seguido.

export type RegistrySource = "renipress";

/** Un teléfono normalizado. Solo los `mobile` sirven para WhatsApp. */
export interface Phone {
  /** Tal como venía en el registro, para poder auditar la normalización. */
  raw: string;
  /** Formato E.164 (+51XXXXXXXXX). null si no se pudo normalizar. */
  e164: string | null;
  kind: "mobile" | "landline" | "unknown";
}

/** Ficha cruda salida del registro oficial, sin enriquecer. */
export interface RawProspect {
  source: RegistrySource;
  /** Identificador estable en la fuente. Para RENIPRESS, COD_IPRESS. */
  sourceId: string;
  name: string;
  /** CLASIFICACION en RENIPRESS: "CENTRO ODONTOLOGICO", "POLICLINICOS", etc. */
  classification: string;
  /** CATEGORIA en RENIPRESS (I-1, II-2...). null si no aplica. */
  category: string | null;
  district: string;
  ubigeo: string;
  /**
   * DIRECCION del registro. Calidad pobre: muchas veces es solo el nombre de la
   * calle sin número ("AREQUIPA", "UNIVERSITARIA NORTE"). No sirve para matchear
   * por sí sola.
   */
  address: string;
  /**
   * NORTE/ESTE del registro, ya en grados decimales (no UTM). null cuando el
   * registro no las trae — pasa en ~49% de los casos, y ahí el matching contra
   * Places es notablemente menos confiable.
   */
  lat: number | null;
  lng: number | null;
  phones: Phone[];
}

/**
 * Resultado de buscar el negocio en Google Places.
 *
 * OJO: `websiteUri: null` significa **dato ausente en Places**, no que el
 * negocio no tenga web. Antes de contactar hace falta verificar — por eso
 * existe `matchConfidence` y por eso esto NO decide solo.
 */
export interface WebPresence {
  checkedAt: string;
  placeId: string | null;
  websiteUri: string | null;
  rating: number | null;
  userRatingCount: number | null;
  /**
   * Qué tan seguros estamos de que el Place encontrado ES este prospecto.
   * 0 = no se encontró nada; 1 = match inequívoco.
   * Por debajo de ~0.6 el resultado no se usa para decidir.
   */
  matchConfidence: number;
  /**
   * Si una verificación independiente confirmó que el negocio NO tiene web.
   *
   * `matchConfidence` responde "¿este Place es este prospecto?", que es una
   * pregunta distinta de "¿este negocio tiene web?". Un match perfecto con
   * `websiteUri` nulo sigue sin probar que no exista un sitio: Places
   * simplemente puede no tenerlo cargado.
   *
   * Opcional y con default de "no verificado" a propósito: es un flag de
   * seguridad, y ausente debe significar el lado conservador. Escribirle
   * "vi que no tienes web" a alguien que sí la tiene quema el prospecto y
   * el pitch de una sola vez.
   */
  verificadoSinWeb?: boolean;
}

export interface EnrichedProspect extends RawProspect {
  web: WebPresence;
}

/** Señal individual que sumó o restó al score, con su peso. Para poder auditar. */
export interface ScoreSignal {
  name: string;
  points: number;
  detail: string;
}

export interface ScoredProspect extends EnrichedProspect {
  /** 0-100. No es probabilidad, es orden de prioridad. */
  score: number;
  signals: ScoreSignal[];
  /**
   * false cuando falta información para decidir (ej. matchConfidence bajo).
   * Un prospecto no elegible no se contacta, se revisa a mano.
   */
  eligible: boolean;
  /** Por qué no es elegible. Vacío si lo es. */
  blockers: string[];
}
