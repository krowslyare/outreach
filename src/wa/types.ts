// Contrato del canal de WhatsApp.
//
// Principio de diseño: el motor de seguridad es DETERMINISTA y vive FUERA del
// agente. Los topes diarios, la supresión, el horario y el kill switch son
// código, no prompt. A un LLM se le convence de hacer una excepción; a esto no.
// El agente pide permiso para enviar; este módulo concede o niega.

/** Veredicto de si se puede enviar. `reason` va al log, no al prospecto. */
export type SendVerdict =
  | { allow: true }
  | { allow: false; reason: string; retryAfter: Date | null };

export interface KillSwitchState {
  tripped: boolean;
  reason: string | null;
  trippedAt: Date | null;
}

/**
 * Salud de la cuenta. Lo que decide si hoy se envía y cuánto.
 *
 * `deviceRate` es la señal primaria de salud del número: fracción de primeros
 * mensajes que alcanzaron ACK_DEVICE. Si WhatsApp te está estrangulando, los
 * mensajes dejan de llegar al dispositivo aunque el server los acepte.
 * Deliberadamente NO se usa ACK_READ: mucha gente desactiva las confirmaciones
 * de lectura, y eso daría falsos positivos constantes.
 */
export interface AccountHealth {
  /** Días corridos desde el primer envío. Define el escalón del ramp-up. */
  dayIndex: number;
  sentToday: number;
  lastSentAt: Date | null;
  /** Fracción 0..1 de la ventana reciente. null si la muestra es insuficiente. */
  deviceRate: number | null;
  deviceRateSample: number;
  /** Baseline sano, medido en el piloto. Sin esto el kill switch no tiene con qué comparar. */
  deviceRateBaseline: number | null;
  killSwitch: KillSwitchState;
}

/** Estado por destinatario. Manda sobre cualquier consideración de campaña. */
export interface RecipientState {
  e164: string;
  /** Opt-out. Permanente e irreversible por código: solo se quita a mano. */
  suppressed: boolean;
  /**
   * El handoff ya ocurrió y la conversación es humana. El bot NO vuelve a
   * escribir nunca. Fallar acá significa que el bot le habla encima al dueño
   * frente a un prospecto caliente, que es el peor error posible del sistema.
   */
  humanTakeover: boolean;
  /**
   * Primer contacto. La cadencia se mide SIEMPRE desde acá, no desde el último
   * mensaje: con followUpDays [3, 7] y midiendo desde el último, el segundo
   * follow-up caería el día 10 (3 + 7) en vez del 7.
   */
  firstOutboundAt: Date | null;
  lastOutboundAt: Date | null;
  /** Cualquier entrante, incluido un saludo automático. Rastro de auditoría. */
  lastInboundAt: Date | null;
  /**
   * El último entrante que una PERSONA escribió. Lo único que corta la cadencia.
   *
   * Separado de `lastInboundAt` porque casi todo establecimiento tiene saludo
   * automático de WhatsApp Business y llega segundos después del primer
   * contacto: tratarlo como respuesta mataba los follow-ups de toda la lista.
   * Ver clasificar.ts para el criterio, que está sesgado a "humano" a propósito.
   */
  lastHumanInboundAt: Date | null;
  /** Cuántos follow-ups se enviaron ya (sin contar el primer mensaje). */
  followUpCount: number;
}

export interface SafetyConfig {
  timezone: string;
  /** Ventana horaria local inclusiva-exclusiva: [start, end). */
  windowStartHour: number;
  windowEndHour: number;
  /** Días activos, 1=lunes .. 7=domingo. Por defecto lun-sáb. */
  activeWeekdays: number[];
  /** Separación mínima entre envíos. El jitter se aplica encima de esto. */
  minGapSeconds: number;
  maxGapSeconds: number;
  /** Caída en puntos de deviceRate vs baseline que dispara el kill switch. */
  deviceRateDropPoints: number;
  /** Muestra mínima antes de creerle a deviceRate. Con 15/día, menos que esto es ruido. */
  deviceRateMinSample: number;
  /** Días después del primer contacto en que toca follow-up. */
  followUpDays: number[];
  maxFollowUps: number;
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  timezone: "America/Lima",
  windowStartHour: 9,
  windowEndHour: 19,
  activeWeekdays: [1, 2, 3, 4, 5, 6],
  minGapSeconds: 180,
  maxGapSeconds: 900,
  deviceRateDropPoints: 0.15,
  deviceRateMinSample: 30,
  followUpDays: [3, 7],
  maxFollowUps: 2,
};
