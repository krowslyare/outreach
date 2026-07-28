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
/**
 * El humano escribió desde su propio teléfono a este chat.
 *
 * Lleva el `waMessageId` para que quien escuche pueda contrastarlo contra la
 * base: el Set en memoria del cliente no conoce lo que mandó una ejecución
 * anterior del proceso.
 */
export type EnvioManualHandler = (
  e164: string,
  waMessageId: string,
  at: Date,
) => void;

export interface WaClient {
  sendText(e164: string, body: string): Promise<string>;
  onInbound(callback: InboundHandler): void;
  onAck(callback: AckHandler): void;
  onFatal(callback: FatalHandler): void;
  onEnvioManual(callback: EnvioManualHandler): void;
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

/**
 * Qué hacer cuando WhatsApp cierra la conexión.
 *
 * Antes existían dos casos —`restartRequired` y `loggedOut`— y TODO lo demás
 * caía en "fatal", que dispara el kill switch persistente. Un timeout de red
 * (408) apagaba la campaña hasta que alguien editara la base a mano. Pasó de
 * verdad en la primera prueba larga.
 *
 * La asimetría manda: el kill switch existe para dejar de ENVIAR cuando WhatsApp
 * está castigando la cuenta. Reconectar no envía nada —cada envío sigue pasando
 * por el motor de seguridad— así que reconectar de más no cuesta. No reconectar
 * cuesta el listener entero: respuestas perdidas y ACKs perdidos, o sea el kill
 * switch ciego. Por eso lo desconocido se trata como transitorio, con tope.
 */
export type ClaseCierre =
  /** Ruido de red. Se reconecta con espera creciente. */
  | "transitorio"
  /** Normal justo después de vincular. Se reconecta de inmediato. */
  | "reinicio"
  /** La cuenta necesita un humano. Dispara el kill switch. */
  | "cuenta"
  /** Otra sesión tomó el número. Se para, pero la cuenta está sana. */
  | "reemplazada";

export function clasificarCierre(codigo: number | undefined): {
  clase: ClaseCierre;
  razon: string;
} {
  switch (codigo) {
    case DisconnectReason.restartRequired:
      return { clase: "reinicio", razon: "WhatsApp pidió reiniciar la sesión" };
    case DisconnectReason.loggedOut:
      return {
        clase: "cuenta",
        razon:
          "loggedOut: la sesión se cerró desde el teléfono. Borra " +
          `${DIRECTORIO_SESION} y escanea el QR de nuevo.`,
      };
    case DisconnectReason.forbidden:
      return {
        clase: "cuenta",
        razon:
          "forbidden (403): WhatsApp rechazó la cuenta. Suele ser un baneo; " +
          "no sigas enviando desde este número.",
      };
    case DisconnectReason.badSession:
      return {
        clase: "cuenta",
        razon: `badSession (500): la sesión quedó corrupta. Borra ${DIRECTORIO_SESION} y vuelve a escanear.`,
      };
    case DisconnectReason.multideviceMismatch:
      return {
        clase: "cuenta",
        razon:
          "multideviceMismatch (411): hay que vincular el dispositivo de nuevo.",
      };
    case DisconnectReason.connectionReplaced:
      return {
        clase: "reemplazada",
        razon:
          "connectionReplaced (440): otra sesión tomó este número. Reconectar " +
          "acá solo se lo quitaría a la otra, así que este proceso se detiene.",
      };
    default:
      return {
        clase: "transitorio",
        razon: `conexión cerrada (${codigo ?? "sin código"})`,
      };
  }
}

/**
 * Cuánto se espera antes de dar por manual un `fromMe` desconocido, y cuántos
 * ids propios se recuerdan. Ver evaluarEnvioPropio.
 */
const CUARENTENA_ENVIO_PROPIO_MS = 5_000;
/** Hasta qué antigüedad se atiende un mensaje de la cola offline. */
export const MAX_ANTIGUEDAD_OFFLINE_MS = 24 * 60 * 60 * 1_000;
const MAX_IDS_PROPIOS = 1_000;

/** Cuántas reconexiones seguidas antes de rendirse, y cuánto se espera. */
const MAX_RECONEXIONES = 8;
export function esperaReconexion(intento: number): number {
  // 2s, 4s, 8s... hasta 60s. Sin tope, un corte largo dejaría el proceso
  // durmiendo horas; sin espera creciente, martillaría a WhatsApp, que es
  // justamente la conducta que hace que te bloqueen.
  return Math.min(2_000 * 2 ** (intento - 1), 60_000);
}

function pausa(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * Cómo se nombra en español lo que no es texto.
 *
 * Los tipos que no están acá caen en un genérico. La lista se amplía con lo que
 * se vea de verdad, no con lo que se imagine.
 */
const NOMBRE_MEDIA: Record<string, string> = {
  audio: "nota de voz",
  image: "imagen",
  video: "video",
  document: "documento",
  sticker: "sticker",
  contact: "contacto",
  location: "ubicación",
};

/**
 * El cuerpo que ve el agente y que queda en el hilo.
 *
 * Antes, una nota de voz o una foto llegaban con el cuerpo VACÍO: el agente
 * recibía un turno del prospecto sin nada adentro y contestaba a ciegas, o peor,
 * se inventaba de qué hablaba. Un marcador explícito le permite decir lo único
 * honesto —"no puedo escucharlo, ¿me lo escribe?"— y deja el hilo guardado
 * legible para quien lo abra después.
 *
 * Va entre corchetes a propósito: ningún humano escribe así, de modo que el
 * agente puede distinguirlo del texto real del prospecto.
 */
export function cuerpoInbound(
  mensaje: WAMessage["message"],
  tipo: string,
): string {
  const texto = textoDeMensaje(mensaje);
  if (texto.trim().length > 0) return texto;
  if (tipo === "chat" || tipo === "desconocido") return texto;
  return `[${NOMBRE_MEDIA[tipo] ?? tipo}]`;
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
  private readonly envioManualHandlers = new Set<EnvioManualHandler>();
  /**
   * IDs de los mensajes que envió ESTE proceso.
   *
   * Es lo que permite distinguir "lo mandó el bot" de "lo mandó el humano desde
   * su celular": los dos llegan con `fromMe`. Acotado porque una sesión larga
   * los acumularía sin fin, y lo viejo ya no sirve — el chequeo ocurre segundos
   * después del envío, no horas.
   */
  private readonly enviadosPropios = new Set<string>();
  private detenido = false;
  /** Reconexiones seguidas sin haber llegado a abrir. Se reinicia al abrir. */
  private intentos = 0;
  private reconectando = false;

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
    this.recordarPropio(waMessageId);
    return waMessageId;
  }

  private recordarPropio(waMessageId: string): void {
    this.enviadosPropios.add(waMessageId);
    if (this.enviadosPropios.size > MAX_IDS_PROPIOS) {
      const masViejo = this.enviadosPropios.values().next().value;
      if (masViejo !== undefined) this.enviadosPropios.delete(masViejo);
    }
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

  onEnvioManual(callback: EnvioManualHandler): void {
    this.envioManualHandlers.add(callback);
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
    for (this.intentos = 1; this.intentos <= MAX_RECONEXIONES; this.intentos += 1) {
      const resultado = await this.conectar();
      if (resultado.estado === "lista") return;
      console.info(
        `${resultado.razon}; reconectando (${this.intentos}/${MAX_RECONEXIONES})...`,
      );
      // El reinicio tras vincular es inmediato; un corte de red no.
      if (resultado.estado === "transitorio") {
        await pausa(esperaReconexion(this.intentos));
      }
    }
    throw new Error(
      `No se pudo abrir la sesión de WhatsApp en ${MAX_RECONEXIONES} intentos.`,
    );
  }

  /**
   * Reconecta después de que la sesión YA estaba abierta.
   *
   * Sin esto, un cierre posterior al `start()` no tenía a dónde ir: la promesa de
   * `conectar()` ya estaba resuelta, así que su `reject` era un no-op. El proceso
   * seguía vivo en el bucle de escucha con el socket muerto — parecía escuchando
   * y no oía nada, que es la peor de las dos fallas posibles.
   */
  private async reconectar(): Promise<void> {
    if (this.reconectando || this.detenido) return;
    this.reconectando = true;
    try {
      while (!this.detenido && this.intentos <= MAX_RECONEXIONES) {
        await pausa(esperaReconexion(this.intentos));
        if (this.detenido) return;
        console.info(
          `Reconectando a WhatsApp (${this.intentos}/${MAX_RECONEXIONES})...`,
        );
        try {
          const resultado = await this.conectar();
          if (resultado.estado === "lista") return;
          this.intentos += 1;
        } catch {
          // conectar() rechaza en los cierres de cuenta, que ya emitieron fatal.
          return;
        }
      }
      if (!this.detenido) {
        console.error(
          `Se agotaron los ${MAX_RECONEXIONES} intentos de reconexión. El proceso ` +
            `ya NO está escuchando: ni respuestas ni ACKs. Reinícialo.`,
        );
      }
    } finally {
      this.reconectando = false;
    }
  }

  private async conectar(): Promise<{
    estado: "lista" | "reinicio" | "transitorio";
    razon: string;
  }> {
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

    return new Promise((resolve, reject) => {
      // Un cierre DESPUÉS de abrir llega a este mismo listener, cuando la promesa
      // ya está resuelta. Ahí no se resuelve nada: se reconecta.
      let abierta = false;

      socket.ev.on("connection.update", (update) => {
        if (typeof update.qr === "string") this.mostrarQr(update.qr);

        if (update.connection === "open") {
          const numero = e164DesdeJid(socket.user?.id) ?? socket.user?.id ?? "?";
          console.info(`WhatsApp listo. Sesión de ${numero}: ya se puede enviar.`);
          abierta = true;
          this.intentos = 1;
          resolve({ estado: "lista", razon: "" });
          return;
        }

        if (update.connection !== "close") return;
        if (this.detenido) {
          if (!abierta) resolve({ estado: "lista", razon: "" });
          return;
        }

        const codigo =
          update.lastDisconnect?.error instanceof Boom
            ? update.lastDisconnect.error.output.statusCode
            : undefined;
        const { clase, razon } = clasificarCierre(codigo);

        if (clase === "cuenta") {
          // Lo único que apaga la campaña. El kill switch es persistente y
          // borrarlo es a mano, así que acá solo entra lo que de verdad
          // necesita a un humano mirando el teléfono.
          this.emitFatal(razon);
          if (abierta) console.error(`WhatsApp: ${razon}`);
          else reject(new Error(razon));
          return;
        }

        if (clase === "reemplazada") {
          // No se toca el kill switch: la cuenta está sana, es la sesión la que
          // se movió. Reconectar sería pelearse con la otra sesión a ping-pong.
          this.detenido = true;
          if (abierta) console.error(`WhatsApp: ${razon}`);
          else reject(new Error(razon));
          return;
        }

        if (!abierta) {
          resolve({ estado: clase === "reinicio" ? "reinicio" : "transitorio", razon });
          return;
        }

        console.warn(`WhatsApp se desconectó: ${razon}`);
        void this.reconectar();
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
      if (type !== "notify" && type !== "append") return;
      for (const mensaje of messages) {
        // 'append' es todo lo que no llegó en vivo: mezcla la cola de mensajes
        // que WhatsApp guardó mientras el proceso estaba apagado —que sí hay
        // que atender— con el historial que se sincroniza al vincular, que no.
        // Ver messages-recv.js: `node.attrs.offline ? 'append' : 'notify'`.
        //
        // Se separan por antigüedad porque no hay otro campo que los distinga.
        // Antes se ignoraba 'append' entero, y eso significaba que quien
        // escribiera con el bot caído no recibía respuesta nunca: el mensaje ni
        // siquiera llegaba a la base, así que tampoco lo rescataba el barrido
        // de pendientes.
        if (type === "append" && this.demasiadoViejo(mensaje)) continue;
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

  /**
   * ¿Este mensaje es historial viejo y no cola de offline?
   *
   * El corte por antigüedad es la única señal disponible para separarlos. Un
   * día es holgado para lo que buscamos —el bot no debería estar caído tanto—
   * y contestar algo de hace semanas al reconectar sería peor que perderlo:
   * delata que del otro lado hay una máquina que acaba de despertar.
   *
   * Sin timestamp se descarta: un mensaje de 'append' sin fecha no se puede
   * distinguir de historial, y de las dos equivocaciones ésta es la barata.
   */
  private demasiadoViejo(mensaje: WAMessage): boolean {
    const segundos = Number(mensaje.messageTimestamp ?? 0);
    if (segundos <= 0) return true;
    return Date.now() - segundos * 1_000 > MAX_ANTIGUEDAD_OFFLINE_MS;
  }

  private despacharInbound(mensaje: WAMessage): void {
    if (mensaje.key.fromMe === true) {
      void this.evaluarEnvioPropio(mensaje);
      return;
    }
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
      body: cuerpoInbound(contenido, tipo),
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

  /**
   * Decide si un mensaje `fromMe` lo escribió una persona desde su teléfono.
   *
   * Éste era el peor agujero del sistema: si el dueño entraba a un chat y
   * contestaba a mano, el bot no se enteraba —descartaba todo `fromMe`— y podía
   * seguir escribiendo encima suyo delante de un cliente.
   *
   * El riesgo al arreglarlo es el inverso, y es peor: confundir un envío del
   * propio bot con uno manual activaría el takeover sobre nuestro propio
   * mensaje y mataría esa conversación para siempre. Por eso hay CUARENTENA: si
   * el id no está registrado, puede ser que la promesa de `sendMessage` todavía
   * no haya resuelto y no nos haya dado el id. Se espera y se vuelve a mirar.
   * Un humano tardando cinco segundos más en ser detectado no cuesta nada; un
   * falso positivo cuesta el prospecto.
   */
  private async evaluarEnvioPropio(mensaje: WAMessage): Promise<void> {
    const id = mensaje.key.id;
    if (typeof id !== "string") return;
    if (this.enviadosPropios.has(id)) return;

    const e164 =
      e164DesdeJid(mensaje.key.remoteJid) ??
      e164DesdeJid(mensaje.key.remoteJidAlt);
    if (e164 === null) return;

    await pausa(CUARENTENA_ENVIO_PROPIO_MS);
    if (this.enviadosPropios.has(id)) return;
    if (this.detenido) return;

    const segundos = Number(mensaje.messageTimestamp ?? 0);
    const at = segundos > 0 ? new Date(segundos * 1_000) : new Date();
    for (const handler of this.envioManualHandlers) handler(e164, id, at);
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
