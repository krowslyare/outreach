import { proto } from "baileys";
import { describe, expect, it } from "vitest";

import {
  ACK_DESDE_BAILEYS,
  e164DesdeJid,
  textoDeMensaje,
  tipoDeMensaje,
} from "./client.js";

const Status = proto.WebMessageInfo.Status;

/**
 * El umbral que usa el store para decidir "llegó al dispositivo". Se repite acá
 * a propósito: si alguien lo cambia allá, este archivo tiene que dejar de
 * compilar mentalmente al leerlo, no seguir pasando en silencio.
 */
const UMBRAL_DISPOSITIVO = 2;

describe("traducción de ACK de Baileys", () => {
  // La razón de ser de la tabla. Las dos escalas están corridas en uno, así que
  // pasar los valores crudos haría que un simple acuse de servidor contara como
  // entregado al dispositivo: deviceRate inflado y kill switch ciego mientras el
  // número se quema.
  it("un acuse de SERVIDOR no cuenta como entregado al dispositivo", () => {
    const ack = ACK_DESDE_BAILEYS[Status.SERVER_ACK];
    expect(ack).toBe(1);
    expect(ack! >= UMBRAL_DISPOSITIVO).toBe(false);
  });

  it("un acuse de ENTREGA sí cuenta como entregado al dispositivo", () => {
    const ack = ACK_DESDE_BAILEYS[Status.DELIVERY_ACK];
    expect(ack).toBe(2);
    expect(ack! >= UMBRAL_DISPOSITIVO).toBe(true);
  });

  it("mapea el resto de la escala sin huecos", () => {
    expect(ACK_DESDE_BAILEYS[Status.ERROR]).toBe(-1);
    expect(ACK_DESDE_BAILEYS[Status.PENDING]).toBe(0);
    expect(ACK_DESDE_BAILEYS[Status.READ]).toBe(3);
    expect(ACK_DESDE_BAILEYS[Status.PLAYED]).toBe(4);
  });

  it("leído y reproducido siguen contando como entregados", () => {
    for (const estado of [Status.READ, Status.PLAYED]) {
      expect(ACK_DESDE_BAILEYS[estado]! >= UMBRAL_DISPOSITIVO).toBe(true);
    }
  });
});

describe("e164DesdeJid", () => {
  it("extrae el número de un jid de persona", () => {
    expect(e164DesdeJid("51931845435@s.whatsapp.net")).toBe("+51931845435");
  });

  it("ignora el sufijo de dispositivo", () => {
    expect(e164DesdeJid("51931845435:12@s.whatsapp.net")).toBe("+51931845435");
  });

  // Un grupo no se contesta solo, y de un @lid no se puede derivar el teléfono.
  it("descarta grupos, difusiones y lid", () => {
    for (const jid of [
      "120363000000000000@g.us",
      "status@broadcast",
      "258029438152930@lid",
      null,
      undefined,
    ]) {
      expect(e164DesdeJid(jid)).toBeNull();
    }
  });
});

describe("tipoDeMensaje", () => {
  it("reconoce texto plano y texto extendido como chat", () => {
    expect(tipoDeMensaje({ conversation: "hola" })).toBe("chat");
    expect(tipoDeMensaje({ extendedTextMessage: { text: "hola" } })).toBe("chat");
  });

  // El clasificador trata todo lo que no sea "chat" como actividad humana, así
  // que estos nombres deciden si un audio corta la cadencia o no.
  it("nombra los tipos con media", () => {
    expect(tipoDeMensaje({ audioMessage: {} })).toBe("audio");
    expect(tipoDeMensaje({ imageMessage: {} })).toBe("image");
    expect(tipoDeMensaje({ stickerMessage: {} })).toBe("sticker");
  });

  it("un mensaje vacío no se hace pasar por chat", () => {
    expect(tipoDeMensaje(null)).toBe("desconocido");
    expect(tipoDeMensaje({})).toBe("desconocido");
  });
});

describe("textoDeMensaje", () => {
  it("saca el texto de las dos formas y del caption", () => {
    expect(textoDeMensaje({ conversation: "hola" })).toBe("hola");
    expect(textoDeMensaje({ extendedTextMessage: { text: "qué tal" } })).toBe(
      "qué tal",
    );
    expect(textoDeMensaje({ imageMessage: { caption: "mira" } })).toBe("mira");
  });

  it("sin texto devuelve cadena vacía y no undefined", () => {
    expect(textoDeMensaje({ audioMessage: {} })).toBe("");
    expect(textoDeMensaje(null)).toBe("");
  });
});
