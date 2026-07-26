import qrcode from "qrcode-terminal";
import WhatsAppWeb from "whatsapp-web.js";

export type InboundHandler = (e164: string, body: string, at: Date) => void;
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

  async start(): Promise<void> {
    await this.client.initialize();
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private wireEvents(): void {
    this.client.on("qr", (qr: string) => {
      console.info("WhatsApp requiere vinculación; escanea este QR:");
      qrcode.generate(qr, { small: true });
    });
    this.client.on("ready", () => {
      console.info("WhatsApp listo.");
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
      for (const handler of this.inboundHandlers) {
        handler(e164, message.body, at);
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
