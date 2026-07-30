import { normalizePhone } from "../harvest/renipress.js";
import type { ManualProspectInput } from "../wa/store.js";
import { VERTICALES, type VerticalId } from "./verticals.js";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.googleMapsUri",
].join(",");

export type DiscoveryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface PlacesDiscoveryCandidate {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  googleMapsUri?: string;
}

interface PlacesDiscoveryResponse {
  places?: PlacesDiscoveryCandidate[];
}

export interface DiscoveredProspect {
  placeId: string;
  name: string;
  district: string;
  address: string;
  e164: string;
  rating: number | null;
  reviewCount: number | null;
  googleMapsUri: string | null;
  query: string;
  score: number;
}

export interface DiscoverPlacesInput {
  apiKey: string;
  query: string;
  district: string;
  pageSize?: number;
}

const MARCAS_NO_COMERCIALES = [
  "municipal",
  "municipalidad",
  "ministerio",
  "gobierno regional",
  "essalud",
] as const;

function normalizarComparable(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("es-PE")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function responseError(status: number, body: string): Error {
  let detail = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof (parsed as { error: { message?: unknown } }).error?.message ===
        "string"
    ) {
      detail = (parsed as { error: { message: string } }).error.message;
    }
  } catch {
    // El texto crudo sigue siendo mejor que perder el motivo.
  }
  return new Error(`Places HTTP ${status}: ${detail.slice(0, 300)}`);
}

export function scoreDiscovered(
  rating: number | null,
  reviewCount: number | null,
  priority: 1 | 2 | 3,
): number {
  let score = priority === 1 ? 45 : priority === 2 ? 35 : 25;
  if (reviewCount !== null && reviewCount >= 100) score += 30;
  else if (reviewCount !== null && reviewCount >= 30) score += 22;
  else if (reviewCount !== null && reviewCount >= 10) score += 14;
  else if (reviewCount !== null && reviewCount >= 5) score += 7;
  if (rating !== null && rating >= 4.5 && (reviewCount ?? 0) >= 10) score += 15;
  else if (rating !== null && rating >= 4 && (reviewCount ?? 0) >= 5) score += 8;
  return Math.min(100, score);
}

/**
 * Descubrimiento por categoría, no matching contra un registro.
 *
 * Solo devuelve negocios operativos, con móvil y sin websiteUri reportado.
 * Esto sigue siendo una shortlist PENDIENTE: ausencia del campo en Places no
 * prueba ausencia de web, por eso nunca marca verifiedWithoutWebsite.
 */
export async function discoverPlaces(
  input: DiscoverPlacesInput,
  fetcher: DiscoveryFetch = globalThis.fetch,
): Promise<PlacesDiscoveryCandidate[]> {
  const pageSize = input.pageSize ?? 20;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 20) {
    throw new RangeError("pageSize debe estar entre 1 y 20");
  }
  const response = await fetcher(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": input.apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: `${input.query} en ${input.district}, Lima, Perú`,
      languageCode: "es",
      regionCode: "PE",
      pageSize,
    }),
  });
  if (!response.ok) throw responseError(response.status, await response.text());
  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    ("places" in payload && !Array.isArray(payload.places))
  ) {
    throw new Error("Places devolvió una respuesta inesperada");
  }
  return (payload as PlacesDiscoveryResponse).places ?? [];
}

export function shortlistFromPlaces(
  candidates: readonly PlacesDiscoveryCandidate[],
  vertical: VerticalId,
  district: string,
  query: string,
): DiscoveredProspect[] {
  const result = new Map<string, DiscoveredProspect>();
  for (const candidate of candidates) {
    if (
      candidate.businessStatus !== undefined &&
      candidate.businessStatus !== "OPERATIONAL"
    ) {
      continue;
    }
    if (typeof candidate.websiteUri === "string" && candidate.websiteUri.trim()) {
      continue;
    }
    const mobile = normalizePhone(candidate.nationalPhoneNumber ?? "").find(
      (phone) => phone.kind === "mobile" && phone.e164 !== null,
    );
    const name = candidate.displayName?.text?.trim();
    if (!name || mobile?.e164 === null || mobile?.e164 === undefined) continue;
    const comparableName = normalizarComparable(name);
    if (
      MARCAS_NO_COMERCIALES.some((marker) => comparableName.includes(marker))
    ) {
      continue;
    }
    const address = candidate.formattedAddress?.trim() ?? "";
    // Una query con "Miraflores" puede devolver La Molina. Para prospección
    // por cohortes preferimos perder un negocio con dirección incompleta antes
    // que etiquetar y medir el distrito equivocado.
    if (
      address === "" ||
      !normalizarComparable(address).includes(normalizarComparable(district))
    ) {
      continue;
    }

    const rating =
      typeof candidate.rating === "number" && Number.isFinite(candidate.rating)
        ? candidate.rating
        : null;
    const reviewCount =
      typeof candidate.userRatingCount === "number" &&
      Number.isFinite(candidate.userRatingCount)
        ? candidate.userRatingCount
        : null;
    const item: DiscoveredProspect = {
      placeId: candidate.id ?? `phone:${mobile.e164}`,
      name,
      district: district.toLocaleUpperCase("es-PE"),
      address,
      e164: mobile.e164,
      rating,
      reviewCount,
      googleMapsUri: candidate.googleMapsUri?.trim() || null,
      query,
      score: scoreDiscovered(rating, reviewCount, VERTICALES[vertical].priority),
    };
    const previous = result.get(item.e164);
    if (previous === undefined || item.score > previous.score) {
      result.set(item.e164, item);
    }
  }
  return [...result.values()].sort(
    (left, right) =>
      right.score - left.score || left.name.localeCompare(right.name),
  );
}

export function asManualInput(
  prospect: DiscoveredProspect,
  vertical: VerticalId,
): ManualProspectInput {
  return {
    e164: prospect.e164,
    name: prospect.name,
    district: prospect.district,
    classification: VERTICALES[vertical].label.toLocaleUpperCase("es-PE"),
    vertical,
    origin: "places",
    sourceUrl: prospect.googleMapsUri ?? undefined,
    notes:
      `Places ${prospect.placeId}; consulta "${prospect.query}"; ` +
      `${prospect.rating ?? "sin rating"}/5; ${prospect.reviewCount ?? 0} reseñas`,
    score: prospect.score,
    // El campo vacío de Places es solo una señal para revisar, no prueba.
    verifiedWithoutWebsite: false,
    approve: false,
  };
}
