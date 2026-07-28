import { CLASIFICACIONES_MARGEN, DISTRITOS_LIMA_ALTO } from "../harvest/renipress.js";
import type {
  EnrichedProspect,
  ScoredProspect,
  ScoreSignal,
} from "../types.js";

function normalizeComparable(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleUpperCase("es-PE");
}

function classificationSignal(classification: string): ScoreSignal | null {
  const normalized = normalizeComparable(classification);
  const rules: Array<{
    match: (typeof CLASIFICACIONES_MARGEN)[number];
    points: number;
  }> = [
    { match: "ODONTOLOG", points: 20 },
    { match: "DIAGNOSTICO POR IMAGENES", points: 15 },
    { match: "PATOLOGIA", points: 15 },
    { match: "POLICLINICO", points: 15 },
    { match: "CENTROS DE SALUD O CENTROS MEDICOS", points: 10 },
    { match: "CONSULTORIOS MEDICOS", points: 8 },
  ];
  const rule = rules.find(({ match }) => normalized.includes(match));

  return rule
    ? {
        name: "clasificacion_margen",
        points: rule.points,
        detail: `Clasificación de margen alto: ${classification}`,
      }
    : null;
}

function reviewCountSignal(count: number | null): ScoreSignal {
  let points = 0;
  if (count !== null && count >= 50) points = 20;
  else if (count !== null && count >= 20) points = 14;
  else if (count !== null && count >= 5) points = 8;
  else if (count !== null && count >= 1) points = 3;

  return {
    name: "cantidad_resenas",
    points,
    detail:
      count === null
        ? "Places no reporta cantidad de reseñas"
        : `${count} reseña${count === 1 ? "" : "s"} en Places`,
  };
}

export function scoreProspect(p: EnrichedProspect): ScoredProspect {
  const blockers: string[] = [];
  const signals: ScoreSignal[] = [];

  if (!p.phones.some((phone) => phone.kind === "mobile")) {
    blockers.push("no tiene teléfono móvil para WhatsApp");
  }
  if (p.web.matchConfidence < 0.6) {
    blockers.push("match de Places poco confiable, revisar a mano");
  }
  if (p.web.websiteUri !== null) {
    blockers.push("ya tiene web");
  }

  if (p.web.websiteUri === null && p.web.matchConfidence >= 0.6) {
    // Que Places no traiga websiteUri es un dato AUSENTE, no una prueba de que
    // el negocio no tenga sitio: el match puede ser bueno y el campo estar
    // simplemente vacío. Por eso vale menos que un verificado.
    //
    // Antes esto era un bloqueo duro, y costaba el 90% del pipeline: de 50
    // prospectos enriquecidos, 2 quedaban contactables. El bloqueo existía para
    // evitar escribirle "vi que no tienes web" a alguien que sí la tiene — pero
    // esa afirmación ya no la hace nadie. El compositor recibe `tieneWeb: null`
    // y con eso compose.ts le ordena explícitamente no afirmarlo y preguntar.
    //
    // O sea: la garantía se mudó del filtro al prompt, donde puede distinguir
    // "no tiene" de "no sé" en vez de tratar los dos como inservibles. Si algún
    // día el mensaje vuelve a afirmar la ausencia de web, esto tiene que volver
    // a ser un bloqueo.
    const verificado = p.web.verificadoSinWeb === true;
    signals.push({
      name: "sin_web",
      points: verificado ? 40 : 22,
      detail: verificado
        ? "verificado: no tiene web"
        : "Places no reporta web (sin verificar)",
    });
  }

  const marginSignal = classificationSignal(p.classification);
  if (marginSignal) signals.push(marginSignal);

  signals.push(reviewCountSignal(p.web.userRatingCount));

  if (
    p.web.rating !== null &&
    p.web.rating >= 4 &&
    p.web.userRatingCount !== null &&
    p.web.userRatingCount >= 5
  ) {
    signals.push({
      name: "buena_calificacion",
      points: 8,
      detail: `Rating ${p.web.rating} con ${p.web.userRatingCount} reseñas`,
    });
  }

  const district = normalizeComparable(p.district);
  if (
    [...DISTRITOS_LIMA_ALTO].some(
      (candidate) => normalizeComparable(candidate) === district,
    )
  ) {
    signals.push({
      name: "distrito_lima_alto",
      points: 12,
      detail: `Distrito priorizado: ${p.district}`,
    });
  }

  const score = Math.max(
    0,
    Math.min(
      100,
      signals.reduce((total, signal) => total + signal.points, 0),
    ),
  );

  return {
    ...p,
    score,
    signals,
    eligible: blockers.length === 0,
    blockers,
  };
}
