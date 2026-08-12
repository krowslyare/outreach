import { readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import type { PasoCampana } from "./compose.js";
import { normalizarNombre } from "./normalizar.js";

export type PasoVisual = Extract<PasoCampana, "first" | "fu1">;

export interface VisualAprobado {
  e164: string;
  paso: PasoVisual;
  nombre?: string;
  ruta: string;
  imagen: Uint8Array;
  ancho: number;
  alto: number;
}

interface EntradaManifest {
  e164?: unknown;
  paso?: unknown;
  nombre?: unknown;
  imagen?: unknown;
}

interface ManifestVisuales {
  version?: unknown;
  visuales?: unknown;
}

const FIRMA_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_BYTES = 15 * 1024 * 1024;

function dimensionesPng(buffer: Buffer, ruta: string): { ancho: number; alto: number } {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(FIRMA_PNG)) {
    throw new Error(`${ruta}: no es un PNG válido`);
  }
  const ancho = buffer.readUInt32BE(16);
  const alto = buffer.readUInt32BE(20);
  if (ancho === 0 || alto === 0) {
    throw new Error(`${ruta}: dimensiones PNG inválidas (${ancho}x${alto})`);
  }
  return { ancho, alto };
}

function validarEntrada(
  raw: EntradaManifest,
  indice: number,
  directorio: string,
): VisualAprobado {
  if (typeof raw.e164 !== "string" || !/^\+51\d{9}$/.test(raw.e164)) {
    throw new Error(`visuales[${indice}].e164 requiere un móvil peruano en E.164`);
  }
  if (raw.paso !== "first" && raw.paso !== "fu1") {
    throw new Error(`visuales[${indice}].paso requiere "first" o "fu1"`);
  }
  if (
    raw.nombre !== undefined &&
    (typeof raw.nombre !== "string" ||
      raw.nombre.trim().length < 2 ||
      raw.nombre.trim().length > 80 ||
      /[\r\n]/.test(raw.nombre))
  ) {
    throw new Error(`visuales[${indice}].nombre debe tener entre 2 y 80 caracteres`);
  }
  if (typeof raw.imagen !== "string" || raw.imagen.trim() === "") {
    throw new Error(`visuales[${indice}].imagen requiere una ruta PNG`);
  }

  const ruta = resolve(directorio, raw.imagen);
  if (extname(ruta).toLocaleLowerCase("es-PE") !== ".png") {
    throw new Error(`${ruta}: solo se admiten PNG revisados`);
  }
  const stat = statSync(ruta);
  if (!stat.isFile()) throw new Error(`${ruta}: no es un archivo`);
  if (stat.size === 0 || stat.size > MAX_BYTES) {
    throw new Error(`${ruta}: tamaño fuera del rango permitido (1-${MAX_BYTES} bytes)`);
  }

  // Se carga antes de reclamar el envío. Así un archivo borrado o corrupto
  // falla sin consumir la llave de idempotencia de WhatsApp.
  const imagen = readFileSync(ruta);
  const { ancho, alto } = dimensionesPng(imagen, ruta);
  if (ancho * 9 !== alto * 16) {
    throw new Error(`${ruta}: debe ser 16:9 exacto y mide ${ancho}x${alto}`);
  }

  return {
    e164: raw.e164,
    paso: raw.paso,
    nombre: typeof raw.nombre === "string" ? raw.nombre.trim() : undefined,
    ruta,
    imagen,
    ancho,
    alto,
  };
}

export function cargarVisualesAprobados(
  rutaManifest: string,
): ReadonlyMap<string, VisualAprobado> {
  const absoluta = resolve(rutaManifest);
  const parsed = JSON.parse(readFileSync(absoluta, "utf8")) as ManifestVisuales;
  if (parsed.version !== 1) {
    throw new Error(`${absoluta}: version debe ser 1`);
  }
  if (!Array.isArray(parsed.visuales) || parsed.visuales.length === 0) {
    throw new Error(`${absoluta}: visuales debe ser una lista no vacía`);
  }

  const resultado = new Map<string, VisualAprobado>();
  for (const [indice, raw] of parsed.visuales.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`visuales[${indice}] debe ser un objeto`);
    }
    const visual = validarEntrada(raw as EntradaManifest, indice, dirname(absoluta));
    if (resultado.has(visual.e164)) {
      throw new Error(`${absoluta}: e164 duplicado ${visual.e164}`);
    }
    resultado.set(visual.e164, visual);
  }
  return resultado;
}

export function captionVisual(
  nombreRaw: string,
  paso: PasoVisual,
  nombreAprobado = false,
): string {
  const nombre = nombreAprobado ? nombreRaw.trim() : normalizarNombre(nombreRaw);
  const texto =
    paso === "first"
      ? `Hola, estuve revisando la presencia de ${nombre} y desde Kurogrid preparamos esta propuesta visual inicial de cómo podría verse su web.\n\nEs solo una primera idea; trabajando el diseño junto con ustedes, el resultado final sería incluso mejor. ¿Les gustaría explorar algo así para ${nombre}?`
      : `Hola, hace unos días les escribí desde Kurogrid. Para aterrizar mejor la idea, preparé esta propuesta visual inicial de cómo podría verse la web de ${nombre}.\n\nEs solo una primera idea; trabajando el diseño junto con ustedes, el resultado final sería incluso mejor. ¿Les gustaría explorar algo así para ${nombre}?`;

  if (texto.length > 700) {
    throw new Error(`caption visual demasiado largo para ${nombre} (${texto.length})`);
  }
  return texto;
}
