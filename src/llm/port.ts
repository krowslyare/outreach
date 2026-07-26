// Puerto neutral hacia cualquier proveedor de LLM.
//
// El puerto anterior (ClienteClaude) filtraba la forma de la API de Anthropic:
// recibía sus params crudos y devolvía sus bloques. Eso obligaba a cualquier
// adaptador a hablar el dialecto de Anthropic, que es justo lo contrario de
// ser agnóstico. Acá el contrato es propio y cada adaptador traduce.
//
// Deliberadamente angosto: pedimos texto o una herramienta, nada más. No hay
// loop agéntico, ni streaming, ni multimodal. Un puerto que solo expone lo que
// realmente usamos es un puerto que se puede implementar sobre un CLI, sobre
// una API con function calling, o sobre lo que venga.

export type Efuerzo = "low" | "medium" | "high" | "xhigh" | "max";

export interface HerramientaLLM {
  nombre: string;
  descripcion: string;
  /** JSON Schema del input. Debe traer `required` y `additionalProperties: false`. */
  esquema: Record<string, unknown>;
}

export interface SolicitudLLM {
  /** Estable entre llamadas: los adaptadores que cacheen prefijo lo aprovechan. */
  sistema: string;
  mensajes: ReadonlyArray<{ rol: "user" | "assistant"; texto: string }>;
  /** Vacío o ausente = solo se espera texto. */
  herramientas?: readonly HerramientaLLM[];
  maxTokens: number;
  esfuerzo?: Efuerzo;
}

/**
 * Por qué terminó la generación. Se normaliza a propósito: cada proveedor le
 * pone otro nombre, y quien consume esto solo necesita saber si el resultado
 * es utilizable.
 */
export type CorteLLM =
  /** Terminó bien. El texto (o la herramienta) es utilizable. */
  | "fin"
  /** Se quedó sin presupuesto de salida. El texto está cortado: NO usarlo. */
  | "truncado"
  /** El proveedor se negó a generar. */
  | "rechazo"
  /** Falló la llamada. `motivo` explica. */
  | "error";

export interface RespuestaLLM {
  corte: CorteLLM;
  texto: string;
  /** La herramienta elegida, si el modelo eligió una. */
  herramienta: { nombre: string; input: Record<string, unknown> } | null;
  /** Detalle cuando corte es "rechazo" o "error". */
  motivo?: string;
}

/**
 * Un proveedor. `nombre` es solo para logs y para que el operador sepa contra
 * qué está corriendo.
 */
export interface ProveedorLLM {
  readonly nombre: string;
  generar(solicitud: SolicitudLLM): Promise<RespuestaLLM>;
}
