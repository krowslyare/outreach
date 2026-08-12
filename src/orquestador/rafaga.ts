// Agrupa los mensajes que llegan seguidos del mismo chat.
//
// En WhatsApp la gente no escribe párrafos: escribe "Hola", enter, "¿quién
// habla?", enter, "¿cuánto cuesta?". Contestando cada uno salían tres respuestas
// encadenadas — correctas y con contexto, gracias a la cola por chat, pero
// inconfundiblemente de una máquina. Una persona lee los tres y contesta una vez.
//
// El registro del entrante NO pasa por acá: eso ocurre apenas llega, porque el
// opt-out y la idempotencia no pueden esperar un silencio. Lo único que se
// posterga es la respuesta.

/** Cuánto silencio hace falta para dar la ráfaga por terminada. */
// Cuarenta y cinco segundos dan margen para que la persona mande un segundo o
// tercer mensaje antes de que el agente empiece a componer. La composición del
// agente suma su propio tiempo encima; una espera corta fue precisamente lo que
// hizo que Priority Dent recibiera un cierre al saludo antes de leer su segundo
// mensaje.
export const ESPERA_RAFAGA_MS = 45_000;

interface Pendiente {
  timer: ReturnType<typeof setTimeout>;
  tarea: () => Promise<void>;
  resolver: () => void;
  rechazar: (error: unknown) => void;
  hecho: Promise<void>;
}

export interface Agrupador {
  /**
   * Programa el trabajo para `clave`, reiniciando la espera si ya había uno.
   *
   * El reinicio es el punto: cada mensaje nuevo aleja el momento de contestar,
   * de modo que se responde cuando la persona dejó de escribir y no a mitad de
   * su idea.
   */
  programar(clave: string, tarea: () => Promise<void>): Promise<void>;
  /** Ejecuta YA lo que esté esperando. Para apagar sin dejar a nadie colgado. */
  vaciar(): Promise<void>;
  pendientes(): number;
}

export function crearAgrupador(esperaMs = ESPERA_RAFAGA_MS): Agrupador {
  const pendientes = new Map<string, Pendiente>();

  function disparar(clave: string): Promise<void> {
    const entrada = pendientes.get(clave);
    if (entrada === undefined) return Promise.resolve();
    pendientes.delete(clave);
    clearTimeout(entrada.timer);
    // El fallo VIAJA a quien esperaba. Antes esto era un `finally` que resolvía
    // siempre, con dos consecuencias: el `.catch` de campana.ts nunca corría, y
    // el rechazo de `tarea()` quedaba sin manejar —el timer descarta el
    // resultado con `void`— así que Node podía tumbar el proceso entero por un
    // fallo pasajero atendiendo un mensaje. El listener se caía con él.
    //
    // Lo que devuelve `disparar` no rechaza nunca (then con ambos handlers),
    // que es lo que hace seguro descartarlo en el timer y en vaciar().
    return entrada.tarea().then(entrada.resolver, entrada.rechazar);
  }

  function programar(clave: string, tarea: () => Promise<void>): Promise<void> {
    const previo = pendientes.get(clave);
    if (previo !== undefined) {
      // Se reemplaza la tarea y se reinicia la espera, pero se CONSERVA la
      // promesa: quien esperaba el turno anterior sigue esperando, y la tarea
      // que finalmente corra cubre también su mensaje, porque lee del store
      // todo lo que ese número tenga pendiente.
      clearTimeout(previo.timer);
      previo.tarea = tarea;
      previo.timer = setTimeout(() => void disparar(clave), esperaMs);
      previo.timer.unref?.();
      return previo.hecho;
    }

    let resolver!: () => void;
    let rechazar!: (error: unknown) => void;
    // Quien llama a programar() TIENE que manejar el rechazo: la promesa es
    // compartida por toda la ráfaga y un rechazo sin catch termina el proceso.
    const hecho = new Promise<void>((resolve, reject) => {
      resolver = resolve;
      rechazar = reject;
    });
    const timer = setTimeout(() => void disparar(clave), esperaMs);
    // Un timer de espera no debe ser la razón por la que el proceso sigue vivo.
    timer.unref?.();
    pendientes.set(clave, { timer, tarea, resolver, rechazar, hecho });
    return hecho;
  }

  async function vaciar(): Promise<void> {
    // Se dispara de verdad en vez de solo cancelar: cancelar dejaría a alguien
    // que escribió sin respuesta y sin nada que lo indique.
    await Promise.allSettled([...pendientes.keys()].map(disparar));
  }

  return { programar, vaciar, pendientes: () => pendientes.size };
}
