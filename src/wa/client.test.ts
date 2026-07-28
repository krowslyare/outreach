import { DisconnectReason, proto } from "baileys";
import { describe, expect, it } from "vitest";

import {
  ACK_DESDE_BAILEYS,
  clasificarCierre,
  cuerpoInbound,
  e164DesdeJid,
  esperaReconexion,
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

describe("clasificarCierre", () => {
  // La regresión concreta: en la primera prueba larga se cayó la red, llegó un
  // 408, y el kill switch persistente apagó la campaña. Recuperarse exigía
  // editar la base a mano.
  it("un timeout de red NO es un problema de cuenta", () => {
    for (const codigo of [
      DisconnectReason.timedOut,
      DisconnectReason.connectionLost,
      DisconnectReason.connectionClosed,
      DisconnectReason.unavailableService,
    ]) {
      expect(clasificarCierre(codigo).clase).toBe("transitorio");
    }
  });

  // Un código nuevo o desconocido no debe apagar la campaña: reconectar no
  // envía nada, y cada envío sigue pasando por el motor de seguridad.
  it("lo desconocido se reintenta, no se da por fatal", () => {
    expect(clasificarCierre(undefined).clase).toBe("transitorio");
    expect(clasificarCierre(499).clase).toBe("transitorio");
  });

  it("solo lo que necesita un humano dispara el kill switch", () => {
    for (const codigo of [
      DisconnectReason.loggedOut,
      DisconnectReason.forbidden,
      DisconnectReason.badSession,
      DisconnectReason.multideviceMismatch,
    ]) {
      expect(clasificarCierre(codigo).clase).toBe("cuenta");
    }
  });

  // La cuenta está sana: es la sesión la que se movió a otro lado. Marcarla como
  // problema de cuenta obligaría a limpiar el kill switch por abrir WhatsApp Web.
  it("otra sesión tomando el número no es un problema de cuenta", () => {
    expect(clasificarCierre(DisconnectReason.connectionReplaced).clase).toBe(
      "reemplazada",
    );
  });

  it("el reinicio tras vincular sigue siendo su propio caso", () => {
    expect(clasificarCierre(DisconnectReason.restartRequired).clase).toBe(
      "reinicio",
    );
  });
});

describe("esperaReconexion", () => {
  it("crece y se topa, para no dormir horas ni martillar a WhatsApp", () => {
    expect(esperaReconexion(1)).toBe(2_000);
    expect(esperaReconexion(2)).toBe(4_000);
    expect(esperaReconexion(8)).toBe(60_000);
    expect(esperaReconexion(50)).toBe(60_000);
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

describe("cuerpoInbound", () => {
  // Antes una nota de voz llegaba al agente con el cuerpo vacío: un turno del
  // prospecto sin nada adentro, contestado a ciegas o directamente inventado.
  it("nombra en español lo que no trae texto", () => {
    expect(cuerpoInbound({ audioMessage: {} }, "audio")).toBe("[nota de voz]");
    expect(cuerpoInbound({ imageMessage: {} }, "image")).toBe("[imagen]");
    expect(cuerpoInbound({ documentMessage: {} }, "document")).toBe("[documento]");
  });

  it("un tipo no listado igual sale marcado y no vacío", () => {
    expect(cuerpoInbound({ pollCreationMessage: {} }, "pollcreation")).toBe(
      "[pollcreation]",
    );
  });

  // El caption es lo que la persona sí escribió: vale más que el marcador.
  it("prefiere el texto real cuando existe", () => {
    expect(cuerpoInbound({ imageMessage: { caption: "mire esto" } }, "image")).toBe(
      "mire esto",
    );
    expect(cuerpoInbound({ conversation: "hola" }, "chat")).toBe("hola");
  });

  // Un texto vacío de verdad no se disfraza de media.
  it("no inventa marcador para un chat vacío", () => {
    expect(cuerpoInbound({ conversation: "" }, "chat")).toBe("");
    expect(cuerpoInbound(null, "desconocido")).toBe("");
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
