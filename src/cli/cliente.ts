// El onboarding como comando: fichas de clientes cerrados y su checklist.
//
//   npm run cliente -- --lista
//   npm run cliente -- --nuevo +51987654321 --nombre "Clínica Sonrisa" --plan empresa+
//   npm run cliente -- --detalle +51987654321
//   npm run cliente -- --listo +51987654321 fotos
//   npm run cliente -- --kickoff +51987654321
//
// Nada sale por WhatsApp desde acá: el kickoff se imprime para pegarlo en el
// chat. Enviar solo tiene sentido desde el proceso con sesión vinculada, y
// mezclar un segundo canal de envío duplicaría exactamente lo que la seguridad
// del canal trabaja en evitar.

import "./env.js";

import { Store } from "../wa/store.js";
import {
  ETIQUETA_ESTADO,
  ETIQUETA_PLAN,
  barraProgreso,
  esEstadoCliente,
  mensajeKickoff,
  normalizarPlan,
  progreso,
  type EstadoCliente,
} from "../onboarding/requisitos.js";

const E164 = /^\+51\d{9}$/;

/** Valor de un flag, en forma separada (`--x v`) o inline (`--x=v`). */
function valor(args: readonly string[], nombre: string): string | undefined {
  const posicional = args.indexOf(`--${nombre}`);
  if (posicional >= 0) return args[posicional + 1];
  return args
    .find((a) => a.startsWith(`--${nombre}=`))
    ?.slice(`--${nombre}=`.length);
}

/**
 * Los argumentos posicionales que siguen a un flag, hasta el próximo flag.
 * Para acciones que toman dos valores: `--listo +51987654321 fotos`.
 */
function posicionales(args: readonly string[], nombre: string): string[] {
  const inicio = args.indexOf(`--${nombre}`);
  if (inicio < 0) return [];
  const resto = args.slice(inicio + 1);
  const fin = resto.findIndex((a) => a.startsWith("--"));
  return (fin === -1 ? resto : resto.slice(0, fin)).map((a) => a.trim());
}

function exigir(valorSuelto: string | undefined, flag: string): string {
  if (valorSuelto === undefined || valorSuelto.trim() === "") {
    throw new Error(`--${flag} es obligatorio para esta acción`);
  }
  return valorSuelto.trim();
}

function exigirE164(valorSuelto: string | undefined): string {
  const limpio = exigir(valorSuelto, "e164");
  if (!E164.test(limpio)) {
    throw new Error(
      `${limpio} no es un móvil peruano en E.164, por ejemplo +51987654321`,
    );
  }
  return limpio;
}

