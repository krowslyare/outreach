// La página del tablero: un solo HTML, cero dependencias.
//
// Todo el render ocurre en el navegador a partir de /api/estado, con polling
// cada 5 segundos. Las únicas escrituras que la página puede disparar son
// marcar un requisito y mover el estado de una ficha — lo mismo que permite el
// CLI de clientes, ni una cosa más. Enviar mensajes NO existe acá por diseño:
// el envío solo sale del proceso con sesión y su motor de seguridad.
//
// Los botones llevan data-atributos y hay UNA escucha delegada: nada de
// onclick inline con comillas escapadas dentro de atributos generados.

export const PAGINA = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kurogrid · Tablero</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 24px 16px 64px; max-width: 880px;
    font: 15px/1.5 system-ui, sans-serif;
    background: #0f1115; color: #e6e9ef;
  }
  header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 18px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #9aa3b2; margin: 26px 0 10px; }
  .mudo { color: #9aa3b2; font-size: 12.5px; }
  .tarjeta { background: #171a21; border: 1px solid #232833; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
  .fila { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .insignia { display: inline-block; font-size: 11.5px; font-weight: 600; letter-spacing: .05em;
              padding: 2px 8px; border-radius: 999px; background: #232833; color: #cdd3de; }
  .insignia.roja  { background: #3d1d20; color: #f87171; }
  .insignia.verde { background: #14301f; color: #4ade80; }
  .insignia.ambar { background: #38301a; color: #e8b339; }
  .insignia.azul  { background: #17293b; color: #5aa9e6; }
  .numero { font-size: 30px; font-weight: 700; }
  .cita { color: #aab2c0; font-style: italic; margin: 6px 0 0; }
  .barra { height: 6px; border-radius: 4px; background: #232833; overflow: hidden; margin: 10px 0 6px; }
  .barra i { display: block; height: 100%; background: #4ade80; }
  button.chip {
    cursor: pointer; font: inherit; font-size: 12.5px; color: #cdd3de;
    background: #1d222b; border: 1px solid #2b323f; border-radius: 999px;
    padding: 3px 10px; margin: 6px 6px 0 0;
  }
  button.chip:hover { border-color: #4ade80; color: #4ade80; }
  select, a.boton {
    font: inherit; font-size: 12.5px; color: #e6e9ef; text-decoration: none;
    background: #1d222b; border: 1px solid #2b323f; border-radius: 8px; padding: 4px 8px;
  }
  select:hover, a.boton:hover { border-color: #5aa9e6; }
  .vacio { color: #9aa3b2; font-style: italic; padding: 10px 0; }
</style>
</head>
<body>
<header>
  <h1>Kurogrid · tablero</h1>
  <span class="mudo" id="actualizado"></span>
</header>

<section class="tarjeta" id="cuenta"></section>

<h2>Bandeja — quién espera respuesta</h2>
<div id="bandeja"></div>

<h2>Clientes</h2>
<div id="clientes"></div>

<h2>Embudo</h2>
<section class="tarjeta fila" id="embudo"></section>

<script>
"use strict";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

async function accion(ruta, cuerpo) {
  const r = await fetch(ruta, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  if (!r.ok) alert("No se pudo: " + (await r.text()));
  await cargar();
}

function renderCuenta(c) {
  const tasa = c.deviceRate === null
    ? "deviceRate sin muestra todavía"
    : Math.round(c.deviceRate * 100) + "% de ACK_DEVICE (muestra " + c.deviceRateMuestra +
      (c.baseline === null ? "" : ", baseline " + Math.round(c.baseline * 100) + "%") + ")";
  document.getElementById("cuenta").innerHTML =
    '<div class="fila">' +
    (c.killSwitchActivo
      ? '<span class="insignia roja">KILL SWITCH ACTIVO</span>' +
        '<span class="mudo">' + esc(c.killSwitchMotivo ?? "") + "</span>"
      : '<span class="insignia verde">envío habilitado</span>') +
    '<span style="flex:1"></span>' +
    '<span class="mudo">' + esc(tasa) + " · hoy: " + c.enviadosHoy + "</span>" +
    "</div>";
}

function renderBandeja(filas) {
  const cont = document.getElementById("bandeja");
  if (filas.length === 0) {
    cont.innerHTML = '<div class="vacio">Nadie espera una respuesta.</div>';
    return;
  }
  const color = { escalado: "ambar", deuda: "azul", ajeno: "" };
  cont.innerHTML = filas.map((f) =>
    '<div class="tarjeta"><div class="fila">' +
    '<span class="insignia ' + (color[f.motivo] ?? "") + '">' + esc(f.etiquetaMotivo) + "</span>" +
    "<strong>" + esc(f.nombre) + '</strong><span class="mudo">' + esc(f.e164) +
    " · esperando " + esc(f.esperaTexto) +
    (f.sinResolver > 1 ? " · " + f.sinResolver + " mensajes" : "") + "</span>" +
    '<span style="flex:1"></span>' +
    '<a class="boton" target="_blank" rel="noopener" href="' + esc(f.link) + '">abrir chat</a>' +
    "</div>" +
    (f.ultimoEntrante ? '<div class="cita">&ldquo;' + esc(f.ultimoEntrante) + "&rdquo;</div>" : "") +
    "</div>").join("");
}

const ESTADOS = ["kickoff", "recoleccion", "construccion", "publicado", "baja"];

function renderClientes(clientes) {
  const cont = document.getElementById("clientes");
  if (clientes.length === 0) {
    cont.innerHTML = '<div class="vacio">Todavía no hay fichas de cliente.</div>';
    return;
  }
  cont.innerHTML = clientes.map((cl) => {
    const chips = cl.faltantes.map((f) =>
      '<button class="chip" data-e164="' + esc(cl.e164) + '" data-clave="' + esc(f.clave) + '">' +
      esc(f.clave) + "</button>").join("");
    const opciones = ESTADOS.map((e) =>
      '<option value="' + e + '"' + (e === cl.estado ? " selected" : "") + ">" + e + "</option>").join("");
    return (
      '<div class="tarjeta"><div class="fila">' +
      "<strong>" + esc(cl.nombreComercial) + '</strong><span class="mudo">' +
      esc(cl.e164) + " · " + esc(cl.planEtiqueta) + "</span>" +
      '<span style="flex:1"></span>' +
      '<select data-e164="' + esc(cl.e164) + '">' + opciones + "</select>" +
      "</div>" +
      '<div class="barra"><i style="width:' + cl.pct + '%"></i></div>' +
      '<div class="mudo">' + cl.listos + "/" + cl.total + " requisitos listos</div>" +
      (chips === "" ? "" : "<div>" + chips + "</div>") +
      "</div>");
  }).join("");
}

function renderEmbudo(e) {
  document.getElementById("embudo").innerHTML =
    "<div><div class='numero'>" + e.porRevisar +
    "</div><span class='mudo'>por revisar (web sin verificar)</span></div>" +
    "<div><div class='numero'>" + e.listosParaContactar +
    "</div><span class='mudo'>aprobados listos para campaña</span></div>";
}

document.addEventListener("click", (ev) => {
  const chip = ev.target.closest("button.chip[data-e164]");
  if (chip === null) return;
  void accion("/api/clientes/" + encodeURIComponent(chip.dataset.e164) + "/requisito",
    { clave: chip.dataset.clave, resuelto: true });
});

document.addEventListener("change", (ev) => {
  const sel = ev.target.closest("select[data-e164]");
  if (sel === null) return;
  void accion("/api/clientes/" + encodeURIComponent(sel.dataset.e164) + "/estado",
    { estado: sel.value });
});

async function cargar() {
  try {
    const datos = await (await fetch("/api/estado")).json();
    renderCuenta(datos.cuenta);
    renderBandeja(datos.bandeja);
    renderClientes(datos.clientes);
    renderEmbudo(datos.embudo);
    document.getElementById("actualizado").textContent =
      "actualizado " + new Date().toLocaleTimeString("es-PE");
  } catch {
    document.getElementById("actualizado").textContent = "sin conexión con la base local";
  }
}
setInterval(cargar, 5000);
cargar();
</script>
</body>
</html>`;
