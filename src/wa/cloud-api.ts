// Adaptador de la API oficial de WhatsApp (Cloud API de Meta).
//
// Implementa el MISMO contrato WaClient que BaileysClient, así que el resto del
// sistema —motor de seguridad, agente, bandeja— no sabe qué canal está debajo.
// Se activa con CANAL=cloud en el entorno; por defecto sigue siendo Baileys.
//
// EL LÍMITE DE ESTE CANAL, ANTES DE EMOCIONARSE:
//
// La API oficial NO permite iniciar una conversación con texto libre. Todo
// mensaje business-initiated tiene que salir de una plantilla pre-aprobada; un
// texto libre fuera de la ventana de servicio rebota con #131047 o #131026.
// Este adaptador cubre entonces la mitad del flujo donde la API es gratis y
// legal: CONTESTAR dentro de la ventana de 24 horas que abre cada mensaje del
// prospecto. El primer toque en frío y los follow-ups a quien nunca respondió
// siguen siendo trabajo de Baileys o de plantillas (no implementado acá).
//
// Por eso campana.ts rechaza correr una tanda con este canal: los envíos
// fallarían todos en Meta, no por un bug nuestro sino por diseño de la
// plataforma.
//
// Lo que sí funciona punta a punta: webhook → inbound → agente → respuesta →
// ACKs de estados (sent/delivered/read) alimentando deviceRate.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import type {
  AckHandler,
  EnvioManualHandler,
  FatalHandler,
  InboundEvent,
  InboundHandler,
  ConsultaWhatsApp,
  WaClient,
} from "./client.js";
import { NOMBRE_MEDIA } from "./client.js";

/** Qué canal usa createWaClient(). Se lee del entorno, default Baileys. */
export function canalSeleccionado(
  entorno: NodeJS.ProcessEnv = process.env,
): "baileys" | "cloud" {
  return entorno.CANAL?.trim().toLowerCase() === "cloud" ? "cloud" : "baileys";
}

export interface ConfigCloudApi {
  token: string;
  /** El id del número de WhatsApp Business, de la consola de Meta. */
  phoneNumberId: string;
  /** Secreto de la app: valida la firma X-Hub-Signature-256 del webhook. */
  appSecret: string;
  /** Token propio para el handshake de verificación GET del webhook. */
  verifyToken: string;
  /** Versión de la Graph API. Fijada explícita, no "latest". */
  version?: string;
  puerto?: number;
}

/**
 * Lee la configuración del entorno y dice exactamente qué falta, todo junto.
 * Fallar uno por uno obliga a redeployar cinco veces para descubrir cinco
 * variables.
 */
export function configDesdeEntorno(
  entorno: NodeJS.ProcessEnv = process.env,
): ConfigCloudApi {
  const faltantes = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"].filter(
    (clave) => !entorno[clave]?.trim(),
  );
  if (faltantes.length > 0) {
    throw new Error(
      `CANAL=cloud requiere estas variables sin valor: ${faltantes.join(", ")}`,
    );
  }
  return {
    token: entorno.WHATSAPP_TOKEN!.trim(),
    phoneNumberId: entorno.WHATSAPP_PHONE_NUMBER_ID!.trim(),
    appSecret: entorno.WHATSAPP_APP_SECRET!.trim(),
    verifyToken: entorno.WHATSAPP_VERIFY_TOKEN!.trim(),
    puerto: entorno.PUERTO_WEBHOOK ? Number(entorno.PUERTO_WEBHOOK) : undefined,
  };
}

/**
 * Firma del webhook, verificada en tiempo constante.
 *
 * Sin esta verificación, cualquiera que descubra la URL puede inyectar
 * mensajes falsos: un "quiero contratar" inventado escala un lead que no
 * existe, y un opt-out falso suprime un prospecto real. La firma es la única
 * puerta entre internet y el motor de seguridad.
 */
