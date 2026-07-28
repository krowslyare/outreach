// Motor de seguridad. Todo acá es PURO: sin IO, sin red, sin reloj implícito.
// El `now` siempre entra por parámetro para que sea testeable de verdad.
//
// Orden de las verificaciones = orden de importancia. El kill switch va primero
// porque cuando está activo nada más importa.

import type {
  AccountHealth,
  KillSwitchState,
  RecipientState,
  SafetyConfig,
  SendVerdict,
} from "./types.ts";

const DENY = (reason: string, retryAfter: Date | null = null): SendVerdict => ({
  allow: false,
  reason,
  retryAfter,
});
const ALLOW: SendVerdict = { allow: true };

/**
 * Escalones del ramp-up: día → tope diario. Fuera de la tabla, tope pleno.
 *
 * Calibrado para ESTE número, que tiene cinco meses de antigüedad y actividad
 * previa. La escalera anterior (3/5/10/15) era la de un número recién
 * registrado, donde el riesgo de baneo es otro.
 *
 * Además, empezar tan abajo tenía un costo que no se ve: `deviceRateMinSample`
 * son 30 mensajes, así que a 3 por día el kill switch pasaba diez días sin
 * poder evaluar nada — y su señal es justo la que detecta que te están
 * bloqueando. El ramp ultraconservador retrasaba el instrumento que lo haría
 * innecesario.
 *
 * OJO: el tope cuenta MENSAJES, no prospectos. Desde el día 3 los follow-ups
 * compiten por el mismo cupo, así que los contactos nuevos por día son bastante
 * menos que el tope. Por eso la escalera sigue subiendo aunque el objetivo de
 * conversaciones nuevas se mantenga.
 */
const RAMP_LADDER: ReadonlyArray<{ untilDay: number; cap: number }> = [
  { untilDay: 2, cap: 30 },
  { untilDay: 4, cap: 40 },
  { untilDay: 7, cap: 50 },
];
const RAMP_FULL_CAP = 60;

/**
 * Tope de envíos para el día.
 *
 * `healthy` en false NO detiene la operación: la congela en el escalón anterior.
 * Detener del todo es trabajo del kill switch; esto es el freno suave, para no
 * seguir subiendo volumen cuando las señales no acompañan.
 */
export function dailyCap(dayIndex: number, healthy: boolean): number {
  const index = RAMP_LADDER.findIndex((step) => dayIndex <= step.untilDay);
  // index === -1 significa que ya salimos de la tabla: tope pleno.
  const beyondLadder = index === -1;
  const currentCap = beyondLadder ? RAMP_FULL_CAP : RAMP_LADDER[index]!.cap;
  if (healthy) return currentCap;

  // Sin salud confirmada, retrocede UN escalón, no al principio.
  // Ojo con `beyondLadder`: tratar el -1 como "índice 0" mandaba el tope de 20
  // a 3 ante cualquier señal floja, que es una caída de volumen absurda.
  if (beyondLadder) return RAMP_LADDER[RAMP_LADDER.length - 1]!.cap;
  if (index === 0) return RAMP_LADDER[0]!.cap;
  return RAMP_LADDER[index - 1]!.cap;
}

/** Hora y día de la semana en la zona configurada, sin dependencias. */
export function zonedParts(
  now: Date,
  timeZone: string,
): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const get = (type: string) => {
    const found = parts.find((p) => p.type === type)?.value;
    if (found === undefined) throw new Error(`falta ${type} al formatear la fecha`);
    return Number(found);
  };

  // Reconstruir la fecha local como si fuera UTC para sacar el día de la semana
  // sin que el offset del host se meta en el cálculo.
  const asUtc = new Date(
    Date.UTC(get("year"), get("month") - 1, get("day")),
  );
  // getUTCDay da 0=domingo; el config usa ISO 1=lunes..7=domingo.
  const weekday = asUtc.getUTCDay() === 0 ? 7 : asUtc.getUTCDay();

  return { hour: get("hour"), weekday };
}

