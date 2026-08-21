// Del "sí, quiero contratar" a un cliente con web publicada.
//
// El handoff le pasa la conversación al dueño; este módulo cubre lo que viene
// después, que es donde se pierden los cierres: qué información hay que pedirle
// al cliente, qué ya mandó y qué sigue pendiente. Todo determinista a propósito:
// el kickoff no es un texto creativo, es una lista de necesidades. Un LLM acá
// agregaría variabilidad sin agregar nada.

/** Claves estables para los planes del catálogo comercial. */
export type PlanCliente =
  | "presencia"
  | "empresa"
  | "empresa_plus"
  | "sistemas";

export const PLANES_CLIENTE: readonly PlanCliente[] = [
  "presencia",
  "empresa",
  "empresa_plus",
  "sistemas",
];

export const ETIQUETA_PLAN: Record<PlanCliente, string> = {
  presencia: "Presencia",
  empresa: "Empresa",
  empresa_plus: "Empresa +",
  sistemas: "Sistemas",
};

/**
 * Acepta la clave o el nombre público, en cualquier mayúscula. La CLI recibe
 * texto de una persona apurada; normalizar acá evita rechazos por "+",
 * espacios o tildes mentales.
 */
export function normalizarPlan(entrada: string): PlanCliente | null {
  // El "+" se come con los espacios que tenga alrededor ("Empresa +",
  // "empresa+"); los espacios restantes se vuelven guion bajo.
  const clave = entrada
    .trim()
    .toLowerCase()
    .replace(/\s*\+\s*/g, "_plus")
    .replace(/\s+/g, "_");
  return PLANES_CLIENTE.find((plan) => plan === clave) ?? null;
}

export interface RequisitoPlantilla {
  /** Clave estable en la base. No renombrar: es llave primaria junto al e164. */
  clave: string;
  /** Lo que se le pide al cliente, tal cual va al mensaje y al checklist. */
  etiqueta: string;
}

/**
 * Base común a todos los planes. Es lo mínimo para diseñar y publicar una web
 * administrada; si falta algo, el trabajo se detiene exactamente ahí.
 */
const BASE_COMUN: readonly RequisitoPlantilla[] = [
  {
    clave: "servicios",
    etiqueta:
      "Qué ofrece su negocio: la lista de servicios o productos, con precios si los tiene a mano",
  },
  {
    clave: "textos",
    etiqueta:
      "Textos base: cómo presentaría su negocio en tres o cuatro líneas (en bruto también sirve)",
  },
  {
    clave: "fotos",
    etiqueta: "Fotos reales: local, equipo o trabajos realizados",
  },
  {
    clave: "logo",
    etiqueta: "Su logo, o el nombre exacto tal cual debe verse en la web",
  },
  { clave: "horario", etiqueta: "Horario de atención" },
  {
    clave: "contacto",
    etiqueta:
      "Datos de contacto públicos: teléfono o WhatsApp, dirección y redes sociales",
  },
  {
    clave: "dominio",
    etiqueta:
      "El dominio web que prefiere (por ejemplo, minegocio.pe), o si prefiere que se lo proponga Kurogrid",
  },
];

const EXTRAS_POR_PLAN: Record<PlanCliente, readonly RequisitoPlantilla[]> = {
  presencia: [],
  empresa: [
    {
      clave: "destino_consultas",
      etiqueta:
        "A dónde deben llegar las consultas del formulario: un correo o un WhatsApp",
    },
  ],
  empresa_plus: [
    {
      clave: "libro_reclamos",
      etiqueta:
        "Datos para el Libro de Reclamaciones: razón social, RUC y domicilio fiscal",
    },
  ],
  sistemas: [
    {
      clave: "flujos",
      etiqueta:
        "El flujo principal que quiere sistematizar, paso a paso, aunque sea en bruto",
    },
  ],
};

/** La plantilla completa del plan, base común primero. */
export function plantillaRequisitos(plan: PlanCliente): RequisitoPlantilla[] {
  return [...BASE_COMUN, ...EXTRAS_POR_PLAN[plan]];
}

export type EstadoCliente =
  | "kickoff"
  | "recoleccion"
  | "construccion"
  | "publicado"
  | "baja";

export const ESTADOS_CLIENTE: readonly EstadoCliente[] = [
  "kickoff",
  "recoleccion",
  "construccion",
  "publicado",
  "baja",
];

export const ETIQUETA_ESTADO: Record<EstadoCliente, string> = {
  kickoff: "kickoff: falta enviar el primer mensaje",
  recoleccion: "recolección: juntando requisitos",
  construccion: "construcción: armando la web",
  publicado: "publicado",
  baja: "baja",
};

export function esEstadoCliente(valor: string): valor is EstadoCliente {
  return (ESTADOS_CLIENTE as readonly string[]).includes(valor);
}

export interface RequisitoCliente extends RequisitoPlantilla {
  resuelto: boolean;
  resueltoEn: Date | null;
}

export interface ProgresoRequisitos {
  listos: number;
  total: number;
  faltantes: RequisitoPlantilla[];
}

export function progreso(
  requisitos: readonly RequisitoCliente[],
): ProgresoRequisitos {
  const faltantes = requisitos
    .filter((r) => !r.resuelto)
    .map(({ clave, etiqueta }) => ({ clave, etiqueta }));
  return {
    listos: requisitos.length - faltantes.length,
    total: requisitos.length,
    faltantes,
  };
}

/** Barra de texto para el tablero: [####----] 3/8. */
export function barraProgreso(listos: number, total: number): string {
  if (total <= 0) return "[----] 0/0";
  const llenos = Math.round((listos / total) * 4);
  return `[${"#".repeat(llenos)}${"-".repeat(4 - llenos)}] ${listos}/${total}`;
}

/**
 * El primer mensaje al cliente cerrado. Texto FIJO, no generado: es el mensaje
 * más caro del onboarding y no se juega a la varianza de un modelo. Lista solo
 * lo que falta, numerado, con la regla de oro explícita: de a poco y sin
 * perfección, porque exigir todo junto es como se abandona un onboarding.
 */
export function mensajeKickoff(
  nombreComercial: string,
  requisitos: readonly RequisitoCliente[],
): string {
  const { faltantes } = progreso(requisitos);

  if (faltantes.length === 0) {
    return (
      `Hola ${nombreComercial}, gracias por confiar en Kurogrid.\n\n` +
      "Ya tenemos todo lo necesario para armar su web, así que empezamos " +
      "de una. Cualquier cosa me escribe directo por acá."
    );
  }

  const lista = faltantes
    .map((r, i) => `${i + 1}. ${r.etiqueta}`)
    .join("\n");

  return (
    `Hola ${nombreComercial}, gracias por confiar en Kurogrid. Arrancamos.\n\n` +
    "Para armar su web necesito que me pase lo siguiente:\n\n" +
    lista +
    "\n\n" +
    "Puede mandármelo de a poco por este mismo chat y sin perfección: con " +
    "lo que haya servimos. Yo voy marcando lo que llegue y le aviso en " +
    "cuanto tengamos todo para empezar."
  );
}