export function verificarFirma(
  appSecret: string,
  cuerpoCrudo: string,
  encabezado: string | undefined,
): boolean {
  if (typeof encabezado !== "string" || !encabezado.startsWith("sha256=")) {
    return false;
  }
  const recibida = Buffer.from(encabezado.slice("sha256=".length), "hex");
  const esperada = createHmac("sha256", appSecret).update(cuerpoCrudo).digest();
  if (recibida.length !== esperada.length) return false;
  return timingSafeEqual(recibida, esperada);
}

/**
 * Estados de entrega de la Cloud API traducidos a nuestra escala de ACKs.
 *
 * Misma disciplina que ACK_DESDE_BAILEYS: tabla explícita, no aritmética.
 * deviceRate cuenta ack >= 2 (llegó al dispositivo), así que confundir "sent"
 * —aceptado por Meta, nada más— con "delivered" inflaría la tasa y apagaría
 * justo la señal que avisa que el número está quemándose.
 */
export const ACK_DESDE_ESTADO: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: -1,
};

/** Los tipos de contenido de la Cloud API que son texto legible. */
const TIPOS_TEXTO = new Set(["text", "interactive", "button"]);

function textoDeWebhook(mensaje: RegistroMensaje): string {
  const texto = mensaje.text?.body;
  if (typeof texto === "string") return texto;

  const interactivo = mensaje.interactive;
  const titulo =
    interactivo?.button_reply?.title ?? interactivo?.list_reply?.title;
  if (typeof titulo === "string") return titulo;

  // Los botones viejos (type "button") traen el texto directo.
  const boton = mensaje.button?.text;
  if (typeof boton === "string") return boton;

  const caption =
    mensaje.image?.caption ?? mensaje.video?.caption ?? mensaje.document?.caption;
  if (typeof caption === "string" && caption.trim() !== "") return caption;

  return "";
}

/**
 * El marcador entre corchetes para lo que no es texto, con el MISMO vocabulario
 * que usa el adaptador de Baileys: el clasificador y el prompt del agente ya
 * saben leer "[nota de voz]" y responder que por acá no se escuchan audios.
 */
function marcadorDeTipo(tipo: string): string {
  const clave = tipo === "contacts" ? "contact" : tipo;
  return `[${NOMBRE_MEDIA[clave] ?? clave}]`;
}

interface RegistroMensaje {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  context?: unknown;
  text?: { body?: string; context?: unknown };
  interactive?: {
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
    context?: unknown;
  };
  button?: { text?: string };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string };
  audio?: { mime_type?: string };
  sticker?: unknown;
  location?: unknown;
  contacts?: unknown;
  system?: { body?: string };
}

/**
 * Convierte un registro `messages[]` del webhook en el evento del sistema.
 *
 * Devuelve null para lo que no se contesta: mensajes del sistema, tipos sin
 * soporte y cualquier cosa sin remitente o sin id — sin id no hay idempotencia,
 * y reemitir un evento duplicado significa contestarle dos veces al prospecto.
 *
 * Exportada y pura por la misma razón que eventoDesdeMensaje: el cableado se
 * testea contra payloads REALES de Meta, no solo las piezas sueltas.
 */
export function eventoDesdeWebhook(
  mensaje: RegistroMensaje,
): InboundEvent | null {
  if (mensaje.type === "system" || mensaje.type === "unsupported") return null;
  const from = mensaje.from;
  const id = mensaje.id;
  if (typeof from !== "string" || !/^\d{8,15}$/.test(from)) return null;
  if (typeof id !== "string" || id.length === 0) return null;

  const tipo = (mensaje.type ?? "desconocido").toLowerCase();
  const texto = textoDeWebhook(mensaje);
  // El contexto de una cita viaja dentro del objeto del tipo (text.context)
  // y también como message.context según la versión. Se mira ambos: un falso
  // negativo acá hace que un saludo automático que cita nuestro mensaje pase
  // por humano, que es exactamente el caso que el clasificador quiere ver.
  const citado =
    mensaje.context !== undefined ||
    mensaje.text?.context !== undefined ||
    mensaje.interactive?.context !== undefined;

  const segundos = Number(mensaje.timestamp ?? 0);
  return {
    e164: `+${from}`,
    body:
      texto.trim() !== ""
        ? texto
        : TIPOS_TEXTO.has(tipo)
          ? ""
          : marcadorDeTipo(tipo),
    at: segundos > 0 ? new Date(segundos * 1_000) : new Date(),
    waMessageId: id,
    tipo,
    tieneMedia: !TIPOS_TEXTO.has(tipo),
    citaOtroMensaje: citado,
  };
}

