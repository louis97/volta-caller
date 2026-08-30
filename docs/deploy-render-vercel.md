# Despliegue de Volta: API en Render + frontend en Vercel (SSE vía proxy)

## 1. Render CLI

Windows (ya instalado en esta máquina):

```powershell
$env:Path += ";$env:LOCALAPPDATA\Programs\render"
render --version
```

Si no está instalado:

```powershell
curl.exe -L -o "$env:TEMP\render-cli.zip" "https://github.com/render-oss/cli/releases/download/v2.25.0/cli_2.25.0_windows_amd64.zip"
Expand-Archive -Path "$env:TEMP\render-cli.zip" -DestinationPath "$env:LOCALAPPDATA\Programs\render" -Force
```

## 2. Autenticación

```powershell
render login
```

Alternativa CI/CD: exporta `RENDER_API_KEY` desde el dashboard de Render.

## 3. Validar blueprint

```powershell
cd volta-caller
render blueprints validate render.yaml
```

## 4. Crear el servicio web en Render

Con el repo conectado en GitHub:

```powershell
render services create `
  --name volta-api `
  --type web_service `
  --runtime node `
  --region virginia `
  --plan free `
  --repo https://github.com/louis97/volta-caller `
  --branch main `
  --build-command "npm ci" `
  --start-command "npm run start:api" `
  --health-check-path /health `
  --output json
```

O aplica el blueprint desde el dashboard: **New > Blueprint** y selecciona el repo con `render.yaml`.

Durante el setup, Render pedirá los secretos marcados con `sync: false` (Twilio, OpenAI, Supabase, etc.).

`PUBLIC_BASE_URL` y `PUBLIC_WS_URL` se derivan automáticamente de `RENDER_EXTERNAL_URL` en runtime.

## 5. Vercel (frontend + proxy SSE)

Root directory del proyecto en Vercel: `frontend`.

Variables de entorno en Vercel:

| Variable | Valor |
| --- | --- |
| `VOLTA_API_URL` | `https://volta-api-jkax.onrender.com` |
| `VOLTA_ORGANIZATION_ID` | `textiles-pacifico` |
| `VOLTA_DASHBOARD_USER_ID` | `volta-dashboard` |

El frontend abre `EventSource("/api/events")` en el mismo dominio de Vercel. La ruta
`frontend/app/api/[...path]/route.ts` reenvía el stream SSE al backend en Render e inyecta
`x-volta-org-id` / `x-volta-user-id`.

## 6. Verificación

```powershell
curl https://volta-api-jkax.onrender.com/health
curl -N -H "x-volta-org-id: textiles-pacifico" -H "x-volta-user-id: volta-dashboard" https://TU-DOMINIO.vercel.app/api/events
```

Deberías ver líneas `retry:` y heartbeats `: ping`.

## 7. Twilio

Actualiza los webhooks de Twilio para apuntar a la URL de Render:

- Voice webhook: `https://volta-api-jkax.onrender.com/...`
- Media stream WebSocket: `wss://volta-api-jkax.onrender.com/...`
