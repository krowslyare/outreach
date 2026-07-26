import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  EnrichedProspect,
  RawProspect,
  WebPresence,
} from "../types.js";

const PLACES_ENDPOINT =
  "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.location",
  "places.formattedAddress",
].join(",");
const DEFAULT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_RETRY_BACKOFF_MS = 500;

const NAME_STOP_WORDS = new Set([
  "consultorio",
  "consultorios",
  "centro",
  "centros",
  "clinica",
  "clinicas",
  "dental",
  "dentales",
  "medico",
  "medicos",
  "medica",
  "medicas",
  "odontologico",
  "odontologicos",
  "odontologica",
  "odontologicas",
  "ipress",
  "de",
  "del",
  "la",
  "las",
  "el",
  "los",
  "y",
  "sac",
  "eirl",
  "srl",
]);

export interface PlaceCandidate {
  id?: string;
  displayName?: { text?: string; languageCode?: string } | string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  location?: {
    latitude?: number;
    longitude?: number;
  };
  formattedAddress?: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PlacesCache {
  get(sourceId: string): Promise<WebPresence | null>;
  set(sourceId: string, value: WebPresence): Promise<void>;
}

export interface EnrichProspectDeps {
  apiKey: string;
  fetch: FetchLike;
  cache: PlacesCache;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  cacheMaxAgeMs?: number;
  retryBackoffMs?: number;
}

export interface EnrichAllOptions {
  delayMs?: number;
}

interface PlacesSearchResponse {
  places?: PlaceCandidate[];
}

/**
 * Confianza a partir de la cual se acepta que "Places no trae web" equivale a
 * "no tiene web". Solo el camino de coordenadas la alcanza: Place a menos de
 * 100 m del domicilio declarado más solape de nombre.
 */
export const CONFIANZA_VERIFICA_SIN_WEB = 0.95;

interface SearchResult {
  candidates: PlaceCandidate[] | null;
  cacheable: boolean;
  /** Motivo del fallo. Ausente cuando la consulta corrió bien. */
  error?: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function displayName(candidate: PlaceCandidate): string {
  if (typeof candidate.displayName === "string") return candidate.displayName;
  return candidate.displayName?.text ?? "";
}

function normalizedTokens(value: string): Set<string> {
  const normalized = value
    .toLocaleLowerCase("es-PE")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ");

  return new Set(
    normalized
      .split(/\s+/)
      .filter((token) => token.length > 0 && !NAME_STOP_WORDS.has(token)),
  );
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = normalizedTokens(left);
  const rightTokens = normalizedTokens(right);
  const denominator = Math.min(leftTokens.size, rightTokens.size);
  if (denominator === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }

  // El coeficiente de overlap tolera que la razón registrada tenga sufijos
  // legales que Places omite, sin premiar palabras genéricas ya filtradas.
  return intersection / denominator;
}

function haversineMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(latitudeA)) *
      Math.cos(toRadians(latitudeB)) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    2 *
    earthRadiusMeters *
    Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)))
  );
}

export function matchConfidence(
  prospect: RawProspect,
  candidate: PlaceCandidate,
): number {
  const overlap = tokenOverlap(prospect.name, displayName(candidate));
  const candidateLatitude = candidate.location?.latitude;
  const candidateLongitude = candidate.location?.longitude;

  if (
    prospect.lat !== null &&
    prospect.lng !== null &&
    typeof candidateLatitude === "number" &&
    Number.isFinite(candidateLatitude) &&
    typeof candidateLongitude === "number" &&
    Number.isFinite(candidateLongitude)
  ) {
    const distance = haversineMeters(
      prospect.lat,
      prospect.lng,
      candidateLatitude,
      candidateLongitude,
    );

    if (distance < 100 && overlap > 0.5) return 0.95;
    if (distance < 300 && overlap > 0.3) return 0.8;
    return 0.2;
  }

  if (prospect.lat === null || prospect.lng === null) {
    if (overlap > 0.7) return 0.7;
    if (overlap > 0.4) return 0.5;
  }

  return 0.2;
}

function emptyWebPresence(checkedAt: string): WebPresence {
  return {
    checkedAt,
    placeId: null,
    websiteUri: null,
    rating: null,
    userRatingCount: null,
    matchConfidence: 0,
  };
}

function cacheIsFresh(
  value: WebPresence,
  now: Date,
  maxAgeMs: number,
): boolean {
  const checkedAt = Date.parse(value.checkedAt);
  const age = now.getTime() - checkedAt;
  return Number.isFinite(checkedAt) && age >= 0 && age <= maxAgeMs;
}