interface ValorWebhook {
  metadata?: { phone_number_id?: string };
  messages?: RegistroMensaje[];
  statuses?: Array<{
    id?: string;
    status?: string;
    timestamp?: string;
  }>;
}

/** Respuesta de la Graph API a un POST de mensajes exitoso. */
interface RespuestaEnvio {
  messages?: Array<{ id?: string }>;
}

/** Error estructurado que devuelve Graph cuando algo sale mal. */
interface ErrorGraph {
  error?: { message?: string; code?: number; error_subcode?: number };
}

const TAMANIO_MAX_WEBHOOK = 1_000_000;

export class ClienteCloudApi implements WaClient {
  private readonly config: Required<Pick<ConfigCloudApi, "version">> &
    ConfigCloudApi;
  private readonly fetchImpl: typeof fetch;
  private readonly inboundHandlers = new Set<InboundHandler>();
  private readonly ackHandlers = new Set<AckHandler>();
  private readonly fatalHandlers = new Set<FatalHandler>();
  private readonly envioManualHandlers = new Set<EnvioManualHandler>();
  private servidor: Server | null = null;

  constructor(
    config: ConfigCloudApi,
    dependencias: { fetchImpl?: typeof fetch } = {},
  ) {
    this.config = { version: "v23.0", ...config };
    this.fetchImpl = dependencias.fetchImpl ?? fetch.bind(globalThis);
  }

  /**
   * El puerto real del servidor de webhooks, útil cuando se pidió 0 (efímero).
   * Es cómo los tests hablan con el servidor sin pelearse por puertos fijos.
   */
  get direccion(): string | null {
    const address = this.servidor?.address();
    if (address === null || address === undefined || typeof address === "string") {
      return null;
    }
    return `127.0.0.1:${address.port}`;
  }

