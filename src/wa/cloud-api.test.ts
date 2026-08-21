import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InboundEvent } from "./client.js";
import {
  ACK_DESDE_ESTADO,
  ClienteCloudApi,
  canalSeleccionado,
  clienteParaTandasEnNube,
  configDesdeEntorno,
  eventoDesdeWebhook,
  mimeTypeDeImagen,
  verificarFirma,
  type ConfigCloudApi,
} from "./cloud-api.js";
import type { PlantillaAprobada } from "./plantillas.js";

const CFG: ConfigCloudApi = {
  token: "token-de-prueba",
  phoneNumberId: "1234567890",
  appSecret: "secreto-de-app",
  verifyToken: "token-de-verificacion",
};

// ---------------------------------------------------------------------------
// Payloads con la forma REAL de los webhooks de Meta (entry → changes → value).
// ---------------------------------------------------------------------------

const TS = "1726000000";

function mensajeTexto(body: string, extras: Record<string, unknown> = {}) {
  return {
    from: "51999111222",
    id: "wamid.MENSAJE1",
    timestamp: TS,
    type: "text",
    text: { body },
    ...extras,
  };
}

function payloadWebhook(
  mensajes: unknown[] = [],
  statuses: unknown[] = [],
): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "51999888777", phone_number_id: CFG.phoneNumberId },
              contacts: [{ profile: { name: "Clínica" }, wa_id: "51999111222" }],
              ...(mensajes.length > 0 ? { messages: mensajes } : {}),
              ...(statuses.length > 0 ? { statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}

function firma(cuerpo: string): string {
  return `sha256=${createHmac("sha256", CFG.appSecret).update(cuerpo).digest("hex")}`;
}

function respuestaJson(status: number, cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("canalSeleccionado", () => {
  it("baileys por defecto; cloud solo explícito", () => {
    expect(canalSeleccionado({} as NodeJS.ProcessEnv)).toBe("baileys");
    expect(canalSeleccionado({ CANAL: "cloud" } as NodeJS.ProcessEnv)).toBe("cloud");
    expect(canalSeleccionado({ CANAL: "CLOUD" } as NodeJS.ProcessEnv)).toBe("cloud");
    expect(canalSeleccionado({ CANAL: "baileys" } as NodeJS.ProcessEnv)).toBe("baileys");
  });
});

describe("configDesdeEntorno", () => {
  it("lista todas las variables faltantes de una sola vez", () => {
    expect(() => configDesdeEntorno({ CANAL: "cloud" } as NodeJS.ProcessEnv)).toThrow(
      /WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN/,
    );
  });
});

describe("verificarFirma", () => {
  const CUERPO = JSON.stringify(payloadWebhook([mensajeTexto("hola")]));

  it("acepta la firma correcta y rechaza cualquier otra cosa", () => {
    expect(verificarFirma(CFG.appSecret, CUERPO, firma(CUERPO))).toBe(true);
    expect(verificarFirma(CFG.appSecret, CUERPO, firma("otro cuerpo"))).toBe(false);
    expect(verificarFirma(CFG.appSecret, CUERPO, `sha256=${"0".repeat(64)}`)).toBe(false);
    // Sin encabezado o con un formato raro: rechazo, no excepción.
    expect(verificarFirma(CFG.appSecret, CUERPO, undefined)).toBe(false);
    expect(verificarFirma(CFG.appSecret, CUERPO, "texto suelto")).toBe(false);
  });
});

describe("eventoDesdeWebhook", () => {
  it("mapea un mensaje de texto completo", () => {
    const evento = eventoDesdeWebhook(mensajeTexto("buenas, ¿de qué se trata?"));
    expect(evento).toEqual({
      e164: "+51999111222",
      body: "buenas, ¿de qué se trata?",
      at: new Date(Number(TS) * 1000),
      waMessageId: "wamid.MENSAJE1",
      tipo: "text",
      tieneMedia: false,
      citaOtroMensaje: false,
    } satisfies InboundEvent);
  });

  it("una nota de voz llega como marcador, nunca vacía", () => {
    const evento = eventoDesdeWebhook({
      from: "51999111222",
      id: "wamid.AUDIO1",
      timestamp: TS,
      type: "audio",
      audio: { mime_type: "audio/ogg" },
    });
    expect(evento).toMatchObject({
      body: "[nota de voz]",
      tipo: "audio",
      tieneMedia: true,
    });
  });

  it("una imagen con caption entrega el texto y se marca como media", () => {
    const evento = eventoDesdeWebhook({
      from: "51999111222",
      id: "wamid.IMG1",
      timestamp: TS,
      type: "image",
      image: { caption: "mira este local" },
    });
    expect(evento).toMatchObject({
      body: "mira este local",
      tipo: "image",
      tieneMedia: true,
    });
  });

  it("la respuesta de un botón interactivo es texto legible", () => {
    const evento = eventoDesdeWebhook({
      from: "51999111222",
      id: "wamid.BTN1",
      timestamp: TS,
      type: "interactive",
      interactive: { button_reply: { id: "1", title: "Quiero una reunión" } },
    });
    expect(evento).toMatchObject({ body: "Quiero una reunión", tipo: "interactive" });
  });

  it("detecta que el mensaje cita otro, venga del campo que venga", () => {
    const conContextoPropio = eventoDesdeWebhook(
      mensajeTexto("gracias", { context: { from: "51999888777", id: "wamid.X" } }),
    );
    const conContextoEnTexto = eventoDesdeWebhook(
      mensajeTexto("gracias", { text: { body: "gracias", context: { id: "wamid.Y" } } }),
    );
    expect(conContextoPropio?.citaOtroMensaje).toBe(true);
    expect(conContextoEnTexto?.citaOtroMensaje).toBe(true);
  });

  it("devuelve null para lo que no se contesta", () => {
    expect(eventoDesdeWebhook({ type: "system", system: { body: "cambio de número" } })).toBeNull();
    expect(eventoDesdeWebhook({ type: "unsupported" })).toBeNull();
    expect(eventoDesdeWebhook(mensajeTexto("sin id", { id: undefined }))).toBeNull();
    expect(
      eventoDesdeWebhook({ ...mensajeTexto("x"), from: "grupo@g.us" }),
    ).toBeNull();
  });
});

describe("ACK_DESDE_ESTADO", () => {
  it("usa nuestra escala, donde delivered es 2 y sent NO cuenta como dispositivo", () => {
    expect(ACK_DESDE_ESTADO.sent).toBe(1);
    expect(ACK_DESDE_ESTADO.delivered).toBe(2);
    expect(ACK_DESDE_ESTADO.read).toBe(3);
    expect(ACK_DESDE_ESTADO.failed).toBe(-1);
    expect(ACK_DESDE_ESTADO["estado-desconocido"]).toBeUndefined();
  });
});

describe("mimeTypeDeImagen", () => {
  it("reconoce JPEG y PNG por magia, no por confianza", () => {
    expect(mimeTypeDeImagen(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(
      mimeTypeDeImagen(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])),
    ).toBe("image/png");
    expect(() => mimeTypeDeImagen(new Uint8Array([0x00, 0x01, 0x02]))).toThrow(
      /formato de imagen no reconocido/,
    );
  });
});

describe("ClienteCloudApi", () => {
  const clientes: ClienteCloudApi[] = [];
  const servidores: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const cliente of clientes.splice(0)) await cliente.stop();
    for (const servidor of servidores.splice(0)) await servidor.close();
  });

  function clienteConFetch(
    respuestas: Array<Response>,
    capturas: Array<{ url: string; init?: RequestInit }> = [],
  ): ClienteCloudApi {
    let indice = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      capturas.push({
        url: String(input),
        init,
      });
      const respuesta = respuestas[indice];
      indice += 1;
      if (respuesta === undefined) throw new Error("fetch inesperado en el test");
      return respuesta;
    });
    const cliente = new ClienteCloudApi(CFG, { fetchImpl });
    clientes.push(cliente);
    return cliente;
  }

  async function clienteVivo(): Promise<ClienteCloudApi> {
    const cliente = new ClienteCloudApi(CFG);
    clientes.push(cliente);
    await cliente.start();
    return cliente;
  }

  it("sendText manda el número sin + y devuelve el id de Meta", async () => {
    const capturas: Array<{ url: string; init?: RequestInit }> = [];
    const cliente = clienteConFetch(
      [respuestaJson(200, { messages: [{ id: "wamid.SALIDA1" }] })],
      capturas,
    );

    const id = await cliente.sendText("+51999111222", "Hola");

    expect(id).toBe("wamid.SALIDA1");
    expect(capturas[0]?.url).toContain(`/${CFG.phoneNumberId}/messages`);
    expect((capturas[0]?.init?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${CFG.token}`,
    );
    const cuerpo = JSON.parse(String(capturas[0]?.init?.body));
    expect(cuerpo.to).toBe("51999111222");
    expect(cuerpo.text.body).toBe("Hola");
  });

  it("un 401 de Graph avisa fatal Y lanza: kill switch y fallo del envío", async () => {
    const cliente = clienteConFetch([
      respuestaJson(401, { error: { message: "Session expired", code: 190 } }),
    ]);
    const fatal = vi.fn();
    cliente.onFatal(fatal);

    await expect(cliente.sendText("+51999111222", "Hola")).rejects.toThrow(/Session expired/);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal.mock.calls[0]?.[0]).toMatch(/rechazó credenciales \(401\)/);
  });

  it("sendImage sube el medio primero y después manda el mensaje", async () => {
    const capturas: Array<{ url: string; init?: RequestInit }> = [];
    const cliente = clienteConFetch(
      [
        respuestaJson(200, { id: "media-123" }),
        respuestaJson(200, { messages: [{ id: "wamid.IMG-OUT" }] }),
      ],
      capturas,
    );
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);

    const id = await cliente.sendImage("+51999111222", jpeg, "mira esto");

    expect(id).toBe("wamid.IMG-OUT");
    expect(capturas[0]?.url).toContain("/media");
    const cuerpo = JSON.parse(String(capturas[1]?.init?.body));
    expect(cuerpo.image.id).toBe("media-123");
    expect(cuerpo.image.caption).toBe("mira esto");
  });

  it("getBusinessProfile se niega en vez de mentir con exists:false", async () => {
    const cliente = clienteConFetch([]);
    await expect(cliente.getBusinessProfile("+51999111222")).rejects.toThrow(
      /no existe en la API oficial/,
    );
  });

  it("enviarPlantilla manda type:template y valida los parámetros antes de la red", async () => {
    const capturas: Array<{ url: string; init?: RequestInit }> = [];
    const cliente = clienteConFetch(
      [respuestaJson(200, { messages: [{ id: "wamid.TPL1" }] })],
      capturas,
    );
    const plantilla: PlantillaAprobada = {
      nombre: "kurogrid_followup",
      idioma: "es",
      parametros: 1,
    };

    const id = await cliente.enviarPlantilla("+51999111222", plantilla, [
      "retomo mi mensaje de ayer",
    ]);

    expect(id).toBe("wamid.TPL1");
    const cuerpo = JSON.parse(String(capturas[0]?.init?.body));
    expect(cuerpo.type).toBe("template");
    expect(cuerpo.template).toEqual({
      name: "kurogrid_followup",
      language: { code: "es" },
      components: [
        { type: "body", parameters: [{ type: "text", text: "retomo mi mensaje de ayer" }] },
      ],
    });

    // Un parámetro de más o vacío no debe llegar a Graph jamás.
    await expect(
      cliente.enviarPlantilla("+51999111222", plantilla, []),
    ).rejects.toThrow(/espera 1 parámetro/);
    await expect(
      cliente.enviarPlantilla("+51999111222", plantilla, ["   "]),
    ).rejects.toThrow(/parámetro vacío/);
    expect(capturas).toHaveLength(1);
  });

  it("clienteParaTandasEnNube convierte cada sendText en plantilla", async () => {
    const capturas: Array<{ url: string; init?: RequestInit }> = [];
    const cliente = clienteConFetch(
      [respuestaJson(200, { messages: [{ id: "wamid.FU1" }] })],
      capturas,
    );
    const tanda = clienteParaTandasEnNube({
      cliente,
      plantilla: { nombre: "kurogrid_followup", idioma: "es", parametros: 1 },
    });

    const id = await tanda.sendText("+51999111222", "texto compuesto y auditado");

    expect(id).toBe("wamid.FU1");
    const cuerpo = JSON.parse(String(capturas[0]?.init?.body));
    expect(cuerpo.template.components[0].parameters[0].text).toBe(
      "texto compuesto y auditado",
    );

    // Y lo que no existe en nube sin plantilla de media, se dice de una.
    await expect(tanda.sendImage("+51999111222", new Uint8Array([1]), "x")).rejects.toThrow(
      /plantilla de media/,
    );
  });

  it("start levanta el webhook: handshake, firma y despacho punta a punta", async () => {
    const cliente = await clienteVivo();
    const base = `http://${cliente.direccion}`;

    // Chequeo manual de salud.
    expect(await (await fetch(base!)).text()).toContain("canal cloud");

    // Handshake correcto devuelve el challenge; token equivocado, 403.
    const challenge = await (
      await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${CFG.verifyToken}&hub.challenge=CHALLENGE123`)
    ).text();
    expect(challenge).toBe("CHALLENGE123");
    expect(
      (await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=malo&hub.challenge=x`)).status,
    ).toBe(403);

    // Un POST firmado despierta los handlers; uno sin firma no pasa.
    const recibidos: InboundEvent[] = [];
    const acks: Array<[string, number]> = [];
    cliente.onInbound((evento) => recibidos.push(evento));
    cliente.onAck((waMessageId, ack) => acks.push([waMessageId, ack]));

    const cuerpo = JSON.stringify(
      payloadWebhook([mensajeTexto("me interesa")], [
        { id: "wamid.SALIDA-VIEJA", status: "delivered", timestamp: TS },
      ]),
    );
    const buena = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": firma(cuerpo) },
      body: cuerpo,
    });
    expect(buena.status).toBe(200);
    expect(recibidos).toHaveLength(1);
    expect(recibidos[0]).toMatchObject({ e164: "+51999111222", body: "me interesa" });
    expect(acks).toEqual([["wamid.SALIDA-VIEJA", 2]]);

    const sinFirma = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: cuerpo,
    });
    expect(sinFirma.status).toBe(401);
    expect(recibidos).toHaveLength(1);

    // Un webhook de OTRO número se ignora entero: mezclar chats corrompería
    // las conversaciones.
    const ajeno = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "OTRO" }, messages: [mensajeTexto("hola")] } }] }],
    });
    await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": firma(ajeno) },
      body: ajeno,
    });
    expect(recibidos).toHaveLength(1);
  });

  it("stop cierra el servidor y start puede volver a abrirlo", async () => {
    const cliente = await clienteVivo();
    const base = `http://${cliente.direccion}`;
    await cliente.stop();
    await expect(fetch(base!)).rejects.toBeTruthy();
    expect(cliente.direccion).toBeNull();
  });
});