function fechaCorta(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

const args = process.argv.slice(2);
const nuevo = valor(args, "nuevo");
const detalle = valor(args, "detalle");
const kickoff = valor(args, "kickoff");
const listo = posicionales(args, "listo");
const falta = posicionales(args, "falta");
const estadoArgs = posicionales(args, "estado");
const notaArgs = posicionales(args, "nota");

const store = new Store();
try {
  // ---- crear ---------------------------------------------------------------
  if (nuevo !== undefined) {
    const e164 = exigirE164(nuevo);
    const nombre = exigir(valor(args, "nombre"), "nombre");
    const planEntrada = exigir(valor(args, "plan"), "plan");
    const plan = normalizarPlan(planEntrada);
    if (plan === null) {
      throw new Error(
        `plan desconocido: "${planEntrada}". Válidos: presencia, empresa, ` +
          "empresa+ (empresa_plus), sistemas",
      );
    }
    // La nota inicial acepta varias palabras SIN comillas, igual que la acción
    // --nota: valor() devolvería solo el primer token y el resto se perdería
    // en silencio.
    const notaInicial = posicionales(args, "nota").slice(1).join(" ");
    store.crearCliente({
      e164,
      nombreComercial: nombre,
      plan,
      notas: notaInicial.trim() === "" ? undefined : notaInicial,
    });
    console.info(
      `${nombre} (${e164}) cread@ con plan ${ETIQUETA_PLAN[plan]}. ` +
        `Checklist sembrado; el primer paso es el kickoff:\n` +
        `  npm run cliente -- --kickoff ${e164}`,
    );
    process.exit(0);
  }

  // ---- marcar requisitos ---------------------------------------------------
  if (listo.length > 0 || falta.length > 0) {
    const [e164SinValidar, clave] = listo.length > 0 ? listo : falta;
    const resuelto = listo.length > 0;
    const e164 = exigirE164(e164SinValidar);
    if (clave === undefined || clave === "") {
      throw new Error(
        `falta la clave del requisito: npm run cliente -- --${resuelto ? "listo" : "falta"} ${e164} <clave>`,
      );
    }
    if (!store.marcarRequisito(e164, clave, resuelto)) {
      throw new Error(
        `"${clave}" no existe en la ficha de ${e164}. ` +
          "Revise las claves con --detalle.",
      );
    }
    const ficha = store.cargarCliente(e164);
    if (ficha === null) throw new Error(`${e164} no es cliente`);
    const p = progreso(ficha.requisitos);
    console.info(
      `${ficha.nombreComercial}: ${clave} ${resuelto ? "marcado" : "desmarcado"}. ` +
        `${barraProgreso(p.listos, p.total)}` +
        (p.faltantes.length === 0 && ficha.estado === "recoleccion"
          ? "\n  Requisitos completos: puede pasar a construcción.\n" +
            `  npm run cliente -- --estado ${e164} construccion`
          : ""),
    );
    process.exit(0);
  }

  // ---- estado --------------------------------------------------------------
  if (estadoArgs.length > 0) {
    const [e164SinValidar, nuevoEstado] = estadoArgs;
    const e164 = exigirE164(e164SinValidar);
    if (nuevoEstado === undefined || !esEstadoCliente(nuevoEstado)) {
      throw new Error(
        `estado requerido y válido. Estados: kickoff, recoleccion, ` +
          "construccion, publicado, baja",
      );
    }
    if (store.cargarCliente(e164) === null) {
      throw new Error(`${e164} no es cliente`);
    }
    store.cambiarEstadoCliente(e164, nuevoEstado);
    console.info(`${e164}: estado → ${nuevoEstado}`);
    process.exit(0);
  }

  // ---- nota ----------------------------------------------------------------
  if (notaArgs.length > 0) {
    const [e164SinValidar, ...texto] = notaArgs;
    const e164 = exigirE164(e164SinValidar);
    store.agregarNotaCliente(e164, texto.join(" "));
    console.info(`Nota agregada a ${e164}.`);
    process.exit(0);
  }

  // ---- kickoff -------------------------------------------------------------
  if (kickoff !== undefined) {
    const e164 = exigirE164(kickoff);
    const ficha = store.cargarCliente(e164);
    if (ficha === null) {
      throw new Error(`${e164} no es cliente`);
    }
    console.info(mensajeKickoff(ficha.nombreComercial, ficha.requisitos));
    console.info(
      `\n---\nNo se envió nada: pégalo en el chat de ${e164}. ` +
        "Después mueve la ficha:\n" +
        `  npm run cliente -- --estado ${e164} recoleccion`,
    );
    process.exit(0);
  }

  // ---- detalle -------------------------------------------------------------
  if (detalle !== undefined) {
    const e164 = exigirE164(detalle);
    const ficha = store.cargarCliente(e164);
    if (ficha === null) {
      throw new Error(`${e164} no es cliente`);
    }
    const p = progreso(ficha.requisitos);
    console.info(
      `${ficha.nombreComercial} · ${ficha.e164}\n` +
        `Plan ${ETIQUETA_PLAN[ficha.plan]} · ${ETIQUETA_ESTADO[ficha.estado]} · ` +
        `desde ${fechaCorta(ficha.creadoEn)}` +
        (ficha.publicadoEn !== null
          ? ` · publicado ${fechaCorta(ficha.publicadoEn)}`
          : "") +
        `\n${barraProgreso(p.listos, p.total)}\n`,
    );
    if (ficha.notas !== null && ficha.notas !== "") {
      console.info(
        "Notas:\n" +
          ficha.notas
            .split("\n")
            .map((linea) => `  ${linea}`)
            .join("\n") +
          "\n",
      );
    }
    for (const requisito of ficha.requisitos) {
      console.info(
        `  [${requisito.resuelto ? "x" : " "}] ${requisito.clave}: ${requisito.etiqueta}`,
      );
    }
    console.info(
      `\nMarcar: npm run cliente -- --listo ${e164} <clave>   ` +
        `Desmarcar: --falta ${e164} <clave>`,
    );
    process.exit(0);
  }

  // ---- tablero (default) ---------------------------------------------------
  const clientes = store.listarClientes();
  if (clientes.length === 0) {
    console.info(
      "Todavía no hay clientes. Cuando alguien cierre:\n" +
        '  npm run cliente -- --nuevo +51987654321 --nombre "Su negocio" --plan empresa+',
    );
    process.exit(0);
  }

  const activos = clientes.filter((c) => c.estado !== "baja").length;
  console.info(`Clientes — ${clientes.length} (${activos} activos)\n`);
  for (const ficha of clientes) {
    const p = progreso(ficha.requisitos);
    console.info(
      `${ficha.estado.toUpperCase()} · ${barraProgreso(p.listos, p.total)} · ${ficha.nombreComercial}`,
    );
    console.info(
      `  ${ficha.e164} · ${ETIQUETA_PLAN[ficha.plan]}` +
        (p.faltantes.length === 0 && ficha.estado === "recoleccion"
          ? " · requisitos completos: pasar a construccion"
          : ""),
    );
  }
  console.info(
    "\nDetalle de una ficha: npm run cliente -- --detalle +51987654321",
  );
} finally {
  store.close();
}