  private async llamarGraph(
    ruta: string,
    cuerpo: unknown,
  ): Promise<Record<string, unknown>> {
    const respuesta = await this.fetchImpl(
      `https://graph.facebook.com/${this.config.version}/${this.config.phoneNumberId}${ruta}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(cuerpo),
      },
    );

    const crudo = await respuesta.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(crudo) as Record<string, unknown>;
    } catch {
      // Un cuerpo no-JSON de Graph es raro pero posible en errores de proxy.
    }

    if (!respuesta.ok) {
      const detalle = (json as ErrorGraph).error;
      const motivo =
        detalle?.message ??
        (crudo.slice(0, 200) || `HTTP ${respuesta.status}`);
      // Token vencido, revocado o número suspendido: la cuenta entera dejó de
      // poder enviar. Mismo tratamiento que un loggedOut en Baileys: kill
      // switch persistente y un humano mirando antes de seguir.
      if (respuesta.status === 401 || respuesta.status === 403) {
        this.emitFatal(`API oficial rechazó credenciales (${respuesta.status}): ${motivo}`);
      }
      throw new Error(
        `Graph ${respuesta.status} en ${ruta}: ${motivo}` +
          (detalle?.code !== undefined ? ` (código ${detalle.code})` : ""),
      );
    }
    return json;
  }

  async sendText(e164: string, body: string): Promise<string> {
    const digits = e164.replace(/\D/g, "");
    if (!/^\d{8,15}$/.test(digits)) {
      throw new Error(`E.164 inválido: ${e164}`);
    }
    const json = await this.llamarGraph("/messages", {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digits,
      type: "text",
      text: { preview_url: false, body },
    });
    const id = (json as RespuestaEnvio).messages?.[0]?.id;
    if (typeof id !== "string") {
      throw new Error(
        `La API aceptó el envío a ${e164} pero no devolvió un id de mensaje. ` +
          `El mensaje PUEDE haber salido: revisa el chat antes de reintentar.`,
      );
    }
    return id;
  }

  async sendImage(
    e164: string,
    image: Uint8Array,
    caption: string,
  ): Promise<string> {
    const digits = e164.replace(/\D/g, "");
    if (!/^\d{8,15}$/.test(digits)) {
      throw new Error(`E.164 inválido: ${e164}`);
    }
    if (image.byteLength === 0) throw new Error("imagen vacía: no se envía nada");

    // Dos pasos: subir el medio y después mandar el mensaje por su id. La
    // Cloud API no acepta bytes inline como Baileys.
    const mediaId = await this.subirImagen(image);
    const json = await this.llamarGraph("/messages", {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digits,
      type: "image",
      image: { id: mediaId, caption },
    });
    const id = (json as RespuestaEnvio).messages?.[0]?.id;
    if (typeof id !== "string") {
      throw new Error(
        `La API aceptó la imagen a ${e164} pero no devolvió un id de mensaje. ` +
          `La imagen PUEDE haber salido: revisa el chat antes de reintentar.`,
      );
    }
    return id;
  }

  private async subirImagen(image: Uint8Array): Promise<string> {
    const mime = mimeTypeDeImagen(image);
    const formulario = new FormData();
    formulario.append("messaging_product", "whatsapp");
    formulario.append(
      "file",
      new Blob([new Uint8Array(image)], { type: mime }),
      `imagen.${mime === "image/png" ? "png" : "jpg"}`,
    );
    const respuesta = await this.fetchImpl(
      `https://graph.facebook.com/${this.config.version}/${this.config.phoneNumberId}/media`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.token}` },
        body: formulario,
      },
    );
    const json = (await respuesta.json().catch(() => ({}))) as { id?: string };
    if (!respuesta.ok || typeof json.id !== "string") {
      throw new Error(
        `Falló la subida del medio a la API oficial (HTTP ${respuesta.status}).`,
      );
    }
    return json.id;
  }

  /**
   * No existe en la API oficial.
   *
   * Leer el perfil de negocio de OTRO número era una cortesía de WhatsApp Web
   * que la plataforma oficial no expone. Se lanza en vez de fingir un resultado:
   * devolver exists:false diría "este número no tiene WhatsApp" y el preflight
   * descartaría prospectos vivos basándose en una mentira.
   */
  async getBusinessProfile(_e164: string): Promise<ConsultaWhatsApp> {
    throw new Error(
      "getBusinessProfile no existe en la API oficial: corre el preflight " +
        "con CANAL=baileys o revisa el número a mano.",
    );
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
  onEnvioManual(_callback: EnvioManualHandler): void {
    // No aplica: con la API oficial el número vive en Meta, no hay una sesión
    // de teléfono que escriba por su cuenta. El takeover humano llega por el
    // handoff del bot o por un comando manual futuro.
  }

  async start(): Promise<void> {
    if (this.servidor !== null) return;
    const servidor = createServer((req, res) => {
      void this.atender(req, res);
    });
    this.servidor = servidor;
    const puerto = this.config.puerto ?? 3000;
    await new Promise<void>((resolve, reject) => {
      servidor.once("error", reject);
      servidor.listen(puerto, () => resolve());
    });
    console.info(
      `\nCanal API oficial (Cloud API). Número ${this.config.phoneNumberId.slice(0, 4)}… escuchando webhooks en :${puerto}.\n` +
        "RECUERDA: este canal solo contesta dentro de la ventana de 24h.\n" +
        "El primer toque en frío requiere plantillas aprobadas y no está implementado aquí.\n",
    );
  }

  async stop(): Promise<void> {
    const servidor = this.servidor;
    if (servidor === null) return;
    this.servidor = null;
    servidor.closeAllConnections();
    await new Promise<void>((resolve) => servidor.close(() => resolve()));
  }

  private async atender(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    // Handshake de verificación de Meta (una sola vez, al configurar el
    // webhook en la consola). Un GET sin parámetros es un chequeo manual de
    // salud: responde y no intenta autenticar a nadie.
    if (req.method === "GET") {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const modo = url.searchParams.get("hub.mode");
      if (modo === null) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("kurogrid outreach · canal cloud");
        return;
      }
      if (
        modo === "subscribe" &&
        url.searchParams.get("hub.verify_token") === this.config.verifyToken
      ) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(url.searchParams.get("hub.challenge") ?? "");
        return;
      }
      res.writeHead(403);
      res.end("verificación rechazada");
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    const trozos: Buffer[] = [];
    let total = 0;
    for await (const trozo of req) {
      total += (trozo as Buffer).length;
      if (total > TAMANIO_MAX_WEBHOOK) {
        res.writeHead(413);
        res.end();
        return;
      }
      trozos.push(trozo as Buffer);
    }
    const crudo = Buffer.concat(trozos).toString("utf8");

    // La firma va sobre los bytes EXACTOS del request. Parsear antes de
    // verificar rompería la comparación con JSON reformateado.
    const encabezadoFirma = req.headers["x-hub-signature-256"];
    const firma = Array.isArray(encabezadoFirma) ? encabezadoFirma[0] : encabezadoFirma;
    if (!verificarFirma(this.config.appSecret, crudo, firma)) {
      res.writeHead(401);
      res.end("firma inválida");
      return;
    }

    let payload: { entry?: Array<{ changes?: Array<{ field?: string; value?: ValorWebhook }> }> };
    try {
      payload = JSON.parse(crudo);
    } catch {
      res.writeHead(400);
      res.end("json inválido");
      return;
    }

    this.despachar(payload);
    // 200 siempre que la firma sea válida: si algo falla procesando, Meta
    // reintentaría el mismo evento y la idempotencia del store ya lo maneja.
    // Responder error solo compraría reintentos ruidosos.
    res.writeHead(200);
    res.end("ok");
  }

  private despachar(payload: {
    entry?: Array<{ changes?: Array<{ field?: string; value?: ValorWebhook }> }>;
  }): void {
    for (const entrada of payload.entry ?? []) {
      for (const cambio of entrada.changes ?? []) {
        if (cambio.field !== "messages") continue;
        const value = cambio.value;
        // Si algún día este webhook recibe tráfico de otro número, ignorarlo
        // entero: mezclar chats de dos números corrompe la conversación.
        if (value?.metadata?.phone_number_id !== this.config.phoneNumberId) continue;

        for (const mensaje of value.messages ?? []) {
          const evento = eventoDesdeWebhook(mensaje);
          if (evento === null) continue;
          for (const handler of this.inboundHandlers) handler(evento);
        }
        for (const estado of value.statuses ?? []) {
          const ack = estado.status !== undefined ? ACK_DESDE_ESTADO[estado.status] : undefined;
          if (typeof estado.id !== "string" || ack === undefined) continue;
          const segundos = Number(estado.timestamp ?? 0);
          const at = segundos > 0 ? new Date(segundos * 1_000) : new Date();
          for (const handler of this.ackHandlers) handler(estado.id, ack, at);
        }
      }
    }
  }

  private emitFatal(reason: string): void {
    for (const handler of this.fatalHandlers) handler(reason);
  }
}

/** JPEG y PNG, los dos formatos que produce el pipeline de visuales. */
export function mimeTypeDeImagen(image: Uint8Array): string {
  if (image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
    return "image/jpeg";
  }
  if (image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47) {
    return "image/png";
  }
  throw new Error(
    "formato de imagen no reconocido: se espera JPEG o PNG (el pipeline de visuales produce JPEG)",
  );
}
