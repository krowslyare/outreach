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
export const ESPERA_RAFAGA_MS = 4_000;

interface Pendiente {
  timer: ReturnType<typeof setTimeout>;
  tarea: () => Promise<void>;
  resolver: () => void;
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
    // El resolver corre pase lo que pase: si la tarea revienta, quien esperaba
    // este turno no puede quedar colgado para siempre.
    return entrada.tarea().finally(() => {
      entrada.resolver();
    });
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
    const hecho = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    const timer = setTimeout(() => void disparar(clave), esperaMs);
    // Un timer de espera no debe ser la razón por la que el proceso sigue vivo.
    timer.unref?.();
    pendientes.set(clave, { timer, tarea, resolver, hecho });
    return hecho;
  }

  async function vaciar(): Promise<void> {
    // Se dispara de verdad en vez de solo cancelar: cancelar dejaría a alguien
    // que escribió sin respuesta y sin nada que lo indique.
    await Promise.allSettled([...pendientes.keys()].map(disparar));
  }

  return { programar, vaciar, pendientes: () => pendientes.size };
}