function isPlacesSearchResponse(value: unknown): value is PlacesSearchResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (!("places" in value) || Array.isArray(value.places))
  );
}

async function searchPlaces(
  prospect: RawProspect,
  deps: EnrichProspectDeps,
): Promise<SearchResult> {
  const sleep = deps.sleep ?? delay;
  const retryBackoffMs =
    deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const body: Record<string, unknown> = {
    textQuery: `${prospect.name} ${prospect.district} Lima Perú`,
    languageCode: "es",
    regionCode: "PE",
    maxResultCount: 5,
  };

  if (prospect.lat !== null && prospect.lng !== null) {
    body.locationBias = {
      circle: {
        center: {
          latitude: prospect.lat,
          longitude: prospect.lng,
        },
        radius: 300,
      },
    };
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Response;

    try {
      response = await deps.fetch(PLACES_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": deps.apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // Un error de transporte no debe perder el resto del lote. Tampoco se
      // cachea: una siguiente corrida merece intentar de nuevo.
      return {
        candidates: null,
        cacheable: false,
        error: `red: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable) {
      if (attempt < 3) {
        await sleep(retryBackoffMs * 2 ** (attempt - 1));
        continue;
      }
      return {
        candidates: null,
        cacheable: false,
        error: `HTTP ${response.status} tras 3 intentos`,
      };
    }

    if (response.status < 200 || response.status >= 300) {
      // El cuerpo de Google explica la causa exacta (API deshabilitada, key
      // restringida, facturación sin activar). Perderlo obliga a adivinar.
      let detalle = "";
      try {
        const texto = await response.text();
        const parsed: unknown = JSON.parse(texto);
        const mensaje =
          typeof parsed === "object" &&
          parsed !== null &&
          "error" in parsed &&
          typeof (parsed as { error: unknown }).error === "object" &&
          (parsed as { error: { message?: unknown } }).error !== null &&
          typeof (parsed as { error: { message?: unknown } }).error.message === "string"
            ? (parsed as { error: { message: string } }).error.message
            : texto;
        detalle = `: ${mensaje.slice(0, 300)}`;
      } catch {
        // Sin cuerpo legible alcanza con el status.
      }
      return {
        candidates: null,
        cacheable: false,
        error: `HTTP ${response.status}${detalle}`,
      };
    }

    try {
      const payload: unknown = await response.json();
      if (!isPlacesSearchResponse(payload)) {
        return {
          candidates: null,
          cacheable: false,
          error: "respuesta con forma inesperada",
        };
      }
      return { candidates: payload.places ?? [], cacheable: true };
    } catch (error) {
      return {
        candidates: null,
        cacheable: false,
        error: `JSON inválido: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return { candidates: null, cacheable: false, error: "sin intentos restantes" };
}

export async function enrichProspect(
  prospect: RawProspect,
  deps: EnrichProspectDeps,
): Promise<EnrichedProspect> {
  const now = deps.now?.() ?? new Date();
  const cached = await deps.cache.get(prospect.sourceId);
  const cacheMaxAgeMs =
    deps.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS;

  if (cached && cacheIsFresh(cached, now, cacheMaxAgeMs)) {
    return { ...prospect, web: cached };
  }

  const checkedAt = now.toISOString();
  const search = await searchPlaces(prospect, deps);
  if (search.candidates === null) {
    // El motivo viaja en el WebPresence para que la salida pueda distinguir
    // "falló la consulta" de "consulté y no encontré". No se cachea: un error
    // de configuración se arregla y la próxima corrida debe reintentar.
    return {
      ...prospect,
      web: { ...emptyWebPresence(checkedAt), error: search.error ?? "fallo sin detalle" },
    };
  }

  if (search.candidates.length === 0) {
    const web = emptyWebPresence(checkedAt);
    await deps.cache.set(prospect.sourceId, web);
    return { ...prospect, web };
  }

  const puntuados = search.candidates.map((candidate) => ({
    candidate,
    confidence: matchConfidence(prospect, candidate),
  }));

  let best = puntuados[0]!.candidate;
  let confidence = puntuados[0]!.confidence;
  for (const { candidate, confidence: candidateConfidence } of puntuados.slice(1)) {
    if (candidateConfidence > confidence) {
      best = candidate;
      confidence = candidateConfidence;
    }
  }

  const websiteUri =
    typeof best.websiteUri === "string" ? best.websiteUri : null;

  // La selección conserva el primero ante empate, así que un candidato
  // igual de confiable puede quedar fuera. Si ALGUNO de los empatados en la
  // cima sí tiene web, la evidencia se contradice: no sabemos cuál de los dos
  // es el negocio. Ahí no se verifica nada y va a revisión manual.
  //
  // Importa porque verificadoSinWeb es justo el flag que salta al humano: un
  // falso positivo acá significa escribirle "vi que no tienes web" a alguien
  // que sí la tiene, que es el error que este flag existe para evitar.
  const empateConWeb = puntuados.some(
    (p) =>
      p.confidence === confidence &&
      p.candidate !== best &&
      typeof p.candidate.websiteUri === "string",
  );

  const web: WebPresence = {
    checkedAt,
    placeId: typeof best.id === "string" ? best.id : null,
    websiteUri,
    rating:
      typeof best.rating === "number" && Number.isFinite(best.rating)
        ? best.rating
        : null,
    userRatingCount:
      typeof best.userRatingCount === "number" &&
      Number.isFinite(best.userRatingCount)
        ? best.userRatingCount
        : null,
    matchConfidence: confidence,
    // Un match de este nivel solo se alcanza por el camino de coordenadas:
    // el Place está a menos de 100 m del domicilio declarado en RENIPRESS Y
    // el nombre solapa. A esa altura, que Places no traiga websiteUri se
    // acepta como evidencia suficiente de que no hay sitio.
    //
    // No es una prueba —Places puede simplemente no tenerlo cargado— y por eso
    // NO se aplica a los tramos de 0.80 ni 0.70, donde el match se sostiene
    // solo en el nombre o en una distancia mayor. Es una decisión de negocio
    // tomada con datos: en la calibración, el tramo 0.95 fue el único donde el
    // match era inequívoco.
    verificadoSinWeb:
      confidence >= CONFIANZA_VERIFICA_SIN_WEB &&
      websiteUri === null &&
      !empateConWeb,
  };

  if (search.cacheable) {
    await deps.cache.set(prospect.sourceId, web);
  }
  return { ...prospect, web };
}

export async function enrichAll(
  prospects: RawProspect[],
  deps: EnrichProspectDeps,
  opts: EnrichAllOptions = {},
): Promise<EnrichedProspect[]> {
  const results: EnrichedProspect[] = [];
  const delayMs = opts.delayMs ?? 200;
  const sleep = deps.sleep ?? delay;

  // La API se consume en serie para que el límite sea predecible y una corrida
  // accidental no produzca una ráfaga facturable.
  for (const [index, prospect] of prospects.entries()) {
    results.push(await enrichProspect(prospect, deps));
    if (delayMs > 0 && index < prospects.length - 1) {
      await sleep(delayMs);
    }
  }

  return results;
}

function isWebPresence(value: unknown): value is WebPresence {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WebPresence>;
  return (
    typeof candidate.checkedAt === "string" &&
    (typeof candidate.placeId === "string" || candidate.placeId === null) &&
    (typeof candidate.websiteUri === "string" ||
      candidate.websiteUri === null) &&
    (typeof candidate.rating === "number" || candidate.rating === null) &&
    (typeof candidate.userRatingCount === "number" ||
      candidate.userRatingCount === null) &&
    typeof candidate.matchConfidence === "number"
  );
}

export class DiskPlacesCache implements PlacesCache {
  constructor(private readonly directory = ".places-cache") {}

  private filePath(sourceId: string): string {
    // COD_IPRESS es numérico hoy, pero codificar la llave evita que una fuente
    // futura pueda escapar del directorio mediante "/" o "..".
    const safeKey =
      encodeURIComponent(sourceId).replaceAll(".", "%2E") || "%00";
    return path.join(this.directory, `${safeKey}.json`);
  }

  async get(sourceId: string): Promise<WebPresence | null> {
    try {
      const contents = await readFile(this.filePath(sourceId), "utf8");
      const parsed: unknown = JSON.parse(contents);
      return isWebPresence(parsed) ? parsed : null;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
      if (code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async set(sourceId: string, value: WebPresence): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.filePath(sourceId);
    const temporary = `${target}.${randomUUID()}.tmp`;

    // Escribir y renombrar evita dejar un JSON truncado si el proceso muere
    // justo mientras actualiza el caché que protege la cuota.
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }
}
