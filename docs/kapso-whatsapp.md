# WhatsApp con Kapso

Volta recibe mensajes de WhatsApp en `POST /webhooks/kapso/whatsapp` y responde usando el mismo agente operacional que alimenta el dashboard. Las conversaciones se conservan por número de remitente con el título `WhatsApp · <número>`.

## Mensajes de voz

Los audios entrantes (`message.type: "audio"`) se enrutan al mismo agente backend. Kapso aporta la transcripción en `message.kapso.transcript.text`; Volta la usa como la consulta del usuario y responde por texto en el mismo chat de WhatsApp. Para payloads más recientes también acepta `message.kapso.content`, el contenido listo para LLM que Kapso genera.

Si Kapso no pudo transcribir el audio, Volta pide reenviarlo o escribir la consulta: nunca inventa una pregunta a partir del binario del audio.

## Aprobaciones interactivas

Cuando el agente propone una única acción HITL, Volta responde con un mensaje `interactive` y dos reply buttons nativos: **Aprobar** y **Rechazar**. Cada botón lleva el UUID completo de la acción en su ID (`volta:approve:<uuid>` o `volta:decline:<uuid>`); el webhook solo lo acepta en el mismo hilo y desde el mismo número que creó la propuesta.

Si el mensaje interactivo falla, el backend envía el mismo contenido como texto. El usuario también puede escribir `APROBAR` / `RECHAZAR` o enviarlos por audio para usar la ruta de respaldo. Un «sí» aislado nunca ejecuta una acción porque podría ser la respuesta a una pregunta del intake.

## Elección automática al terminar una ronda

Cuando todos los transportistas de un mandato terminaron y sus cotizaciones fueron revisadas, Volta ordena solo las que cumplen el mandato por precio (y ETA como desempate). Envía por Kapso las dos mejores opciones con botones **Elegir opción 1** y **Elegir opción 2**. El botón aprueba únicamente la cotización indicada, desde el mismo número al que se envió, e inicia la llamada de cierre al proveedor elegido.

Para un mandato creado desde WhatsApp, el destinatario es el número que aprobó el mandato. Para uno creado en el dashboard, configura `VOLTA_SELECTION_WHATSAPP_TO` con el número E.164 del dispatcher. Si los botones no están disponibles, el mismo mensaje incluye los dos comandos `APROBAR <código>` como respaldo.

## Configuración de producción

Define estas tres variables en el entorno de la API:

- `KAPSO_API_KEY`: API key del proyecto de Kapso.
- `KAPSO_PHONE_NUMBER_ID`: ID interno del número de WhatsApp en Kapso.
- `KAPSO_WEBHOOK_SECRET`: secreto único que se usará para firmar el webhook.
- `VOLTA_SELECTION_WHATSAPP_TO`: número E.164 del dispatcher que recibe las opciones de los mandates creados desde el dashboard.

El endpoint exige `X-Webhook-Signature` (HMAC SHA-256 sobre los bytes crudos), procesa solo `whatsapp.message.received` y deduplica con `X-Idempotency-Key`. Soporta el payload v2 individual y el payload v2 con buffering.

## Alta con la CLI

Tras autenticar y seleccionar el proyecto, identifica el número y registra el endpoint HTTPS público:

```bash
kapso login
kapso whatsapp numbers list
kapso whatsapp webhooks new \
  --phone-number-id "$KAPSO_PHONE_NUMBER_ID" \
  --url "https://<tu-dominio>/webhooks/kapso/whatsapp" \
  --event whatsapp.message.received \
  --secret-key "$KAPSO_WEBHOOK_SECRET" \
  --payload-version v2 \
  --active
```

Para mensajes consecutivos del mismo contacto, se puede habilitar buffering de cinco segundos agregando `--buffer-enabled --buffer-window-seconds 5 --max-buffer-size 10`. Kapso reintenta las entregas que no reciben 200; por eso el endpoint devuelve errores para fallos de procesamiento y no confirma silenciosamente una respuesta perdida.
