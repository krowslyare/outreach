import { describe, expect, it } from "vitest";

import type {
  ProveedorLLM,
  RespuestaLLM,
  SolicitudLLM,
} from "../llm/port.js";
import { componerMensaje } from "./compose.js";

const PROSPECTO = {
  nombre: "Clínica Ejemplo",
  distrito: "Miraflores",
  clasificacion: "Clínica",
  tieneWeb: false,
  resenas: 42,
};

function proveedorCapturador(respuesta: RespuestaLLM): {
  proveedor: ProveedorLLM;
  solicitud: () => SolicitudLLM;
} {
  let capturada: SolicitudLLM | undefined;

  return {
    proveedor: {
      nombre: "fake",
      async generar(solicitud) {
        capturada = solicitud;
        return respuesta;
      },
    },
    solicitud() {
      if (capturada === undefined) {
        throw new Error("El proveedor todavía no recibió una solicitud");
      }
      return capturada;
    },
  };
}

describe("componerMensaje", () => {
  it("solicita solo texto mediante el puerto neutral", async () => {
    const captura = proveedorCapturador({
      corte: "fin",
      texto: "Mensaje listo",
      herramienta: null,
    });

    await expect(
      componerMensaje(captura.proveedor, PROSPECTO, "first", [], "busqueda", []),
    ).resolves.toEqual({ ok: true, texto: "Mensaje listo" });

    expect(captura.solicitud()).toMatchObject({
      sistema: expect.any(String),
      mensajes: [{ rol: "user", texto: expect.any(String) }],
      maxTokens: 4000,
      esfuerzo: "high",
    });
    expect(captura.solicitud().herramientas).toBeUndefined();
  });

  it.each([
    {
      respuesta: {
        corte: "rechazo",
        texto: "",
        herramienta: null,
        motivo: "clasificador",
      } satisfies RespuestaLLM,
      esperado: "rechazó",
    },
    {
      respuesta: {
        corte: "truncado",
        texto: "fragmento que no debe usarse",
        herramienta: null,
      } satisfies RespuestaLLM,
      esperado: "truncó",
    },
    {
      respuesta: {
        corte: "error",
        texto: "",
        herramienta: null,
        motivo: "timeout",
      } satisfies RespuestaLLM,
      esperado: "timeout",
    },
  ])("descarta una respuesta con corte $respuesta.corte", async ({
    respuesta,
    esperado,
  }) => {
    const { proveedor } = proveedorCapturador(respuesta);

    const resultado = await componerMensaje(
      proveedor,
      PROSPECTO,
      "first",
      [],
      "busqueda",
      [],
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error("esperaba una composición fallida");
    expect(resultado.motivo).toContain(esperado);
  });

  it("rechaza texto vacío y texto mayor a 700 caracteres", async () => {
    const vacio = proveedorCapturador({
      corte: "fin",
      texto: " \n ",
      herramienta: null,
    });
    await expect(
      componerMensaje(vacio.proveedor, PROSPECTO, "first", [], "busqueda", []),
    ).resolves.toEqual({ ok: false, motivo: "el modelo no produjo texto" });

    const largo = proveedorCapturador({
      corte: "fin",
      texto: "a".repeat(701),
      herramienta: null,
    });
    const resultado = await componerMensaje(
      largo.proveedor,
      PROSPECTO,
      "first",
      [],
      "busqueda",
      [],
    );
    expect(resultado).toEqual({
      ok: false,
      motivo: "la composición salió demasiado larga (701 caracteres)",
    });
  });
});
