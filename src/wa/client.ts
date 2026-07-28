import { Boom } from "@hapi/boom";
import {
  DisconnectReason,
  makeWASocket,
  proto,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "baileys";
import type { ILogger } from "baileys/lib/Utils/logger.js";
import qrcode from "qrcode-terminal";

/**
 * Un entrante con lo que hace falta para clasificarlo.
 *
 * Sin `tipo`/`tieneMedia`/`citaOtroMensaje` no hay forma de distinguir un
 * saludo automático de una persona salvo adivinando por el texto, y sin
 * `waMessageId` un evento reemitido tras una reconexión se procesa dos veces.
 */
export interface InboundEvent {
  e164: string;
  body: string;
  at: Date;
  waMessageId: string;
  /** "chat" es texto plano; "audio", "image", "sticker"… todo lo demás. */
  tipo: string;
  tieneMedia: boolean;
  citaOtroMensaje: boolean;
}

export type InboundHandler = (evento: InboundEvent) => void;
export type AckHandler = (
  waMessageId: string,
  ack: number,
  at: Date,
) => void;
export type FatalHandler = (reason: string) => void;

export interface WaClient {
  sendText(e164: string, body: string): Promise<string>;
  onInbound(callback: InboundHandler): void;
  onAck(callback: AckHandler): void;
  onFatal(callback: FatalHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Dónde vive la sesión. Perderla obliga a escanear el QR de nuevo. */
const DIRECTORIO_SESION = ".baileys_auth";

/**
 * Traducción de los estados de Baileys a la escala que usa el resto del sistema.
 *
 * NO es cosmética y no se puede reemplazar por una resta. Las dos escalas están
 * corridas en uno:
 *
 *   llegó al servidor      Baileys 2  →  nuestro 1
 *   LLEGÓ AL DISPOSITIVO   Baileys 3  →  nuestro 2
 *   leído                  Baileys 4  →  nuestro 3
 *
 * `deviceRate` —la señal primaria del kill switch— cuenta `ack >= 2`. Pasando
 * los valores crudos de Baileys, un simple acuse del servidor contaría como
 * entregado al dispositivo: la tasa quedaría inflada y el kill switch no
 * saltaría nunca mientras el número se quema. Es exactamente el modo de falla
 * que el kill switch existe para evitar.
 *
 * Se escribe como tabla explícita y no como `baileys - 1` a propósito: si
 * cualquiera de los dos enums cambia, una resta sigue compilando y mintiendo.
 */
export const ACK_DESDE_BAILEYS: Record<number, number> = {
  [proto.WebMessageInfo.Status.ERROR]: -1,
  [proto.WebMessageInfo.Status.PENDING]: 0,
  [proto.WebMessageInfo.Status.SERVER_ACK]: 1,
  [proto.WebMessageInfo.Status.DELIVERY_ACK]: 2,
  [proto.WebMessageInfo.Status.READ]: 3,
  [proto.WebMessageInfo.Status.PLAYED]: 4,
};

/** Baileys exige un logger con forma de pino. Callado: su traza es enorme. */
const LOGGER_SILENCIOSO: ILogger = {
  level: "silent",
  child: () => LOGGER_SILENCIOSO,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function e164DesdeJid(jid: string | null | undefined): string | null {
  if (typeof jid !== "string" || !jid.endsWith("@s.whatsapp.net")) return null;
  const digits = jid.slice(0, -"@s.whatsapp.net".length).split(":")[0] ?? "";
  return /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
}

/**
 * El tipo del mensaje, con el mismo vocabulario que espera el clasificador:
 * "chat" para texto plano y el nombre del contenido para todo lo demás.
 */
export function tipoDeMensaje(mensaje: WAMessage["message"]): string {
  if (mensaje === null || mensaje === undefined) return "desconocido";
  if (mensaje.conversation !== undefined && mensaje.conversation !== null) {
    return "chat";
  }
  if (mensaje.extendedTextMessage) return "chat";
  const clave = Object.keys(mensaje).find((k) => k.endsWith("Message"));
  return clave === undefined
    ? "desconocido"
    : clave.replace(/Message$/, "").toLowerCase();
}

export function textoDeMensaje(mensaje: WAMessage["message"]): string {
  if (mensaje === null || mensaje === undefined) return "";
  return (
    mensaje.conversation ??
    mensaje.extendedTextMessage?.text ??
    mensaje.imageMessage?.caption ??
    mensaje.videoMessage?.caption ??
    ""
  );
}

/**
 * Adaptador sobre Baileys.
 *
 * El resto del sistema depende de WaClient, no de la librería. Esa frontera es
 * la que permitió reemplazar whatsapp-web.js —que dejó de poder enviar contra
 * WhatsApp Web— tocando un solo archivo.
 *
 * A diferencia del anterior, esto habla el protocolo por WebSocket en vez de
 * manejar un Chrome y llamar funciones internas de la página. Un cambio de la
 * interfaz de WhatsApp Web ya no lo rompe.
 */
export class BaileysClient implements WaClient {
  private socket: WASocket | null = null;
  private readonly inboundHandlers = new Set<InboundHandler>();
  private readonly ackHandlers = new Set<AckHandler>();
  private readonly fatalHandlers = new Set<FatalHandler>();
  private detenido = false;

  async sendText(e164: string, body: string): Promise<string> {
    const socket = this.socket;
    if (socket === null) {
      throw new Error("sendText antes de start(): no hay sesión");
    }
    const digits = e164.replace(/\D/g, "");
    if (digits.length === 0) throw new Error(`E.164 inválido: ${e164}`);

    // Se le pregunta a WhatsApp cuál es el jid en vez de armarlo a mano: un
    // número sin WhatsApp se corta acá con un mensaje que se entiende, y la
    // forma real del identificador la decide WhatsApp.
    const encontrados = await socket.onWhatsApp(digits);
    const contacto = encontrados?.find((c) => c.exists);
    if (contacto === undefined) {
      throw new Error(
        `${e164} no está registrado en WhatsApp; no se envía nada.`,
      );
    }

    const mensaje = await socket.sendMessage(contacto.jid, { text: body });
    const waMessageId = mensaje?.key?.id;
    if (typeof waMessageId !== "string") {
      // Sin id no hay forma de correlacionar los ACK, y sin ACK el kill switch
      // se queda ciego. Es un fallo, no un detalle: el mensaje PUEDE haber
      // salido, así que quien reintente tiene que mirar el chat primero.
      throw new Error(
        `WhatsApp aceptó el envío a ${e164} pero no devolvió un id de mensaje. ` +
          `El mensaje PUEDE haber salido: revisa el chat antes de reintentar.`,
      );
    }
    return waMessageId;
  }

  onInbound(callback: InboundHandler): void {
    this.inboundHandlers.add(callback);
  }

  onAck(callback: AckHandler): void {
    this.ackHandlers.add(callback);
  }

  onFatal(callback: FatalHandler): void {
    this.fatalHandlers.add(callback);
  }

  /**
   * Levanta la sesión y NO vuelve hasta que se puede enviar de verdad.
   *
   * Reconecta sola ante `restartRequired`, que WhatsApp manda de rutina justo
   * después del primer escaneo: tratarlo como fallo haría que vincular el
   * número nunca funcionara a la primera. Un `loggedOut` sí es terminal — la
   * sesión murió y hay que escanear de nuevo.
   *
   * Si nadie escanea el QR, esto no vuelve nunca, y así debe ser: el operador
   * está mirando la pantalla y el proceso no tiene nada que hacer mientras.
   */
  async start(): Promise<void> {
    for (let intento = 1; intento <= 5; intento += 1) {
      const reinicio = await this.conectar();
      if (!reinicio) return;
      console.info(
        `WhatsApp pidió reiniciar la sesión (normal tras vincular); reconectando (${intento}/5)...`,
      );
    }
    throw new Error(
      "WhatsApp pidió reiniciar la sesión 5 veces seguidas; se aborta para no " +
        "quedar en un bucle de reconexión.",
    );
  }

  /** Resuelve `true` si hay que volver a conectar, `false` si quedó lista. */
  private async conectar(): Promise<boolean> {
    const { state, saveCreds } = await useMultiFileAuthState(DIRECTORIO_SESION);
    const socket = makeWASocket({
      auth: state,
      logger: LOGGER_SILENCIOSO,
      // El nombre que se ve en "Dispositivos vinculados" del teléfono.
      browser: ["Kurogrid Outreach", "Chrome", "1.0.0"],
      // No se marcan en línea: un número que figura conectado 24/7 es una señal
      // de automatización, y la presencia no aporta nada a este flujo.
      markOnlineOnConnect: false,
    });
    this.socket = socket;
    socket.ev.on("creds.update", () => {
      void saveCreds();
    });
    this.wireEvents(socket);

    return new Promise<boolean>((resolve, reject) => {
      socket.ev.on("connection.update", (update) => {
        if (typeof update.qr === "string") this.mostrarQr(update.qr);

        if (update.connection === "open") {
          const numero = e164DesdeJid(socket.user?.id) ?? socket.user?.id ?? "?";
          console.info(`WhatsApp listo. Sesión de ${numero}: ya se puede enviar.`);
          resolve(false);
          return;
        }

        if (update.connection !== "close") return;

        const codigo =
          update.lastDisconnect?.error instanceof Boom
            ? update.lastDisconnect.error.output.statusCode
            : undefined;

        if (this.detenido) {
          resolve(false);
          return;
        }
        if (codigo === DisconnectReason.restartRequired) {
          resolve(true);
          return;
        }
        if (codigo === DisconnectReason.loggedOut) {
          const razon =
            "loggedOut: la sesión se cerró desde el teléfono. Borra " +
            `${DIRECTORIO_SESION} y escanea el QR de nuevo.`;
          this.emitFatal(razon);
          reject(new Error(razon));
          return;
        }
        const razon = `conexión cerrada (${codigo ?? "sin código"})`;
        this.emitFatal(razon);
        reject(new Error(razon));
      });
    });
  }

  private mostrarQr(qr: string): void {
    console.info(
      "\n" +
        "═".repeat(60) +
        "\n  ESCANEA ESTE QR desde el WhatsApp que va a enviar:\n" +
        "  WhatsApp → Dispositivos vinculados → Vincular dispositivo\n" +
        "═".repeat(60) +
        "\n",
    );
    qrcode.generate(qr, { small: false });
  }

  private wireEvents(socket: WASocket): void {
    socket.ev.on("messages.upsert", ({ messages, type }) => {
      // 'notify' es lo que acaba de llegar. 'append' es historial que Baileys
      // sincroniza al conectar: procesarlo haría que el agente contestara
      // conversaciones viejas al arrancar.
      if (type !== "notify") return;
      for (const mensaje of messages) {
        this.despacharInbound(mensaje);
      }
    });

    socket.ev.on("messages.update", (updates) => {
      const at = new Date();
      for (const { key, update } of updates) {
        const estado = update.status;
        if (typeof key.id !== "string" || estado === null || estado === undefined) {
          continue;
        }
        const ack = ACK_DESDE_BAILEYS[estado];
        if (ack === undefined) continue;
        for (const handler of this.ackHandlers) handler(key.id, ack, at);
      }
    });
  }

  private despacharInbound(mensaje: WAMessage): void {
    if (mensaje.key.fromMe === true) return;
    // remoteJid puede venir como @lid; remoteJidAlt trae entonces el jid con el
    // número real. Se prueban los dos y, si ninguno da un teléfono, se descarta:
    // sin número no hay a quién asociarlo en la base. También deja fuera grupos
    // (@g.us) y difusiones, que no se contestan solos.
    const e164 =
      e164DesdeJid(mensaje.key.remoteJid) ??
      e164DesdeJid(mensaje.key.remoteJidAlt);
    if (e164 === null) return;
    if (typeof mensaje.key.id !== "string") return;

    const contenido = mensaje.message;
    const tipo = tipoDeMensaje(contenido);
    const segundos = Number(mensaje.messageTimestamp ?? 0);
    const evento: InboundEvent = {
      e164,
      body: textoDeMensaje(contenido),
      // El timestamp del mensaje conserva cuándo escribió el prospecto aunque
      // el proceso haya estado ocupado antes de despachar el callback.
      at: segundos > 0 ? new Date(segundos * 1_000) : new Date(),
      waMessageId: mensaje.key.id,
      tipo,
      tieneMedia: tipo !== "chat" && tipo !== "desconocido",
      citaOtroMensaje:
        contenido?.extendedTextMessage?.contextInfo?.quotedMessage !== undefined &&
        contenido?.extendedTextMessage?.contextInfo?.quotedMessage !== null,
    };
    for (const handler of this.inboundHandlers) handler(evento);
  }

  async stop(): Promise<void> {
    this.detenido = true;
    // `end` cierra el socket sin desvincular. logout() borraría la sesión del
    // teléfono y obligaría a escanear otra vez en la próxima tanda.
    this.socket?.end(undefined);
    this.socket = null;
  }

  private emitFatal(reason: string): void {
    for (const handler of this.fatalHandlers) handler(reason);
  }
}

export function createWaClient(): WaClient {
  return new BaileysClient();
}
