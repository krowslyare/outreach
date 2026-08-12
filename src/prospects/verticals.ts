export const VERTICAL_IDS = [
  "dental",
  "veterinary",
  "aesthetics",
  "construction",
  "contractors",
  "interiors",
  "health",
  "education",
  "legal",
  "hospitality",
] as const;

export type VerticalId = (typeof VERTICAL_IDS)[number];

/**
 * Una sola fuente de verdad para adaptar la propuesta al rubro.
 *
 * Prospección, compositor, agente y generador visual consumen este mismo
 * perfil. Agregar una vertical nueva no debe requerir sembrar reglas sueltas en
 * cuatro prompts distintos.
 */
export interface VerticalCommercialProfile {
  /** Cómo llama el negocio a las personas que quiere atraer o atender. */
  audience: string;
  /** Beneficio que abre la conversación; no es una afirmación sobre el lead. */
  primaryAngle: string;
  /** Capacidades de Kurogrid con mayor relevancia para esta vertical. */
  productHooks: readonly string[];
  /** Uso permitido del ángulo normativo, con límites para no prometer de más. */
  complianceAngle: string;
  /** Dirección reutilizable por el pipeline de heroes y propuestas visuales. */
  visualDirection: string;
}

export interface VerticalConfig {
  id: VerticalId;
  label: string;
  priority: 1 | 2 | 3;
  /** Frases para descubrimiento futuro con Places o revisión manual. */
  placeQueries: readonly string[];
  /** Señales comerciales que justifican subirlo a shortlist A. */
  strongSignals: readonly string[];
  /** Posicionamiento, producto, cumplimiento y dirección visual del rubro. */
  commercial: VerticalCommercialProfile;
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
    commercial: {
      audience: "pacientes",
      primaryAngle:
        "Transmitir confianza profesional y presentar tratamientos, especialistas y datos de atención con claridad.",
      productHooks: [
        "consultas de pacientes desde la web",
        "Libro de Reclamaciones cuando corresponda",
        "reservas, promociones y cambios administrados",
      ],
      complianceAngle:
        "Puede mencionarse privacidad y Libro de Reclamaciones como soporte de cumplimiento digital cuando corresponda; nunca prometer evitar multas ni asumir responsabilidad legal.",
      visualDirection:
        "Salud premium y confiable: fotografía clínica humana, composición limpia, jerarquía clara y sobriedad sin estética hospitalaria genérica.",
    },
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
    commercial: {
      audience: "tutores de mascotas",
      primaryAngle:
        "Transmitir confianza y facilitar que los tutores entiendan servicios, disponibilidad y formas de atención.",
      productHooks: [
        "consultas y reservas",
        "promociones y campañas",
        "catálogo de servicios o productos",
      ],
      complianceAngle:
        "Privacidad y Libro de Reclamaciones pueden aparecer como respaldo cuando apliquen, no como el motivo principal ni como garantía legal.",
      visualDirection:
        "Cálida y profesional: animales reales con sus tutores, confianza médica, color controlado y nada infantil o de pet shop genérico.",
    },
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
    commercial: {
      audience: "pacientes y clientes",
      primaryAngle:
        "Elevar la percepción premium del negocio y presentar tratamientos con una experiencia visual coherente con sus resultados.",
      productHooks: [
        "consultas desde la web",
        "promociones",
        "reservas y medición de campañas",
      ],
      complianceAngle:
        "El consentimiento para datos y el Libro de Reclamaciones, cuando corresponda, son respaldo; no desplazan el ángulo de imagen, confianza y captación.",
      visualDirection:
        "Editorial premium y ligeramente Awwwards: piel real, lujo sobrio, tipografía refinada, mucho aire y cero apariencia de anuncio barato.",
    },
    registry: "renipress",
  },
  construction: {
    id: "construction",
    label: "Constructoras e inmobiliarias",
    priority: 1,
    placeQueries: [
      "empresa constructora",
      "constructora inmobiliaria",
      "proyectos inmobiliarios",
    ],
    strongSignals: [
      "anuncios activos de proyectos que terminan solo en Instagram o WhatsApp",
      "proyectos de ticket alto con material visual verificable",
      "portafolio reciente, equipo visible o varios proyectos en venta",
      "sitio inexistente, desactualizado o que no transmite el nivel de los proyectos",
    ],
    commercial: {
      audience: "compradores, inversionistas y clientes corporativos",
      primaryAngle:
        "Elevar la imagen corporativa y presentar proyectos a la altura de su valor para convertir interés en consultas y cotizaciones.",
      productHooks: [
        "portafolio administrado de proyectos",
        "consultas y solicitudes de cotización",
        "medición de campañas y acceso para el equipo",
      ],
      complianceAngle:
        "Privacidad, consentimiento y canales de reclamación pueden ayudar al cumplimiento digital. No afirmar que la web resuelve licencias, normativa de construcción o evita multas.",
      visualDirection:
        "Arquitectura editorial premium: fotografía amplia, grilla rigurosa, tipografía sobria, materiales y escala; sensación corporativa, no plantilla inmobiliaria.",
    },
    registry: "none",
  },
  contractors: {
    id: "contractors",
    label: "Contratistas B2B e industriales",
    priority: 1,
    placeQueries: [
      "empresa contratista",
      "contratista minera",
      "servicios industriales",
    ],
    strongSignals: [
      "servicios para minería, energía, construcción o mantenimiento industrial",
      "proyectos, equipos, certificaciones o capacidad operativa verificable",
      "dependencia de una ficha de Google, PDF o WhatsApp en vez de una web corporativa",
      "compradores B2B que necesitan pedir cotización o validar credenciales",
    ],
    commercial: {
      audience: "clientes corporativos, áreas de compras y responsables de proyectos",
      primaryAngle:
        "Convertir la capacidad operativa y los proyectos en una presencia corporativa que inspire confianza y genere solicitudes B2B.",
      productHooks: [
        "portafolio de proyectos y servicios administrado",
        "consultas y solicitudes de cotización",
        "credenciales, equipo y documentos presentados con claridad",
        "Portal para cambios, consultas y coordinación del equipo",
      ],
      complianceAngle:
        "La web puede ordenar documentos y declaraciones que la empresa ya tenga, pero no crea certificaciones, homologaciones, permisos ni habilita para licitar; nunca prometer cumplimiento sectorial.",
      visualDirection:
        "B2B industrial sobrio: proyectos y equipos reales, escala, datos verificables, grilla editorial y autoridad técnica; nada de stock minero genérico ni insignias inventadas.",
    },
    registry: "none",
  },
  interiors: {
    id: "interiors",
    label: "Estudios de arquitectura e interiorismo",
    priority: 1,
    placeQueries: [
      "diseño de interiores",
      "estudio de arquitectura",
      "arquitectura interior",
    ],
    strongSignals: [
      "anuncios activos de proyectos o remodelaciones",
      "portafolio visual sólido pero dependiente de Instagram",
      "proyectos residenciales o comerciales de ticket alto",
      "identidad cuidada sin una web a la misma altura",
    ],
    commercial: {
      audience: "clientes residenciales y empresas",
      primaryAngle:
        "Convertir el portafolio en una experiencia digital premium que eleve la percepción del estudio y genere consultas de proyectos.",
      productHooks: [
        "portafolio administrado de proyectos",
        "consultas y solicitudes de cotización",
        "promociones, contenido y medición de campañas",
      ],
      complianceAngle:
        "Privacidad, consentimiento y canales de reclamación son respaldo cuando apliquen; el gancho principal sigue siendo imagen, portafolio y captación.",
      visualDirection:
        "Portafolio Awwwards sobrio: imágenes protagonistas, ritmo editorial, detalles de materiales, transiciones discretas y lujo contemporáneo sin ornamento de dashboard.",
    },
    registry: "none",
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
    commercial: {
      audience: "pacientes",
      primaryAngle:
        "Ordenar especialidades y transmitir confianza para que los pacientes encuentren información y atención con claridad.",
      productHooks: [
        "consultas desde la web",
        "Libro de Reclamaciones cuando corresponda",
        "equipo y seguimiento del servicio",
      ],
      complianceAngle:
        "Privacidad y Libro de Reclamaciones pueden ser relevantes cuando correspondan; no ofrecer asesoría sanitaria ni garantizar cumplimiento legal.",
      visualDirection:
        "Institucional contemporánea y humana: claridad clínica, especialidades fáciles de recorrer y fotografía auténtica sin stock médico genérico.",
    },
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
    commercial: {
      audience: "familias y estudiantes",
      primaryAngle:
        "Transmitir confianza institucional y convertir campañas de matrícula en solicitudes de información o admisión.",
      productHooks: [
        "solicitudes de admisión",
        "campañas y contenido administrado",
        "Libro de Reclamaciones cuando corresponda",
      ],
      complianceAngle:
        "Privacidad de datos y Libro de Reclamaciones son soporte cuando apliquen; nunca presentar la web como cumplimiento educativo integral.",
      visualDirection:
        "Educación confiable y viva: comunidad real, jerarquía institucional, información de admisión clara y color con disciplina.",
    },
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
    commercial: {
      audience: "personas y empresas que necesitan asesoría",
      primaryAngle:
        "Proyectar autoridad y explicar servicios y equipo con claridad para generar consultas calificadas.",
      productHooks: [
        "consultas calificadas",
        "presentación de servicios y equipo",
        "medición de campañas",
      ],
      complianceAngle:
        "La privacidad de formularios es un respaldo; no insinuar que Kurogrid presta asesoría legal o contable.",
      visualDirection:
        "Autoridad sobria y moderna: retrato editorial, tipografía seria, casos o áreas bien jerarquizadas y nada de clichés de balanza o apretón de manos.",
    },
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
    commercial: {
      audience: "huéspedes y viajeros",
      primaryAngle:
        "Hacer deseable la experiencia y reducir dependencia de redes u OTAs convirtiendo visitas en consultas y reservas.",
      productHooks: [
        "consultas y reservas",
        "promociones",
        "catálogo de servicios o experiencias",
      ],
      complianceAngle:
        "Privacidad y canales de reclamación pueden aparecer cuando correspondan; no prometer cumplimiento turístico integral.",
      visualDirection:
        "Experiencia inmersiva y editorial: destino y espacios como protagonistas, reserva clara y lujo ajustado al posicionamiento real.",
    },
    registry: "mincetur",
  },
} as const;

