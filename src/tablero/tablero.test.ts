import { afterEach, describe, expect, it } from "vitest";

import type { Server } from "node:http";

import { Store } from "../wa/store.js";

// El servidor del tablero es un script de arranque; lo que se testea acá es
// su contrato HTTP levantándolo de verdad en un puerto efímero, con una base
// en memoria. Para eso el archivo exporta ensamblarServidor en vez de escuchar
// al importarse.

import { ensamblarServidor } from "../cli/tablero.js";

describe("servidor del tablero", () => {
  const stores: Store[] = [];
  const servidores: Array<{ servidor: Server }> = [];

  afterEach(async () => {
    for (const s of servidores.splice(0)) {
      s.servidor.closeAllConnections();
      await new Promise<void>((resolve) => s.servidor.close(() => resolve()));
    }
    for (const store of stores.splice(0)) store.close();
  });

  async function tableroDePrueba(): Promise<{ base: string; store: Store }> {
    const store = new Store(":memory:");
    stores.push(store);
    const { servidor } = ensamblarServidor(store);
    servidores.push({ servidor });
    await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
    return { base: `http://127.0.0.1:${(servidor.address() as { port: number }).port}`, store };
  }

  it("sirve la página y el estado completo por /api/estado", async () => {
    const { base, store } = await tableroDePrueba();
    store.crearCliente({
      e164: "+51999111222",
      nombreComercial: "Clínica Sonrisa",
      plan: "empresa",
    });

    const pagina = await (await fetch(`${base}/`)).text();
    expect(pagina).toContain("Kurogrid · tablero");

    const estado = (await (await fetch(`${base}/api/estado`)).json()) as {
      cuenta: { killSwitchActivo: boolean };
      clientes: Array<{ nombreComercial: string; total: number }>;
      bandeja: unknown[];
      embudo: { porRevisar: number };
    };
    expect(estado.cuenta.killSwitchActivo).toBe(false);
    expect(estado.clientes).toHaveLength(1);
    expect(estado.clientes[0]).toMatchObject({ nombreComercial: "Clínica Sonrisa" });
    expect(estado.bandeja).toEqual([]);
    expect(estado.embudo.porRevisar).toBe(0);
  });

  it("marcar requisito y mover estado funcionan; lo inválido se rechaza", async () => {
    const { base, store } = await tableroDePrueba();
    store.crearCliente({
      e164: "+51999111222",
      nombreComercial: "Clínica Sonrisa",
      plan: "presencia",
    });

    const marca = await fetch(`${base}/api/clientes/%2B51999111222/requisito`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clave: "fotos", resuelto: true }),
    });
    expect(marca.status).toBe(200);
    expect(
      store.cargarCliente("+51999111222")?.requisitos.find((r) => r.clave === "fotos")?.resuelto,
    ).toBe(true);

    // Clave inexistente: 404 con motivo, no silencio.
    const malaClave = await fetch(`${base}/api/clientes/%2B51999111222/requisito`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clave: "foto", resuelto: true }),
    });
    expect(malaClave.status).toBe(404);

    // Estado inválido: 400.
    const malEstado = await fetch(`${base}/api/clientes/%2B51999111222/estado`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ estado: "cancelado" }),
    });
    expect(malEstado.status).toBe(400);

    // Estado válido: 200 y la ficha lo refleja.
    const bienEstado = await fetch(`${base}/api/clientes/%2B51999111222/estado`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ estado: "recoleccion" }),
    });
    expect(bienEstado.status).toBe(200);
    expect(store.cargarCliente("+51999111222")?.estado).toBe("recoleccion");

    // Ruta desconocida: 404.
    expect((await fetch(`${base}/api/nada`)).status).toBe(404);
  });
});
