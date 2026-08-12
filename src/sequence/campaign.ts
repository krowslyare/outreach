import type { ContextoProspecto } from "../agent/prompt.js";
import type { ProveedorLLM } from "../llm/port.js";
import type { WaClient } from "../wa/client.js";
import { canContact, canSendNow, nextGapSeconds } from "../wa/safety.js";
import { attemptSend, attemptSendImage } from "../wa/send.js";
import type { Store } from "../wa/store.js";
import type { SafetyConfig } from "../wa/types.js";
import { auditarMensaje } from "./auditoria.js";
import {
  componerMensaje,
  type IntencionApertura,
  type PasoCampana,
} from "./compose.js";
import { normalizarNombre, rubroNatural } from "./normalizar.js";
import {
  captionVisual,
  type VisualAprobado,
} from "./visual.js";

const MAX_POR_DEFECTO = 20;

export interface OpcionesTanda {
  max?: number;
  dryRun?: boolean;
  /** Restringe la tanda al paso indicado sin rellenar el cupo con otros pasos. */
  paso?: PasoCampana;
  /** Excluye aperturas y deja entrar únicamente follow-ups que ya correspondan. */
  soloFollowUps?: boolean;
  /** Restringe la tanda a una cohorte comercial sin mezclar rubros. */
  vertical?: string;
  /**
   * Restringe la tanda a un solo destinatario, para probar contra un teléfono
   * propio sin que el resto de la cola entre por accidente.
   *
   * Filtra la lista de candidatos; NO relaja ninguna puerta. Si ese número no
   * está en la cola, la tanda no manda nada, que es el resultado correcto.
   */
  solo?: string;
  /** Permite apuntar una tanda a una lista explícita sin mezclar la cola. */
  solos?: readonly string[];
  /**
   * Cohorte multimedia aprobada explícitamente. Cuando existe, la tanda se
   * restringe a sus números y nunca degrada silenciosamente a texto.
   */
  visuales?: ReadonlyMap<string, VisualAprobado>;
}

export interface MensajeCompuesto {
  e164: string;
  nombre: string;
  paso: PasoCampana;
  intencionApertura: IntencionApertura | "visual";
  texto: string;
  tipo: "text" | "image";
  imagen?: string;
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
  | "aperturasRecientes"
  | "claimSend"
  | "markSent"
  | "markError"
  | "tripKillSwitch"
>;

export interface DependenciasCampana {
  store: CampaignStore;
  proveedor: ProveedorLLM;
  client: Pick<WaClient, "sendText" | "sendImage">;
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
/**
 * Cuántos candidatos se traen por página. Nada que ver con cuántos se envían:
 * es solo el tamaño del barrido para no cargar los ~1,100 de una.
 */
const TAMANO_PAGINA = 100;
const MAX_INTENTOS_AUDITORIA = 3;
const INTENCIONES_APERTURA: readonly IntencionApertura[] = [
  "derivacion",
  "busqueda",
  "operativa",
  "permiso",
  "directa",
  "modelo",
];

function intencionParaIndice(indice: number): IntencionApertura {
  // La rotación depende de la posición estable en la tanda, no del azar. Así
  // puede auditarse después y no produce cinco aperturas iguales por accidente.
  return INTENCIONES_APERTURA[indice % INTENCIONES_APERTURA.length]!;
}

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
  return {
    ...ficha,
    nombre: normalizarNombre(ficha.nombre),
    clasificacion: rubroNatural(ficha.clasificacion),
  };
}

/**
 * Ejecuta una tanda serial de campaña.
 *
 * Las puertas se consultan antes del compositor porque cada llamada al
 * proveedor cuesta tiempo y dinero. `attemptSend` las repite luego: esa
 * duplicación es deliberada, ya que otro proceso puede cambiar la salud o el
 * destinatario mientras se compone el texto.
 */
export async function ejecutarTanda(
  deps: DependenciasCampana,
  opts: OpcionesTanda = {},
): Promise<ResumenTanda> {
  const max = opts.max ?? MAX_POR_DEFECTO;
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new Error("max requiere un entero positivo");
  }

