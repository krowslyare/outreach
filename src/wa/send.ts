import {
  canContact,
  canSendNow,
  evaluateKillSwitch,
} from "./safety.js";
import type { WaClient } from "./client.js";
import type { SendStep, Store } from "./store.js";
import type { SafetyConfig, SendVerdict } from "./types.js";

export type SendResult =
  | (SendVerdict & { allow: false })
  | {
      allow: true;
      messageId: number;
      waMessageId: string;
    };

export interface SendDependencies {
  store: Pick<
    Store,
    | "loadAccountHealth"
    | "loadRecipientState"
    | "claimSend"
    | "markSent"
    | "markError"
    | "tripKillSwitch"
  >;
  client: Pick<WaClient, "sendText">;
  config: SafetyConfig;
  now: () => Date;
}

/**
 * Cola de serialización de los envíos.
 *
 * `canSendNow` lee `sentToday` y `lastSentAt` y recién después se reclama y se
 * envía. Dos llamadas concurrentes leen el mismo estado antes de que ninguna
 * persista: como sus llaves de idempotencia son distintas, ambas pasan y un
 * `Promise.all` puede superar el tope diario y saltarse por completo la
 * separación mínima. Son límites duros de seguridad, así que no alcanza con
 * que el llamador "sepa" que debe ir serial: se serializa acá.
 */
let cola: Promise<unknown> = Promise.resolve();

/** Un solo intento, con las puertas ordenadas de mayor a menor alcance. */
export function attemptSend(
  deps: SendDependencies,
  e164: string,
  body: string,
  step: SendStep,
): Promise<SendResult> {
  const turno = cola.then(
    () => intentar(deps, e164, body, step),
    () => intentar(deps, e164, body, step),
  );
  // La cola avanza aunque este intento falle; si no, un rechazo la dejaría
  // envenenada y bloquearía todos los envíos siguientes.
  cola = turno.catch(() => undefined);
  return turno;
}

async function intentar(
  deps: SendDependencies,
  e164: string,
  body: string,
  step: SendStep,
): Promise<SendResult> {
  const now = deps.now();
  let health = deps.store.loadAccountHealth(now);

  // El kill switch se evalúa y se PERSISTE antes de tocar la red. Si se dejara
  // para después del envío, una cuenta que ya cruzó el umbral entre intentos
  // manda un mensaje más antes de frenar; y si el tope reducido ya estaba
  // alcanzado, la negación temprana impedía persistir el switch hasta que otro
  // día permitiera un envío.
  const killSwitchPrevio = evaluateKillSwitch(health, deps.config, now);
  if (killSwitchPrevio !== null) {
    deps.store.tripKillSwitch(killSwitchPrevio);
    health = { ...health, killSwitch: killSwitchPrevio };
  }

  const accountVerdict = canSendNow(health, deps.config, now);
  if (!accountVerdict.allow) return accountVerdict;

  const recipientVerdict = canContact(
    deps.store.loadRecipientState(e164),
    deps.config,
    now,
  );
  if (!recipientVerdict.allow) return recipientVerdict;

  // El claim sucede ANTES de la red. Si el proceso muere luego del envío,
  // preferimos no repetirlo: un duplicado parece bot y arriesga el número.
  const messageId = deps.store.claimSend(e164, step, body);
  if (messageId === null) {
    return {
      allow: false,
      reason: `envío ya reclamado (${e164}:${step})`,
      retryAfter: null,
    };
  }

  let waMessageId: string;
  try {
    waMessageId = await deps.client.sendText(e164, body);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.store.markError(messageId, reason);
    throw error;
  }

  deps.store.markSent(messageId, waMessageId);

  // Segunda evaluación, ahora con el envío ya persistido. La de antes del
  // envío es la que protege; ésta solo adelanta el corte para el próximo
  // intento si el estado ya cambió.
  const evaluatedAt = deps.now();
  const killSwitch = evaluateKillSwitch(
    deps.store.loadAccountHealth(evaluatedAt),
    deps.config,
    evaluatedAt,
  );
  if (killSwitch !== null) deps.store.tripKillSwitch(killSwitch);

  return { allow: true, messageId, waMessageId };
}
