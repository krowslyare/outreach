import { describe, expect, it } from "vitest";

import { chatsEnCola, enSerie } from "./cola.js";

function diferido<T>(): {
  promesa: Promise<T>;
  resolver: (valor: T) => void;
  rechazar: (error: unknown) => void;
} {
  let resolver!: (valor: T) => void;
  let rechazar!: (error: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

describe("enSerie", () => {
  it("procesa en orden los mensajes del mismo chat", async () => {
    const orden: string[] = [];
    const primero = diferido<void>();

    const a = enSerie("+51999111222", async () => {
      orden.push("a:inicio");
      await primero.promesa;
      orden.push("a:fin");
    });
    const b = enSerie("+51999111222", async () => {
      orden.push("b:inicio");
    });

    // Mientras 'a' no termine, 'b' ni siquiera empezó.
    await Promise.resolve();
    expect(orden).toEqual(["a:inicio"]);

    primero.resolver();
    await Promise.all([a, b]);
    expect(orden).toEqual(["a:inicio", "a:fin", "b:inicio"]);
  });

  // Serializar todo haría que un prospecto lento bloquee a los demás.
  it("deja avanzar en paralelo chats distintos", async () => {
    const orden: string[] = [];
    const lento = diferido<void>();

    const a = enSerie("+51999111222", async () => {
      orden.push("lento:inicio");
      await lento.promesa;
      orden.push("lento:fin");
    });
    const b = enSerie("+51999333444", async () => {
      orden.push("rapido");
    });

    await b;
    expect(orden).toEqual(["lento:inicio", "rapido"]);

    lento.resolver();
    await a;
  });

  // Sin esto un rechazo envenena la cadena y ese chat no vuelve a procesar un
  // mensaje nunca: el prospecto queda mudo para el sistema y nada lo indica.
  it("un fallo no bloquea los mensajes siguientes de ese chat", async () => {
    const fallo = enSerie("+51999111222", async () => {
      throw new Error("revienta");
    });
    await expect(fallo).rejects.toThrow("revienta");

    await expect(
      enSerie("+51999111222", async () => "siguiente"),
    ).resolves.toBe("siguiente");
  });

  it("no acumula colas de chats ya atendidos", async () => {
    await enSerie("+51900000001", async () => undefined);
    await enSerie("+51900000002", async () => undefined);
    // El borrado ocurre en un microtask posterior al del turno.
    await new Promise((r) => setTimeout(r, 0));
    expect(chatsEnCola()).toBe(0);
  });
});