  // Se pagina en vez de pedir `max` de una. La consulta ordena por score y no
  // sabe de cadencia, así que los ya terminados (fu2 enviado) y los que
  // todavía no les toca siguen ocupando los primeros puestos. Pidiendo solo
  // `max`, esas filas coparían el cupo, canContact las saltaría a todas, y
  // ningún prospecto de score más bajo se contactaría jamás — inanición
  // permanente. La elegibilidad de cadencia vive en safety.ts y no se duplica
  // en SQL: se recorre hasta juntar los envíos pedidos.
  let desplazamiento = 0;
  let evaluados = 0;
  // Cuenta mensajes PRODUCIDOS, no solo enviados: en dry-run no se envía nada,
  // así que un tope basado en `enviados` no se alcanzaría nunca y la tanda
  // compondría contra toda la lista.
  let producidos = 0;
  // La variante comercial se asigna solo a quienes realmente llegan al
  // compositor. Los destinatarios saltados por cadencia no deben desplazar la
  // rotación: si no, una cohorte nueva puede recibir dos veces `modelo` solo
  // porque había diez conversaciones viejas delante en la cola.
  let aperturasAsignadas = 0;
  // Aperturas compuestas en ESTA tanda. aperturasRecientes solo conoce lo ya
  // enviado, así que sin esto dos prospectos seguidos reciben la misma apertura
  // — y en dry-run, donde no se persiste nada, el mecanismo de variedad no
  // existía en absoluto.
  const aperturasDeLaTanda: string[] = [];
  // El filtro de `--solo` se aplica a la página YA leída, y el desplazamiento
  // avanza por el tamaño crudo de esa página. Filtrar antes de contar haría dos
  // cosas mal: correría el offset de menos —saltándose candidatos— y, si el
  // número buscado no cayera en la primera página, el `while` cortaría con cero
  // resultados sin llegar nunca a la segunda.
  const filtrar = (
    lista: readonly { e164: string; score: number | null }[],
  ): Array<{ e164: string; score: number | null }> =>
    lista.filter(
      (candidato) =>
        (opts.solo === undefined || candidato.e164 === opts.solo) &&
        (opts.solos === undefined || opts.solos.includes(candidato.e164)) &&
        (opts.visuales === undefined || opts.visuales.has(candidato.e164)),
    );
  let pagina = deps.store.candidatosParaContactar(
    TAMANO_PAGINA,
    desplazamiento,
    opts.vertical,
  );
  const resumen: ResumenTanda = {
    enviados: 0,
    saltadosPorDestinatario: 0,
    fallosComposicion: 0,
    motivoTerminacion: "",
    mensajesCompuestos: [],
  };