/** ¿La muestra de deviceRate alcanza para creerle? */
export function hasUsableHealthSignal(
  health: AccountHealth,
  config: SafetyConfig,
): boolean {
  return (
    health.deviceRate !== null &&
    health.deviceRateBaseline !== null &&
    health.deviceRateSample >= config.deviceRateMinSample
  );
}

/**
 * ¿Está sana la cuenta? Sin señal usable devuelve true: al arrancar no hay
 * baseline, y bloquear por falta de datos impediría justamente generarlos.
 * El ramp-up es lo que contiene el riesgo mientras la señal madura.
 */
export function isHealthy(health: AccountHealth, config: SafetyConfig): boolean {
  if (!hasUsableHealthSignal(health, config)) return true;
  return health.deviceRate! > health.deviceRateBaseline! - config.deviceRateDropPoints;
}

/**
 * Evalúa si corresponde disparar el kill switch por deterioro de ACK_DEVICE.
 * Devuelve null si no hay cambio. No des-dispara: reactivar es decisión humana,
 * porque si el número se degradó, seguir enviando lo empeora.
 */
export function evaluateKillSwitch(
  health: AccountHealth,
  config: SafetyConfig,
  now: Date,
): KillSwitchState | null {
  if (health.killSwitch.tripped) return null;
  if (!hasUsableHealthSignal(health, config)) return null;
  if (isHealthy(health, config)) return null;

  const rate = (health.deviceRate! * 100).toFixed(0);
  const base = (health.deviceRateBaseline! * 100).toFixed(0);
  return {
    tripped: true,
    reason:
      `ACK_DEVICE cayó a ${rate}% contra un baseline de ${base}% ` +
      `(muestra ${health.deviceRateSample}). Revisar el número antes de reanudar.`,
    trippedAt: now,
  };
}

/** Kill switch duro, para eventos que ya son el ban ocurriendo. */
export function hardKill(reason: string, now: Date): KillSwitchState {
  return { tripped: true, reason, trippedAt: now };
}

/** Puerta a nivel cuenta: ¿se puede enviar algo ahora mismo? */
export function canSendNow(
  health: AccountHealth,
  config: SafetyConfig,
  now: Date,
): SendVerdict {
  if (health.killSwitch.tripped) {
    return DENY(`kill switch activo: ${health.killSwitch.reason ?? "sin detalle"}`);
  }

  const { hour, weekday } = zonedParts(now, config.timezone);

  if (!config.activeWeekdays.includes(weekday)) {
    return DENY(`día no activo (weekday ${weekday})`);
  }
  if (hour < config.windowStartHour || hour >= config.windowEndHour) {
    return DENY(
      `fuera de la ventana ${config.windowStartHour}:00-${config.windowEndHour}:00 (son ${hour}:00 en ${config.timezone})`,
    );
  }

  const cap = dailyCap(health.dayIndex, isHealthy(health, config));
  if (health.sentToday >= cap) {
    return DENY(`tope diario alcanzado (${health.sentToday}/${cap}, día ${health.dayIndex})`);
  }

  if (health.lastSentAt !== null) {
    const elapsedSeconds = (now.getTime() - health.lastSentAt.getTime()) / 1000;
    if (elapsedSeconds < config.minGapSeconds) {
      const retryAfter = new Date(
        health.lastSentAt.getTime() + config.minGapSeconds * 1000,
      );
      return DENY(
        `separación mínima no cumplida (${Math.round(elapsedSeconds)}s de ${config.minGapSeconds}s)`,
        retryAfter,
      );
    }
  }

  return ALLOW;
}

/**
 * Puerta a nivel destinatario. Se evalúa DESPUÉS de canSendNow y manda sobre
 * cualquier consideración de campaña.
 */
