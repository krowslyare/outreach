// Catálogo de planes. Config local a propósito, NO una dependencia del portal:
// el agente tiene que poder responder aunque el portal esté caído, y una
// llamada de red en el camino de una respuesta de WhatsApp es un punto de falla
// que no compra nada. El costo es que hay que sincronizar a mano cuando cambie
// el pricing — de ahí PRICING_VERIFICADO_EN.
//
// Fuente comercial verificada contra:
// kurogrid/src/content/waas-plans.ts y kurogrid_portal.
// Ojo: el pricing vigente REEMPLAZÓ códigos anteriores (waas_esencial_199,
// waas_empresa_399, waas_sistemas_899). Si alguna vez ves esos, están viejos.

/** Fecha del pricing contra el que se verificó esto. Si pasó mucho, re-verificar. */
export const PRICING_VERIFICADO_EN = "2026-07-30";

export interface Plan {
  code: string;
  nombre: string;
  /** Etiqueta pública exacta. El agente usa ESTA cadena, nunca un número suelto. */
  precio: string;
  /** En qué caso es el plan correcto. Le sirve al agente para recomendar. */
  cuandoAplica: string;
  incluye: readonly string[];
  /** Qué permite gestionar desde el Portal Kurogrid en este plan. */
  portal: string;
}

export const PLANES: readonly Plan[] = [
  {
    code: "waas_presencia_199",
    nombre: "Presencia",
    precio: "S/ 199 mensual",
    cuandoAplica:
      "Dice de forma explícita que solo necesita tener la web profesional resuelta y administrada. Que hoy no tenga web, por sí solo, NO basta para recomendar Presencia.",
    incluye: [
      "Web profesional administrada",
      "Dominio y hosting incluidos",
      "Mantenimiento y actualizaciones de contenido",
    ],
    portal:
      "Plan, pagos, estado de la web, solicitudes de cambios e historial.",
  },
  {
    code: "waas_empresa_449",
    nombre: "Empresa",
    precio: "S/ 449 mensual",
    cuandoAplica:
      "Quiere captar contactos reales desde la web, medir resultados o dar acceso a su equipo desde el Portal.",
    incluye: [
      "Web corporativa multisección",
      "Captación de contactos",
      "Medición de resultados",
    ],
    portal:
      "Todo lo de Presencia, más oportunidades reales de formularios, analytics y accesos del equipo.",
  },
  {
    code: "waas_empresa_plus_649",
    nombre: "Empresa +",
    precio: "S/ 649 mensual",
    cuandoAplica:
      "Necesita Libro de Reclamaciones con seguimiento, mayor capacidad de cambios o atención prioritaria. Varios servicios o sedes solo son señal si la persona expresa esa necesidad.",
    incluye: [
      "Todo lo de Empresa",
      "Atención prioritaria",
      "Mayor capacidad de cambios",
      "Libro de Reclamaciones integrado",
    ],
    portal:
      "Todo lo de Empresa, más Libro de Reclamaciones con constancias, estados, plazos, respuestas y exportación.",
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
    portal: "Seguimiento de la operación y de los módulos acordados.",
  },
] as const;

export interface ModuloActivable {
  nombre: string;
  precio: string;
  implementacion: string;
  disponibilidad: string;
  descripcion: string;
}

export const MODULOS_ACTIVABLES: readonly ModuloActivable[] = [
  {
    nombre: "Promociones",
    precio: "+ S/ 79 mensual",
    implementacion: "Sin pago de implementación",
    disponibilidad: "Disponible para todos los planes",
    descripcion:
      "Publicación y gestión de campañas o promociones desde el Portal.",
  },
  {
    nombre: "Catálogo",
    precio: "+ S/ 99 mensual",
    implementacion: "Implementación desde S/ 390",
    disponibilidad: "Desde Empresa",
    descripcion:
      "Catálogo administrable de servicios o productos desde el Portal.",
  },
  {
    nombre: "Reservas",
    precio: "+ S/ 149 mensual",
    implementacion: "Implementación S/ 490",
    disponibilidad: "Desde Empresa",
    descripcion:
      "Reservas o citas gestionadas desde el Portal.",
  },
] as const;

/** El catálogo como texto para el prompt. Estable entre prospectos → cacheable. */
export function catalogoParaPrompt(): string {
  const planes = PLANES.map(
    (p) =>
      `- ${p.nombre} — ${p.precio}\n` +
      `  Cuándo: ${p.cuandoAplica}\n` +
      `  Incluye: ${p.incluye.join("; ")}\n` +
      `  Portal: ${p.portal}`,
  ).join("\n");

  const modulos = MODULOS_ACTIVABLES.map(
    (m) =>
      `- ${m.nombre} — ${m.precio}; ${m.implementacion}; ${m.disponibilidad}\n` +
      `  Qué hace: ${m.descripcion}`,
  ).join("\n");

  return `${planes}\n\nMódulos activables — no están incluidos por defecto:\n${modulos}`;
}
