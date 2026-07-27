import qrcode from "qrcode-terminal";
import WhatsAppWeb from "whatsapp-web.js";

/**
 * Un entrante con lo que hace falta para clasificarlo.
 *
 * Antes se pasaban solo `e164`, `body` y `at`, y el resto de la metadata moría
 * acá. Sin `tipo`/`tieneMedia`/`citaOtroMensaje` no hay forma de distinguir un
 * saludo automático de una persona salvo adivinando por el texto, y sin
 * `waMessageId` un evento reemitido tras una reconexión se procesa dos veces.
 */
export interface InboundEvent {
  e164: string;
  body: string;
  at: Date;
  waMessageId: string;
  /** `Message.type`: "chat" es texto plano; "ptt" audio, "image", "sticker"... */
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

function e164FromChatId(chatId: string): string | null {
  if (!chatId.endsWith("@c.us")) return null;
  const digits = chatId.slice(0, -"@c.us".length).replace(/\D/g, "");
  return digits.length === 0 ? null : `+${digits}`;
}

/**
 * Adaptador mínimo sobre whatsapp-web.js.
 *
 * El resto del sistema depende de WaClient, no de la librería. Así los tests de
 * seguridad pueden usar un fake y una rotura de WhatsApp Web queda encerrada.
 */
export class WhatsAppWebClient implements WaClient {
  private readonly client: WhatsAppWeb.Client;
  private readonly inboundHandlers = new Set<InboundHandler>();
  private readonly ackHandlers = new Set<AckHandler>();
  private readonly fatalHandlers = new Set<FatalHandler>();

  constructor() {
    this.client = new WhatsAppWeb.Client({
      authStrategy: new WhatsAppWeb.LocalAuth({ dataPath: ".wwebjs_auth" }),
    });
    this.wireEvents();
  }

  async sendText(e164: string, body: string): Promise<string> {
    const digits = e164.replace(/\D/g, "");
    if (digits.length === 0) throw new Error(`E.164 inválido: ${e164}`);
    const message = await this.client.sendMessage(`${digits}@c.us`, body);
    return message.id._serialized;
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
   * `initialize()` resuelve cuando la página quedó montada, que es antes de que
   * WhatsApp Web termine de cargar su store interno. Esperar solo a eso hacía
   * que la campaña llamara a `sendText` contra un cliente a medio levantar y
   * reventara con "Cannot read properties of undefined (reading 'getChat')" —
   * un error que no dice nada sobre su causa. El evento `ready` es la única
   * señal de que el store está cargado.
   *
   * Si nadie escanea el QR, esto no vuelve nunca, y así debe ser: el operador
   * está mirando la pantalla y el proceso no tiene nada que hacer mientras
   * tanto.
   */
  async start(): Promise<void> {
    const listo = new Promise<void>((resolve, reject) => {
      this.client.once("ready", () => resolve());
      this.client.once("auth_failure", (message: string) => {
        reject(new Error(`auth_failure: ${message}`));
      });
    });
    await this.client.initialize();
    await listo;
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private wireEvents(): void {
    this.client.on("qr", (qr: string) => {
      // Con marco y a tamaño completo: el QR chico se rompe en terminales que
      // no dibujan medios bloques, y ahí el operador ve un borrón y cree que
      // el proceso no arrancó.
      console.info(
        "\n" +
          "═".repeat(60) +
          "\n  ESCANEA ESTE QR desde el WhatsApp que va a enviar:\n" +
          "  WhatsApp → Dispositivos vinculados → Vincular dispositivo\n" +
          "═".repeat(60) +
          "\n",
      );
      qrcode.generate(qr, { small: false });
      console.info(
        "\nSi ves un borrón en vez de un QR, corre esto en una terminal " +
          "de verdad (Terminal.app o iTerm), no en un panel de salida.\n",
      );
    });
    this.client.on("ready", () => {
      console.info("WhatsApp listo: store cargado, ya se puede enviar.");
    });
    this.client.on("authenticated", () => {
      console.info("WhatsApp autenticado.");
    });
    this.client.on("auth_failure", (message: string) => {
      const reason = `auth_failure: ${message}`;
      console.error(reason);
      this.emitFatal(reason);
    });
    this.client.on("disconnected", (rawReason: unknown) => {
      const reason = String(rawReason);
      console.warn(`WhatsApp desconectado: ${reason}`);
      if (/LOGOUT|CONFLICT/i.test(reason)) {
        this.emitFatal(`disconnected: ${reason}`);
      }
    });
    this.client.on("message", (message: WhatsAppWeb.Message) => {
      if (message.fromMe) return;
      const e164 = e164FromChatId(message.from);
      if (e164 === null) return;
      // El timestamp del evento conserva cuándo escribió el prospecto aunque
      // el proceso haya estado ocupado antes de despachar el callback.
      const at = new Date(message.timestamp * 1_000);
      const evento: InboundEvent = {
        e164,
        body: message.body,
        at,
        waMessageId: message.id._serialized,
        tipo: String(message.type),
        tieneMedia: message.hasMedia === true,
        citaOtroMensaje: message.hasQuotedMsg === true,
      };
      for (const handler of this.inboundHandlers) {
        handler(evento);
      }
    });
    this.client.on(
      "message_ack",
      (message: WhatsAppWeb.Message, ack: WhatsAppWeb.MessageAck) => {
        const at = new Date();
        for (const handler of this.ackHandlers) {
          handler(message.id._serialized, Number(ack), at);
        }
      },
    );
  }

  private emitFatal(reason: string): void {
    for (const handler of this.fatalHandlers) handler(reason);
  }
}

export function createWaClient(): WaClient {
  return new WhatsAppWebClient();
}
