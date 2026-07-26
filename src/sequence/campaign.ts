import type { ClienteClaude } from "../agent/agent.js";
import type { ContextoProspecto } from "../agent/prompt.js";
import type { WaClient } from "../wa/client.js";
import { canContact, canSendNow, nextGapSeconds } from "../wa/safety.js";
import { attemptSend } from "../wa/send.js";
import type { Store } from "../wa/store.js";
import type { SafetyConfig } from "../wa/types.js";
import { componerMensaje, type PasoCampana } from "./compose.js";

const MAX_POR_DEFECTO = 20;

export interface OpcionesTanda {
  max?: number;
  dryRun?: boolean;
}

export interface MensajeCompuesto {
  e164: string;
  nombre: string;
  paso: PasoCampana;
  texto: string;
}

export interface ResumenTanda {
  enviados: number;
  saltadosPorDestinatario: number;
  fallosComposicion: number;
  motivoTerminacion: string;
  mensajesCompuestos: MensajeCompuesto[];
}

type CampaignStore = Pick<
  Store,
  | "candidatosParaContactar"
  | "loadAccountHealth"
  | "loadRecipientState"
  | "loadFichaProspecto"
  | "mensajesEnviados"
  | "claimSend"
  | "markSent"
  | "markError"
  | "tripKillSwitch"
>;

export interface DependenciasCampana {
  store: CampaignStore;
  cliente: ClienteClaude;
  client: Pick<WaClient, "sendText">;
  config: SafetyConfig;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  log?: (mensaje: string) => void;
}

/**
 * De qué paso toca el próximo mensaje.
 *
 * NO se puede derivar solo de `followUpCount`. Ese campo cuenta follow-ups
 * "sin contar el primer mensaje", así que vale 0 tanto cuando no se envió nada
 * como cuando ya se envió el primero. Confundirlos hace que se intente
 * reclamar 'first' de nuevo: `claimSend` lo rechaza por la llave de
 * idempotencia y el prospecto queda atascado sin recibir jamás un follow-up.
 *
 * `firstOutboundAt` es lo que distingue los dos estados.
 */
function pasoPara(estado: {
  firstOutboundAt: Date | null;
  followUpCount: number;
}): PasoCampana | null {
  if (estado.firstOutboundAt === null) return "first";
  if (estado.followUpCount === 0) return "fu1";
  if (estado.followUpCount === 1) return "fu2";
  return null;
}

function contextoDe(
  ficha: NonNullable<ReturnType<Store["loadFichaProspecto"]>>,
): ContextoProspecto {
  return ficha;
}

/**
 * Ejecuta una tanda serial de campaña.
 *
 * Las puertas se consultan antes del compositor porque cada llamada a Claude
 * cuesta dinero. `attemptSend` las repite luego: esa duplicación es deliberada,
 * ya que otro proceso puede cambiar la salud o el destinatario mientras se
 * compone el texto.
 */
export async function ejecutarTanda(
  deps: DependenciasCampana,
  opts: OpcionesTanda = {},
): Promise<ResumenTanda> {
  const max = opts.max ?? MAX_POR_DEFECTO;
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new Error("max requiere un entero positivo");
  }

  const candidatos = deps.store.candidatosParaContactar(max);
  const resumen: ResumenTanda = {
    enviados: 0,
    saltadosPorDestinatario: 0,
    fallosComposicion: 0,
    motivoTerminacion: "",
    mensajesCompuestos: [],
  };

  for (const [indice, candidato] of candidatos.entries()) {
    const ahora = deps.now();
    const veredictoCuenta = canSendNow(
      deps.store.loadAccountHealth(ahora),
      deps.config,
      ahora,
    );
    if (!veredictoCuenta.allow) {
      // Una puerta de cuenta aplica a toda la tanda. Seguir recorriendo no
      // encontraría un destinatario distinto que pudiera saltársela.
      resumen.motivoTerminacion = veredictoCuenta.reason;
      deps.log?.(`Tanda terminada: ${veredictoCuenta.reason}`);
      return resumen;
    }

    const estado = deps.store.loadRecipientState(candidato.e164);
    const veredictoDestinatario = canContact(estado, deps.config, ahora);
    if (!veredictoDestinatario.allow) {
      resumen.saltadosPorDestinatario += 1;
      deps.log?.(
        `${candidato.e164} saltado: ${veredictoDestinatario.reason}`,
      );
      continue;
    }

    const paso = pasoPara(estado);
    if (paso === null) {
      // El compositor solo tiene tres pasos. Un estado fuera de ese contrato
      // no debe improvisar un cuarto mensaje ni tumbar a los demás candidatos.
      resumen.saltadosPorDestinatario += 1;
      deps.log?.(
        `${candidato.e164} saltado: followUpCount fuera de la secuencia (${estado.followUpCount})`,
      );
      continue;
    }

    const ficha = deps.store.loadFichaProspecto(candidato.e164);
    if (ficha === null) {
      // Sin ficha no existe contexto verificable para personalizar. Mandar un
      // texto genérico acá aumentaría justo el riesgo que evita el compositor.
      resumen.fallosComposicion += 1;
      deps.log?.(`${candidato.e164} sin ficha de prospecto; no se compone`);
      continue;
    }

    const composicion = await componerMensaje(
      deps.cliente,
      contextoDe(ficha),
      paso,
      deps.store.mensajesEnviados(candidato.e164),
    );
    if (!composicion.ok) {
      resumen.fallosComposicion += 1;
      deps.log?.(
        `${candidato.e164} no se compuso: ${composicion.motivo}`,
      );
      continue;
    }

    if (opts.dryRun === true) {
      resumen.mensajesCompuestos.push({
        e164: candidato.e164,
        nombre: ficha.nombre,
        paso,
        texto: composicion.texto,
      });
      continue;
    }

    const resultado = await attemptSend(
      {
        store: deps.store,
        client: deps.client,
        config: deps.config,
        now: deps.now,
      },
      candidato.e164,
      composicion.texto,
      paso,
    );
    if (!resultado.allow) {
      // Esta puerta puede perder una carrera después de componer. Se registra
      // pero no termina la tanda: el siguiente ciclo vuelve a medir la cuenta.
      deps.log?.(`${candidato.e164} no se envió: ${resultado.reason}`);
      continue;
    }

    resumen.enviados += 1;
    deps.log?.(`${candidato.e164} enviado (${paso})`);

    if (indice < candidatos.length - 1) {
      // El jitter evita una cadencia mecánica. No se duerme tras el último
      // candidato porque ya no existe otro envío de esta tanda que separar.
      await deps.sleep(nextGapSeconds(deps.config, deps.random) * 1_000);
    }
  }

  resumen.motivoTerminacion =
    `tanda completada (${candidatos.length} candidatos evaluados)`;
  return resumen;
}
