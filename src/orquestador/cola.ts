// Serialización POR CHAT de los mensajes entrantes.
//
// El despacho era `void manejarInbound(...)` por cada evento: dos mensajes del
// mismo número con segundos de diferencia —lo más común del mundo en WhatsApp,
// "Hola" / "¿quién habla?" / "¿cuánto cuesta?"— arrancaban dos ejecuciones a la
// vez. Eso produce tres fallas concretas:
//
//   1. Dos llamadas al LLM simultáneas, cada una con un historial incompleto:
//      ninguna ve el mensaje que la otra está atendiendo.
//   2. Respuestas fuera de orden, porque la segunda puede terminar antes.
//   3. Dos escalamientos por la misma conversación, o peor, un escalamiento y
//      una respuesta del bot encima del takeover que el otro acaba de poner.
//
// Chats DISTINTOS sí avanzan en paralelo: son conversaciones independientes y
// serializarlas todas haría que un prospecto lento bloquee a los demás.

/** Una cola por clave. Se borra la entrada al vaciarse para no crecer sin fin. */
const colas = new Map<string, Promise<unknown>>();

/**
 * Encola `tarea` detrás de lo pendiente para `clave` y devuelve su resultado.
 *
 * La cola avanza aunque la tarea falle. Sin eso, un rechazo dejaría la cadena
 * envenenada y ese chat no volvería a procesar un mensaje nunca más — el
 * prospecto quedaría mudo para el sistema sin que nada lo indique.
 */
export function enSerie<T>(clave: string, tarea: () => Promise<T>): Promise<T> {
  const previo = colas.get(clave) ?? Promise.resolve();
  const turno = previo.then(tarea, tarea);
  const siguiente = turno.catch(() => undefined);
  colas.set(clave, siguiente);

  void siguiente.then(() => {
    // Solo se limpia si nadie encoló después: comparar la identidad evita
    // borrar una cola que ya tiene otro turno esperando.
    if (colas.get(clave) === siguiente) colas.delete(clave);
  });

  return turno;
}

/** Cuántos chats tienen trabajo pendiente. Para tests y diagnóstico. */
export function chatsEnCola(): number {
  return colas.size;
}
