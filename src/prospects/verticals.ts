export const VERTICAL_IDS = [
  "dental",
  "veterinary",
  "aesthetics",
  "health",
  "education",
  "legal",
  "hospitality",
] as const;

export type VerticalId = (typeof VERTICAL_IDS)[number];

export interface VerticalConfig {
  id: VerticalId;
  label: string;
  priority: 1 | 2 | 3;
  /** Frases para descubrimiento futuro con Places o revisión manual. */
  placeQueries: readonly string[];
  /** Señales comerciales que justifican subirlo a shortlist A. */
  strongSignals: readonly string[];
  /** Qué parte de Kurogrid tiene más sentido para este rubro. */
  productHooks: readonly string[];
  /** Fuente estructurada preferida; ads/Places siguen sirviendo como capa común. */
  registry: "renipress" | "identicole" | "mincetur" | "none";
}

export const VERTICALES: Readonly<Record<VerticalId, VerticalConfig>> = {
  dental: {
    id: "dental",
    label: "Clínicas y consultorios dentales",
    priority: 1,
    placeQueries: ["clínica dental", "centro odontológico", "dentista"],
    strongSignals: [
      "anuncio activo que lleva solo a Instagram o WhatsApp",
      "ortodoncia, alineadores, implantes o estética dental de ticket alto",
      "casos, especialistas, agenda y actividad reciente visibles en redes",
      "veinte o más reseñas con buena calificación, o inversión publicitaria actual",
      "varios tratamientos, especialistas, sedes u horario amplio",
    ],
    productHooks: [
      "consultas de pacientes desde la web",
      "Libro de Reclamaciones",
      "reservas, promociones y cambios administrados",
    ],
    registry: "renipress",
  },
  veterinary: {
    id: "veterinary",
    label: "Clínicas veterinarias",
    priority: 1,
    placeQueries: ["clínica veterinaria", "veterinaria", "hospital veterinario"],
    strongSignals: [
      "anuncios activos de campañas, vacunas o servicios",
      "alto volumen de reseñas y atención extendida",
      "varias especialidades, sedes o delivery",
    ],
    productHooks: [
      "consultas y reservas",
      "promociones y campañas",
      "catálogo de servicios o productos",
    ],
    registry: "none",
  },
  aesthetics: {
    id: "aesthetics",
    label: "Centros de estética y dermatología",
    priority: 1,
    placeQueries: [
      "centro de estética",
      "clínica estética",
      "centro dermatológico",
    ],
    strongSignals: [
      "anuncios activos con llamada a WhatsApp",
      "Instagram activo pero sin sitio propio",
      "varios tratamientos o especialistas",
    ],
    productHooks: [
      "captura de consultas",
      "promociones",
      "reservas y medición de campañas",
    ],
    registry: "renipress",
  },
  health: {
    id: "health",
    label: "Centros médicos y policlínicos",
    priority: 2,
    placeQueries: ["centro médico", "policlínico", "consultorio médico"],
    strongSignals: [
      "servicios de ticket alto",
      "cinco o más reseñas y operación activa",
      "varias especialidades o sedes",
    ],
    productHooks: [
      "consultas desde la web",
      "Libro de Reclamaciones",
      "equipo y seguimiento del servicio",
    ],
    registry: "renipress",
  },
  education: {
    id: "education",
    label: "Colegios privados, nidos y academias",
    priority: 2,
    placeQueries: ["colegio privado", "nido privado", "academia preuniversitaria"],
    strongSignals: [
      "campaña activa de matrículas",
      "pensiones y oferta educativa verificables",
      "varias sedes o niveles",
    ],
    productHooks: [
      "solicitudes de admisión",
      "campañas y contenido administrado",
      "Libro de Reclamaciones",
    ],
    registry: "identicole",
  },
  legal: {
    id: "legal",
    label: "Estudios jurídicos y contables",
    priority: 3,
    placeQueries: ["estudio de abogados", "estudio contable"],
    strongSignals: [
      "anuncios activos por un servicio específico",
      "equipo visible y especialidades claras",
      "reseñas verificables sin sitio propio",
    ],
    productHooks: [
      "captura de consultas calificadas",
      "presentación de servicios y equipo",
      "medición de campañas",
    ],
    registry: "none",
  },
  hospitality: {
    id: "hospitality",
    label: "Hospedajes y operadores turísticos",
    priority: 3,
    placeQueries: ["hotel", "hospedaje", "agencia de viajes"],
    strongSignals: [
      "anuncios activos que terminan en WhatsApp",
      "operación formal y reseñas recientes",
      "dependencia de redes u OTAs sin web propia",
    ],
    productHooks: [
      "consultas y reservas",
      "promociones",
      "catálogo de servicios o experiencias",
    ],
    registry: "mincetur",
  },
} as const;

export function esVerticalId(value: string): value is VerticalId {
  return (VERTICAL_IDS as readonly string[]).includes(value);
}