export function esVerticalId(value: string): value is VerticalId {
  return (VERTICAL_IDS as readonly string[]).includes(value);
}

export function verticalConfig(value: string | null | undefined): VerticalConfig | null {
  return value !== null && value !== undefined && esVerticalId(value)
    ? VERTICALES[value]
    : null;
}

/** Bloque común que reciben compositor y agente; nunca contiene datos del lead. */
export function perfilVerticalParaPrompt(
  value: string | null | undefined,
): string {
  const config = verticalConfig(value);
  if (config === null) {
    return [
      "<perfil_vertical>",
      "Vertical: no verificada",
      "Usa únicamente el rubro concreto del prospecto y el núcleo general de Kurogrid.",
      "</perfil_vertical>",
    ].join("\n");
  }

  return [
    "<perfil_vertical>",
    `Vertical: ${config.id} — ${config.label}`,
    `Audiencia del negocio: ${config.commercial.audience}`,
    `Ángulo principal: ${config.commercial.primaryAngle}`,
    `Ángulos de producto: ${config.commercial.productHooks.join(" | ")}`,
    `Cumplimiento: ${config.commercial.complianceAngle}`,
    "Este perfil orienta el mensaje; no prueba nada sobre el prospecto ni autoriza a afirmar experiencia previa en el rubro.",
    "</perfil_vertical>",
  ].join("\n");
}
