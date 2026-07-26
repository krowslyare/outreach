// Catálogo de planes. Config local a propósito, NO una dependencia del portal:
// el agente tiene que poder responder aunque el portal esté caído, y una
// llamada de red en el camino de una respuesta de WhatsApp es un punto de falla
// que no compra nada. El costo es que hay que sincronizar a mano cuando cambie
// el pricing — de ahí PRICING_VERIFICADO_EN.
//
// Fuente: kurogrid_portal, migración 20260719120000_update_plans_pricing_2026.sql
// Ojo: esa migración REEMPLAZÓ códigos anteriores (waas_esencial_199,
// waas_empresa_399, waas_sistemas_899). Si alguna vez ves esos, están viejos.

/** Fecha del pricing contra el que se verificó esto. Si pasó mucho, re-verificar. */
export const PRICING_VERIFICADO_EN = "2026-07-19";

export interface Plan {
  code: string;
  nombre: string;
  /** Etiqueta pública exacta. El agente usa ESTA cadena, nunca un número suelto. */
  precio: string;
  /** En qué caso es el plan correcto. Le sirve al agente para recomendar. */
  cuandoAplica: string;
  incluye: readonly string[];
}

export const PLANES: readonly Plan[] = [
  {
    code: "waas_presencia_199",
    nombre: "Presencia",
    precio: "S/ 199 mensual",
    cuandoAplica:
      "No tiene web y necesita existir en Google con algo serio. El punto de entrada.",
    incluye: [
      "Web profesional administrada",
      "Dominio y hosting incluidos",
      "Mantenimiento y actualizaciones de contenido",
    ],
  },
  {
    code: "waas_empresa_449",
    nombre: "Empresa",
    precio: "S/ 449 mensual",
    cuandoAplica:
      "Quiere que la web le traiga pacientes, no solo estar presente. Varias secciones y medición.",
    incluye: [
      "Web corporativa multisección",
      "Captación de contactos",
      "Medición de resultados",
    ],
  },
  {
    code: "waas_empresa_plus_649",
    nombre: "Empresa +",
    precio: "S/ 649 mensual",
    cuandoAplica:
      "Clínicas y centros con varios servicios o sedes, que necesitan cambios seguido y Libro de Reclamaciones.",
    incluye: [
      "Todo lo de Empresa",
      "Atención prioritaria",
      "Mayor capacidad de cambios",
      "Libro de Reclamaciones integrado",
    ],
  },
  {
    code: "waas_sistemas_999",
    nombre: "Sistemas",
    precio: "Desde S/ 999 mensual",
    cuandoAplica:
      "Necesita software, no una web: reservas, flujos internos, reportes, integraciones.",
    incluye: [
      "Sistema web a medida",
      "Operación administrada",
      "Flujos internos, reportes e integraciones",
    ],
  },
] as const;

/** El catálogo como texto para el prompt. Estable entre prospectos → cacheable. */
export function catalogoParaPrompt(): string {
  return PLANES.map(
    (p) =>
      `- ${p.nombre} — ${p.precio}\n` +
      `  Cuándo: ${p.cuandoAplica}\n` +
      `  Incluye: ${p.incluye.join("; ")}`,
  ).join("\n");
}