  while (pagina.length > 0) {
   for (const candidato of filtrar(pagina)) {
    if (producidos >= max) {
      resumen.motivoTerminacion = `alcanzado el máximo de la tanda (${max})`;
      return resumen;
    }
    evaluados += 1;
    const ahora = deps.now();
    const salud = deps.store.loadAccountHealth(ahora);
    // En dry-run no se envía nada, así que las puertas que existen para
    // proteger el número —horario hábil, tope diario, separación mínima— no
    // deben impedir una previsualización. Bloquearlas haría que revisar los
    // mensajes un domingo fuera imposible, que es justo cuando uno los revisa.
    // El kill switch sí se respeta: si el número está quemado, no hay campaña
    // que preparar.
    const veredictoCuenta =
      opts.dryRun === true
        ? salud.killSwitch.tripped
          ? {
              allow: false as const,
              reason: `kill switch activo: ${salud.killSwitch.reason ?? "sin detalle"}`,
              retryAfter: null,
            }
          : { allow: true as const }
        : canSendNow(salud, deps.config, ahora);
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
    if (opts.soloFollowUps === true && paso === "first") {
      resumen.saltadosPorDestinatario += 1;
      deps.log?.(
        `${candidato.e164} saltado: modo solo follow-ups, no se abren chats nuevos`,
      );
      continue;
    }
    if (opts.paso !== undefined && paso !== opts.paso) {
      resumen.saltadosPorDestinatario += 1;
      deps.log?.(
        `${candidato.e164} saltado: paso actual ${paso}, filtro ${opts.paso}`,
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

    const visual = opts.visuales?.get(candidato.e164);
    if (visual !== undefined) {
      if (visual.paso !== paso) {
        resumen.saltadosPorDestinatario += 1;
        deps.log?.(
          `${candidato.e164} saltado: visual aprobado para ${visual.paso}, ` +
            `pero el paso actual es ${paso}`,
        );
        continue;
      }

      const textoVisual = captionVisual(
        visual.nombre ?? ficha.nombre,
        visual.paso,
        visual.nombre !== undefined,
      );
      if (opts.dryRun === true) {
        resumen.mensajesCompuestos.push({
          e164: candidato.e164,
          nombre: normalizarNombre(ficha.nombre),
          paso,
          intencionApertura: "visual",
          texto: textoVisual,
          tipo: "image",
          imagen: visual.ruta,
        });
        producidos += 1;
        continue;
      }

      const resultadoVisual = await attemptSendImage(
        {
          store: deps.store,
          client: deps.client,
          config: deps.config,
          now: deps.now,
        },
        candidato.e164,
        visual.imagen,
        textoVisual,
        paso,
      );
      if (!resultadoVisual.allow) {
        deps.log?.(`${candidato.e164} no se envió: ${resultadoVisual.reason}`);
        continue;
      }

      resumen.enviados += 1;
      producidos += 1;
      deps.log?.(`${candidato.e164} enviado (${paso}, imagen 16:9)`);
      if (producidos < max) {
        await deps.sleep(nextGapSeconds(deps.config, deps.random) * 1_000);
      }
      continue;
    }

    const historialPrevio = deps.store.mensajesEnviados(candidato.e164);
    const aperturasRecientes = [
      ...aperturasDeLaTanda,
      ...deps.store.aperturasRecientes(15),
    ];
    const intencion = intencionParaIndice(aperturasAsignadas);
    aperturasAsignadas += 1;
    // Si una forma falla, el siguiente intento también ve esa salida como
    // bloqueada. Solo pasarle los mensajes históricos no bastaba: el modelo
    // podía repetir tres veces la misma apertura dentro del propio candidato.
    const aperturasBloqueadas = [...aperturasRecientes];
    let textoAprobado: string | null = null;
    for (let intento = 0; intento < MAX_INTENTOS_AUDITORIA; intento += 1) {
      const composicion = await componerMensaje(
        deps.proveedor,
        contextoDe(ficha),
        paso,
        historialPrevio,
        intencion,
        aperturasBloqueadas,
      );
      if (!composicion.ok) {
        resumen.fallosComposicion += 1;
        deps.log?.(
          `${candidato.e164} no se compuso: ${composicion.motivo}`,
        );
        break;
      }

      const auditoria = auditarMensaje(composicion.texto, {
        clasificacion: ficha.clasificacion,
        aperturasRecientes: aperturasBloqueadas,
        paso,
        intencionApertura: intencion,
      });
      if (auditoria.ok) {
        textoAprobado = composicion.texto;
        break;
      }

      const motivo = auditoria.motivos.join("; ");
      aperturasBloqueadas.unshift(composicion.texto.slice(0, 80));
      if (intento + 1 < MAX_INTENTOS_AUDITORIA) {
        deps.log?.(
          `${candidato.e164} no pasó auditoría (${motivo}); recomponiendo la misma intención con otra forma`,
        );
      } else {
        resumen.fallosComposicion += 1;
        deps.log?.(
          `${candidato.e164} no pasó auditoría tras ${MAX_INTENTOS_AUDITORIA} intentos: ${motivo}`,
        );
      }
    }
    if (textoAprobado === null) continue;

    if (opts.dryRun === true) {
      resumen.mensajesCompuestos.push({
        e164: candidato.e164,
        nombre: normalizarNombre(ficha.nombre),
        paso,
        intencionApertura: intencion,
        texto: textoAprobado,
        tipo: "text",
      });
      aperturasDeLaTanda.unshift(textoAprobado.slice(0, 80));
      producidos += 1;
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
      textoAprobado,
      paso,
    );
    if (!resultado.allow) {
      // Esta puerta puede perder una carrera después de componer. Se registra
      // pero no termina la tanda: el siguiente ciclo vuelve a medir la cuenta.
      deps.log?.(`${candidato.e164} no se envió: ${resultado.reason}`);
      continue;
    }

    aperturasDeLaTanda.unshift(textoAprobado.slice(0, 80));
    resumen.enviados += 1;
    producidos += 1;
    deps.log?.(`${candidato.e164} enviado (${paso})`);

    if (producidos < max) {
      // El jitter evita una cadencia mecánica. No se duerme tras el último
      // candidato porque ya no existe otro envío de esta tanda que separar.
      await deps.sleep(nextGapSeconds(deps.config, deps.random) * 1_000);
    }
   }

   desplazamiento += pagina.length;
   pagina = deps.store.candidatosParaContactar(
     TAMANO_PAGINA,
     desplazamiento,
     opts.vertical,
   );
  }

  resumen.motivoTerminacion = `tanda completada (${evaluados} candidatos evaluados)`;
  return resumen;
}
