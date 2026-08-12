# Outreach visual

El envío multimedia es opt-in y fail-closed. Un manifiesto aprobado restringe
la tanda a sus propios números; nunca convierte al resto de la campaña a imagen.

## Manifiesto

Las rutas de imagen se resuelven desde la carpeta del JSON. Solo se aceptan PNG
16:9 exactos, de hasta 15 MB. `paso` puede ser `first` o `fu1`. `nombre` es el
nombre comercial revisado que aparecerá en el caption; si se omite, se usa el
nombre normalizado del prospecto.

```json
{
  "version": 1,
  "visuales": [
    {
      "e164": "+51900000001",
      "paso": "fu1",
      "nombre": "Clínica Demo",
      "imagen": "./heroes/51900000001.png"
    }
  ]
}
```

## Revisión sin WhatsApp

```bash
npm run campana -- --visuales ./aprobados/manifest.json --dry-run
```

El dry-run debe mostrar por cada destinatario:

- `[fu1/visual]` o `[first/visual]`;
- la ruta absoluta del PNG 16:9;
- el caption completo;
- cero envíos reales y cero sesión de WhatsApp.

## Envío real

Solo después de revisar el dry-run completo:

```bash
npm run campana -- --visuales ./aprobados/manifest.json --max 10 --escuchar
```

Las puertas existentes siguen mandando: horario, domingo inactivo, tope diario,
separación, opt-out, respuesta humana, takeover, kill switch e idempotencia por
destinatario/paso. Si el paso actual no coincide con el aprobado, no se envía.

## QA obligatorio del hero

- datos públicos vigentes y nada inventado;
- `CONCEPTO INICIAL` visible;
- anatomía, manos, patas, muebles y equipos coherentes;
- texto y tildes revisados;
- negocio, CTA y propuesta legibles en WhatsApp;
- 16:9 exacto;
- aprobación humana antes de añadirlo al manifiesto.