export function canContact(
  recipient: RecipientState,
  config: SafetyConfig,
  now: Date,
): SendVerdict {
  if (recipient.suppressed) {
    return DENY("destinatario en supresión (opt-out)");
  }
  if (recipient.humanTakeover) {
    return DENY("conversación tomada por humano: el bot no vuelve a escribir");
  }

  // Si contestó, la cadencia automática se termina: responder es trabajo del
  // agente sobre lo que dijo, no del secuenciador.
  //
  // Solo cuenta el entrante HUMANO. Mirar `lastInboundAt` incluía el saludo
  // automático de WhatsApp Business, que llega a los segundos del primer
  // contacto y que tiene configurado casi todo establecimiento: con eso, ningún
  // follow-up de la lista se enviaba nunca y cada prospecto figuraba como "ya
  // respondió", que es justo lo que uno espera ver en el log.
  if (recipient.lastHumanInboundAt !== null) {
    return DENY("el destinatario respondió: fuera de la cadencia automática");
  }

  // "Nunca contactado" exige que NINGUNA señal de contacto previo exista. Mirar
  // solo firstOutboundAt dejaba escapar estados inconsistentes (followUpCount>0
  // sin fecha) por este early-return, salteándose el tope de follow-ups.
  const everContacted =
    recipient.firstOutboundAt !== null ||
    recipient.lastOutboundAt !== null ||
    recipient.followUpCount > 0;
  if (!everContacted) return ALLOW; // primer contacto

  if (recipient.followUpCount >= config.maxFollowUps) {
    return DENY(`máximo de follow-ups alcanzado (${recipient.followUpCount})`);
  }

  const nextFollowUpDay = config.followUpDays[recipient.followUpCount];
  if (nextFollowUpDay === undefined) {
    return DENY("no hay más follow-ups configurados");
  }

  // Medido desde el PRIMER contacto: la cadencia es día 0 / 3 / 7 del prospecto,
  // no un intervalo relativo que se corre solo con cada mensaje que mandamos.
  // Si falta la fecha del primero, cae al último: atrasa el follow-up en vez de
  // adelantarlo, que es el lado seguro del error.
  const reference = recipient.firstOutboundAt ?? recipient.lastOutboundAt;
  if (reference === null) {
    return DENY("estado inconsistente: hay follow-ups pero no hay fecha de contacto");
  }

  const daysSinceFirst = Math.floor(
    (now.getTime() - reference.getTime()) / 86_400_000,
  );
  if (daysSinceFirst < nextFollowUpDay) {
    const retryAfter = new Date(
      reference.getTime() + nextFollowUpDay * 86_400_000,
    );
    return DENY(
      `todavía no toca el follow-up ${recipient.followUpCount + 1} (día ${daysSinceFirst} de ${nextFollowUpDay})`,
      retryAfter,
    );
  }

  return ALLOW;
}

/**
 * Segundos a esperar antes del próximo envío. `random` entra por parámetro para
 * poder testear el jitter de forma determinista.
 */
export function nextGapSeconds(
  config: SafetyConfig,
  random: () => number = Math.random,
): number {
  const span = config.maxGapSeconds - config.minGapSeconds;
  return Math.round(config.minGapSeconds + random() * span);
}

/**
 * Detección de opt-out sobre el texto entrante.
 *
 * Deliberadamente amplia y sin IA: dudar acá cuesta el número, y un falso
 * positivo solo cuesta un prospecto. Ante la duda, suprime.
 */
const OPT_OUT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bno\s+(me\s+)?(escrib|contact|molest|insist|jod)/i,
  // Cubre "no me interesa", "no estoy interesado", "no estamos interesadas",
  // "no interesado". Era el hueco más grande: es la forma más común en español.
  /\bno\s+(me\s+|nos\s+)?interesa/i,
  /\bno\s+(estoy|estamos|est[aá]n?)\s+interesad/i,
  /\bno\s+interesad/i,
  /\bgracias\s*,?\s*pero\s+no\b/i,
  /\bd[ée]jame?\s+en\s+paz\b/i,
  /\bd[ée]jenme\s+en\s+paz\b/i,
  /\bb[oó]rrame\b/i,
  /\bsp?am\b/i,
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bqu[ií]tame\b/i,
  /\bc[oó]mo\s+(conseguiste|obtuviste)\s+mi\s+n[uú]mero\b/i,
  /\breportar\b/i,
  /\bdenunciar\b/i,
];

export function isOptOut(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(normalized));
}
