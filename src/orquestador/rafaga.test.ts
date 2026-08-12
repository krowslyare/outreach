import { describe, expect, it, vi } from "vitest";

import { crearAgrupador, ESPERA_RAFAGA_MS } from "./rafaga.js";

describe("crearAgrupador", () => {
  it("espera lo suficiente para que la respuesta no parezca instantánea", () => {
    expect(ESPERA_RAFAGA_MS).toBe(45_000);
  });

  // Tres mensajes seguidos son una ráfaga: se contesta una vez, no tres.
  it("colapsa varios avisos del mismo chat en una sola ejecución", async () => {
    vi.useFakeTimers();
    const corridas: string[] = [];
    const agrupador = crearAgrupador(4_000);

    const a = agrupador.programar("+51999111222", async () => {
      corridas.push("primera");
    });
    const b = agrupador.programar("+51999111222", async () => {
      corridas.push("segunda");
    });
    const c = agrupador.programar("+51999111222", async () => {
      corridas.push("tercera");
    });

    await vi.advanceTimersByTimeAsync(4_000);
    await Promise.all([a, b, c]);

    // Corre la ÚLTIMA: es la que ve el estado más nuevo del chat.
    expect(corridas).toEqual(["tercera"]);
    vi.useRealTimers();
  });

  // El punto del reinicio: cada mensaje nuevo aleja el momento de contestar,
  // para no responder a mitad de la idea de la persona.
  it("cada aviso reinicia la espera", async () => {
    vi.useFakeTimers();
    const corridas: string[] = [];
    const agrupador = crearAgrupador(4_000);

    void agrupador.programar("+51999111222", async () => {
      corridas.push("x");
    });
    await vi.advanceTimersByTimeAsync(3_000);
    void agrupador.programar("+51999111222", async () => {
      corridas.push("x");
    });
    await vi.advanceTimersByTimeAsync(3_000);

    // Ya pasaron 6s desde el primero, pero solo 3 desde el último.
    expect(corridas).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(corridas).toEqual(["x"]);
    vi.useRealTimers();
  });

  // Chats distintos son conversaciones independientes.
  it("no mezcla chats distintos", async () => {
    vi.useFakeTimers();
    const corridas: string[] = [];
    const agrupador = crearAgrupador(4_000);

    void agrupador.programar("+51999111222", async () => {
      corridas.push("uno");
    });
    void agrupador.programar("+51999333444", async () => {
      corridas.push("dos");
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(corridas.sort()).toEqual(["dos", "uno"]);
    vi.useRealTimers();
  });

  // Al apagar, lo que está esperando se ejecuta. Cancelarlo dejaría a alguien
  // que escribió sin respuesta y sin nada que lo indique.
  it("vaciar ejecuta lo pendiente en vez de descartarlo", async () => {
    const corridas: string[] = [];
    const agrupador = crearAgrupador(60_000);

    const espera = agrupador.programar("+51999111222", async () => {
      corridas.push("pendiente");
    });
    expect(agrupador.pendientes()).toBe(1);

    await agrupador.vaciar();
    await espera;

    expect(corridas).toEqual(["pendiente"]);
    expect(agrupador.pendientes()).toBe(0);
  });

  // El fallo tiene que LLEGAR a quien esperaba. Si se lo tragara, el .catch de
  // campana.ts nunca correría y el rechazo quedaría sin manejar — con eso Node
  // tumba el proceso y se lleva el listener por un fallo pasajero.
  it("un fallo de la tarea viaja a quien esperaba", async () => {
    const agrupador = crearAgrupador(60_000);

    const espera = agrupador.programar("+51999111222", async () => {
      throw new Error("revienta");
    });
    const capturado = espera.catch((error: unknown) => error);
    await agrupador.vaciar();

    await expect(capturado).resolves.toMatchObject({ message: "revienta" });
  });

  // vaciar() no puede propagar el fallo de un chat y dejar sin disparar a los
  // demás: se apaga con varios pendientes y todos tienen que correr.
  it("vaciar no se detiene porque una tarea falle", async () => {
    const corridas: string[] = [];
    const agrupador = crearAgrupador(60_000);

    const malo = agrupador.programar("+51999111222", async () => {
      throw new Error("revienta");
    });
    malo.catch(() => undefined);
    const bueno = agrupador.programar("+51999333444", async () => {
      corridas.push("ok");
    });

    await expect(agrupador.vaciar()).resolves.toBeUndefined();
    await bueno;
    expect(corridas).toEqual(["ok"]);
  });
});
