# Optuz CRM

CRM sobre WhatsApp con agente IA 24/7 para atender leads de Meta Ads y agendar citas de examen visual en las 5 sucursales.
Especificación completa: [docs/optuz-crm-spec.md](docs/optuz-crm-spec.md).

**Stack:** Next.js 16 (Vercel) · Supabase (Postgres + Auth + Realtime) · WhatsApp Cloud API de Meta (directa, sin intermediario) · Google Calendar · OpenAI (API Responses) para el agente.

## Cómo funciona

```
Meta Ads (CTWA) → WhatsApp → Meta ──webhook──▶ /api/webhooks/whatsapp
                                                  │ verifica X-Hub-Signature-256, deduplica por wamid, guarda lead/conversación/mensaje
                                                  ▼ (after: responde 200 a Meta primero)
                                           src/lib/agent  ── OpenAI + herramientas ──▶ Supabase / Google Calendar
                                                  │
                                                  ▼ envía por la Graph API (sender = bot)
Panel (inbox en vivo) ◀── Supabase Realtime ── el vendedor pausa el bot y escribe (sender = humano)
```

- **Webhook** — [src/app/api/webhooks/whatsapp/route.ts](src/app/api/webhooks/whatsapp/route.ts) (GET de verificación + POST) y [src/lib/whatsapp/](src/lib/whatsapp/) (firma, parser, envío).
- **Agente** — [src/lib/agent/](src/lib/agent/): prompt, herramientas (`set_branch`, `get_active_promotions`, `get_availability`, `next_available_slots`, `book_appointment`, `handoff_to_human`, `opt_out`, `my_appointments`, `cancel_appointment`, `send_options`, `promotions_optin`, `tag_lead`) y bucle con OpenAI ([llm.ts](src/lib/agent/llm.ts)). No tiene herramienta de precios a propósito.
- **Calendario** — [src/lib/appointments.ts](src/lib/appointments.ts) y [src/lib/google/](src/lib/google/). Horario: lunes a sábado 8:00–20:00, refrigerio 13:00–14:00.
- **Panel** — `/inbox`, `/leads`, `/citas`, `/promociones`, `/sucursales` (solo admin: **registrar sucursales nuevas**, corregir nombre y dirección, calendario, campañas de Meta y activar/desactivar). El agente lee nombre y dirección de las sucursales desde la base en cada conversación, así que un cambio en el panel se refleja al instante, sin tocar código.
- **Esquema y RLS** — [supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql).

## Funciones del panel

| Pantalla | Quién | Qué hace |
|---|---|---|
| **Resumen** `/dashboard` | todos | KPIs (leads, derivaciones, citas, conversión, % de respuestas del bot), mensajes por día, embudo y leads por sucursal |
| **Inbox** `/inbox` | todos | Chats en vivo con filtros (Mías / Sin asignar / Requieren humano / Resueltas) y búsqueda; asignar a un asesor; pausar/reactivar el bot; **marcar resuelta** (un mensaje nuevo del cliente la reabre); notas internas; respuestas rápidas escribiendo `/atajo`; ✓✓ de entrega; imágenes, notas de voz (transcritas) y documentos; resumen para el asesor y tiempo de espera; 👍/👎 sobre cada respuesta del bot |
| **Pipeline** `/pipeline` | todos | Tablero Kanban por etapa del lead; arrastrar tarjetas (o usar el selector en móvil) |
| **Contactos** `/leads` | todos | Búsqueda y filtros (estado, sucursal, etiqueta), alta manual, ficha editable (email, etiquetas, notas, baja), consentimientos, exportar CSV; el admin puede **unir duplicados** y eliminar los datos de un contacto |
| **Citas / Promociones** | todos / admin edita | Citas de examen visual y promociones vigentes |
| **Respuestas** `/respuestas` | admin | Atajos de mensajes para el equipo |
| **Conocimiento** `/conocimiento` | admin | Preguntas frecuentes y políticas que el agente usa al responder (sin precios) |
| **Sucursales** `/sucursales` | admin | Tarjetas con estado de agenda y anuncios de Meta y cifras por sucursal; registrar/editar en un diálogo (el agente las lee de la base) |
| **Tablero de leads** `/pipeline` | todos | Las cuatro etapas hacia la cita (**Nuevo · En seguimiento · Sin respuesta · Cita agendada**), más una columna **Requiere humano** que manda sobre las demás. Se llena solo: escribir devuelve el chat a seguimiento, 24 h sin contestar lo pasan a «Sin respuesta» y agendar lo lleva al objetivo. Lo que no pertenece al embudo se **archiva** |
| **Anuncios** `/anuncios` | admin | Leads y citas por anuncio de Click-to-WhatsApp, gasto anotado y costo por cita; estado del envío de conversiones a Meta |
| **Plantillas** `/plantillas` | admin | Plantillas de WhatsApp (estado en Meta): crear la de recordatorio de cita y sincronizar |
| **Sistema** `/sistema` | admin | Cola de tareas, corridas del agente (latencia, tokens, herramientas), tareas fallidas con «Reintentar», salud del número de WhatsApp, respuestas marcadas con 👎 |
| **Equipo** `/equipo` | admin | Las 1 o 2 personas que atienden el canal (es de citas): **asesor** (atiende chats y citas; por defecto de **todas** las sucursales, opcionalmente limitado a una) o **administrador** (además configura). Crear usuarios con generador de contraseña, cambiar rol/sucursal/contraseña; solo avisa si alguna sucursal no la cubre ningún asesor |

Un **asesor con sucursal** ve solo la suya (RLS en la base); un **asesor sin sucursal** y los **administradores** ven todas. Al derivar un chat a una persona se asigna al asesor de esa sucursal si lo hay y, si no, a uno que atienda todas (el que tenga menos chats pendientes). No hace falta un asesor por tienda.

La interfaz es CSS propio sin dependencias: los tokens (color, formas, sombras) están al inicio de [src/app/globals.css](src/app/globals.css) y hay modo oscuro automático. Los iconos son SVG propios ([src/components/icons.tsx](src/components/icons.tsx)).

## Tareas en segundo plano

Responder, reintentar, resumir derivaciones, seguimientos, recordatorios de cita, descarga de medios y avisos a Meta pasan por una **cola en Postgres**
(tabla `jobs`, [src/lib/jobs.ts](src/lib/jobs.ts) y [src/lib/job-handlers.ts](src/lib/job-handlers.ts)): si algo falla se reintenta (30 s, 2 min, 10 min) y, si se agota,
queda en **Sistema → Tareas fallidas** con botón «Reintentar» y la conversación pasa a «Requiere humano».

- **En local / servidor propio**: un temporizador interno ([src/instrumentation.ts](src/instrumentation.ts)) las ejecuta cada 20 s. `JOBS_TICKER=off` lo apaga.
- **En Vercel** (sin procesos permanentes) hace falta un **cron externo** que llame cada minuto a `POST https://<tu-dominio>/api/jobs/run` con la cabecera
  `x-cron-secret: <CRON_SECRET>`. Vercel Hobby solo admite cron diario; usa uno de estos:
  - *pg_cron + pg_net* en Supabase (SQL Editor, una vez):
    ```sql
    create extension if not exists pg_cron; create extension if not exists pg_net;
    select cron.schedule('optuz-jobs', '* * * * *', $$
      select net.http_post('https://<tu-dominio>/api/jobs/run', headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>'))
    $$);
    ```
  - o cualquier servicio de cron externo (cron-job.org, GitHub Actions programado…).
  Sin cron, las respuestas del bot igual se intentan al llegar cada mensaje, pero los reintentos, seguimientos y recordatorios no correrían. **Sistema** avisa cuando hay tareas atrasadas.
- Variables (todas opcionales salvo `CRON_SECRET` en la nube; ver [.env.example](.env.example)): `AGENT_DEBOUNCE_MS`, `FOLLOWUP_AFTER_MINUTES`, `RESEND_API_KEY` + `ALERT_EMAIL_FROM`,
  `OPENAI_TRANSCRIBE_MODEL`, `REMINDER_TEMPLATE`, `META_DATASET_ID`, `CAPI_EVENT_SCHEDULE`.

### Recordatorios, plantillas y anuncios

- Al agendar una cita se programan un recordatorio **24 h** y otro **2 h** antes. Dentro de las 24 h del último mensaje del cliente va como texto; fuera de ellas WhatsApp exige una **plantilla aprobada**:
  en **Plantillas** pulsa «Crear plantilla de recordatorio» (Meta la revisa en minutos u horas) y luego «Sincronizar con Meta». Sin plantilla aprobada, el recordatorio no se envía y el chat queda «Requiere humano».
- El cliente responde **1** (confirma), **2** (reprogramar: lo lleva el agente) o **3** (cancela); 1 y 3 se atienden sin llamar al modelo. También puede pedir cambiar o cancelar su cita escribiendo.
- **«Escribiendo…» y ritmo humano:** al llegar un mensaje que el bot va a contestar, se le marca como leído y se le muestra **«escribiendo…»**
  ([typing indicators](https://developers.facebook.com/documentation/business-messaging/whatsapp/typing-indicators): mismo endpoint, con `status: "read"`).
  El aviso dura 25 s o hasta que sale la respuesta, así que se renueva cuando el agente arranca. Y como no se puede acortar, lo que se ajusta es **cuándo se envía**:
  una respuesta larga tarda un poco más que un «sí» (`TYPING_CHARS_PER_SECOND`, entre `TYPING_MIN_MS` y `TYPING_MAX_MS`; `0` lo desactiva).
  El tiempo que tardó el modelo ya lo pasó el cliente viendo «escribiendo…», así que se descuenta.
- **Apagar el agente para todo el negocio:** en **Sistema** hay un interruptor. Apagado no sale **nada** automático hacia el cliente (ni respuestas, ni seguimientos, ni recordatorios de cita); los chats siguen llegando al inbox y los responde el equipo.
  Queda registrado quién lo apagó y por qué, y mientras tanto todo el panel muestra un aviso. Si la consulta del ajuste falla, el agente **sigue atendiendo**: quedarse mudo es peor que responder de más.
- **De dónde viene cada cliente:** `anuncio` se detecta solo (Meta manda el identificador); `redes_organico`, `cliente_antiguo`, `recomendado` y `otro` se anotan en la ficha. Se filtra en Contactos y se compara en Anuncios → «De dónde vienen».
  Además se guarda el **último** anuncio que trajo a un cliente que ya existía, para que una campaña de recuperación no pierda el crédito frente a la que lo captó la primera vez.
- **Cuántas citas por cliente:** un mismo número puede tener **3 citas próximas** a la vez (`MAX_ACTIVE_APPOINTMENTS`), para que pueda agendar también a un familiar. Al llegar al tope, el bot le dice qué citas tiene y le ofrece mover o cancelar una, en vez de crear otra.
  Además hay un tope de **3 citas creadas por día** (`MAX_APPOINTMENTS_PER_DAY`, 0 lo desactiva): quien lo alcanza pasa a «Requiere humano», por si está ocupando la agenda sin motivo. El límite vive en `bookAppointment`, así que también aplica si se agenda desde el panel.
- **Conversiones a Meta:** con `META_DATASET_ID` (conjunto de datos del Administrador de eventos), cada cita de un lead que llegó por anuncio envía el evento `Schedule` con su `ctwa_clid` para que Meta optimice hacia citas y no solo mensajes.
  Anota el gasto de cada anuncio en **Anuncios** para ver el costo por cita.

## Desarrollo local (recomendado para empezar)

Todo corre en tu máquina con Supabase local (Docker); la nube se usa solo al final. Las migraciones de
[supabase/migrations/](supabase/migrations/) son las mismas en ambos lados.

```bash
npm install
npm run db:start          # Supabase local (Docker Desktop encendido). Aplica migraciones y seed solos
npm run dev:users         # crea admin@optuz.local, huanuco@optuz.local y tocache@optuz.local (contraseña optuz-dev-123)
npm run dev               # http://localhost:3000  (o http://127.0.0.1:3000)
```

- `.env.local` ya apunta al Supabase local: API `http://127.0.0.1:55321`, Studio `http://127.0.0.1:55323`, correos de prueba en `:55324`.
  Los puertos son 553xx (no los 543xx por defecto) para convivir con otros proyectos de Supabase local.
- Cambiaste una migración: `npm run db:reset` la vuelve a aplicar desde cero (borra los datos locales **y los usuarios**: vuelve a correr `dev:users`).
- Para usuarios reales (local o nube): `npm run create-user -- --email a@b.com --password '…' --nombre 'Ana' --role admin`
  (asesor de todas las sucursales: `--role vendedor`; limitado a una: `--role vendedor --branch 'Huánuco'`).
- Meta necesita una URL pública para el webhook; en local usa un túnel (p. ej. `cloudflared tunnel --url http://localhost:3000`) o prueba con datos simulados (ver E2E).

### Pruebas

```bash
npm run typecheck && npm test      # unitarias (agente con OpenAI y base simulados, horarios, firma de Meta, parser del webhook…)
npm run test:e2e:safe                   # E2E completo, ver abajo
npm run test:live                  # comportamiento del agente con el modelo REAL de OpenAI (cuesta una fracción de centavo)
```

`npm run test:live` ([agent.live.ts](src/lib/agent/agent.live.ts)) usa tu `OPENAI_API_KEY` y `OPENAI_MODEL` con el prompt real y las 5 sucursales reales
(herramientas simuladas). Comprueba, entre otras cosas, que da la dirección exacta de cualquier sucursal sin inventarla, responde lo que el cliente preguntó
en vez de solo saludar, no da precios, consulta las promociones con la herramienta y deriva a un asesor cuando lo piden. Córrelo cada vez que cambies el
prompt o el modelo (`OPENAI_MODEL=gpt-5.6-luna npm run test:live` en Linux/macOS; en PowerShell: `$env:OPENAI_MODEL="gpt-5.6-luna"; npm run test:live`).

`npm run test:e2e:safe` (envoltorio de `npm run test:e2e` que **copia tus datos locales antes y los restaura exactos después**, aunque la prueba falle o se cuelgue) levanta la app, usa el Supabase local real, un navegador real (Edge; `E2E_BROWSER_CHANNEL=chrome` para Chrome)
y un servidor falso que hace de la Graph API de Meta y de la API de OpenAI. Cubre verificación y firma del webhook, webhook → agente → envío,
deduplicación, usuarios sin número (BSUID), entregas con varios mensajes, estados fallidos (131047), inbox en vivo (Realtime),
toma de control humana, notas, aislamiento entre sucursales, panel de admin (incluido registrar sucursales) y vista móvil. Necesita `npm run dev:users`
y que `npm run dev` **no** esté corriendo (Next permite un solo servidor de desarrollo por proyecto). Guarda capturas en `e2e/shots/`.

Como **vacía** las tablas de conversaciones, leads y promociones de la base local mientras corre, tiene tres protecciones: se niega a correr si
`NEXT_PUBLIC_SUPABASE_URL` no es local; **se niega si encuentra datos que no son suyos** (una conversación real de WhatsApp, una promoción que creaste)
salvo que uses `E2E_WIPE=1`; y al terminar deja la base como estaba (sin datos de prueba, con el calendario y las campañas originales de cada sucursal).

## Conectar WhatsApp (API de Meta)

Se usa la **WhatsApp Cloud API directamente** (sin proveedor intermedio). Las utilidades están en `npm run whatsapp -- <comando>` (lee `.env.local`).

1. **App de Meta.** En [developers.facebook.com](https://developers.facebook.com) → *Mis apps* → *Crear app* → tipo **Empresa** → asócialo a tu portafolio
   comercial de Meta → agrega el producto **WhatsApp**. Copia el **ID de la app** y la **clave secreta** (*Configuración → Básica*) a `META_APP_ID` y `META_APP_SECRET`.
2. **Número de prueba (gratis).** En *WhatsApp → Configuración de la API* Meta te da un WABA y un número de prueba, y te deja añadir unos pocos destinatarios
   verificados (según Meta, hasta 5). Sirve para probar TODO el flujo sin arriesgar un número real. Anota el **ID de la cuenta de WhatsApp Business** (`WHATSAPP_BUSINESS_ACCOUNT_ID`).
3. **Token permanente.** *Business Settings → Usuarios → Usuarios del sistema* → crea uno (Administrador) → asígnale la app y el WABA con control total →
   *Generar token* con los permisos `whatsapp_business_messaging`, `whatsapp_business_management` y `business_management`, sin vencimiento. Va en `WHATSAPP_ACCESS_TOKEN`.
   (El token temporal de 24 h del asistente sirve solo para una primera prueba.)
4. **ID del número.** `npm run whatsapp -- numbers` lista los números del WABA → el id largo (no el teléfono) va en `WHATSAPP_PHONE_NUMBER_ID`.
   `npm run whatsapp -- status` comprueba que el token y el id funcionan y muestra la calidad del número.
5. **Verify token.** `npm run whatsapp -- token` genera uno; va en `WHATSAPP_VERIFY_TOKEN` (ya hay uno generado en tu `.env.local`).
6. **URL pública del webhook:** `https://TU-DOMINIO/api/webhooks/whatsapp` (Vercel, o un túnel en local; ver arriba).
7. **Registrar el webhook.** O desde el panel de la app (*WhatsApp → Configuración → Webhook*: URL + verify token, y suscribir el campo **messages**),
   o por script (Meta verifica la URL al instante, así que la app debe estar en línea con las variables ya cargadas):
   ```bash
   npm run whatsapp -- webhook --url https://TU-DOMINIO/api/webhooks/whatsapp
   npm run whatsapp -- subscribe      # suscribe tu app a los eventos del WABA (sin esto no llegan mensajes)
   ```
8. **Probar de punta a punta.** `npm run whatsapp -- send --to 51999888777` (destinatario verificado) envía la plantilla `hello_world`.
   Responde desde ese WhatsApp: el mensaje debe aparecer en el inbox y el agente contestar (necesita `OPENAI_API_KEY`).
9. **Número real.** En *WhatsApp Manager → Números de teléfono* agrega el número (Meta lo verifica con un código por SMS o llamada). Debe ser un número
   **nuevo o que nunca estuvo en ninguna app de WhatsApp**. Haz también la **verificación del negocio** (Meta Business Suite → Centro de seguridad):
   sube los límites de mensajería y baja el riesgo de restricciones. Una cuenta nueva empieza en el nivel más bajo (250 contactos únicos por día).
10. **Modo Live.** Para recibir mensajes de clientes reales la app de Meta debe estar en modo **Live** (pide una URL de política de privacidad).
    Verifícalo en el panel de la app: en modo desarrollo solo llegan los mensajes de prueba.
11. **Anuncios Click-to-WhatsApp.** Activa *Atribución de anuncios* en los ajustes de la cuenta de WhatsApp Business: sin eso Meta no incluye el `referral`
    (`source_id`, `ctwa_clid`) y el CRM no puede detectar la sucursal por el anuncio.

## Conectar Google Calendar

El agente agenda citas en un **Google Calendar por sucursal**. Se conecta con una *cuenta de servicio* (un usuario "robot" de Google que tú autorizas calendario por calendario). No hace falta una cuenta de Google Workspace: sirve una cuenta Gmail normal.

**1. Crear el proyecto y la cuenta de servicio** (en [console.cloud.google.com](https://console.cloud.google.com), ~5 min)
1. Arriba a la izquierda, selector de proyecto → **Proyecto nuevo** (p. ej. «Caddyf CRM»).
2. Menú ☰ → **APIs y servicios → Biblioteca** → busca **Google Calendar API** → **Habilitar**.
3. Menú ☰ → **IAM y administración → Cuentas de servicio** → **Crear cuenta de servicio** (nombre: «crm-citas»; no hace falta asignarle roles).
4. Entra a la cuenta creada → pestaña **Claves** → **Agregar clave → Crear clave nueva → JSON**. Se descarga un archivo `.json`.
   - Si la opción de crear claves está bloqueada, tu organización tiene la política *iam.disableServiceAccountKeyCreation*; hay que quitarla en **IAM → Políticas de la organización**.

**2. Instalar la clave** (un comando; no copies nada a mano)
```bash
npm run google -- key "C:\Users\tu-usuario\Downloads\clave-descargada.json"
```
Escribe el correo y la clave privada en `.env.local` con el formato correcto (sin imprimirla) y te muestra el **correo de la cuenta de servicio** (`…@…iam.gserviceaccount.com`). Después **borra el .json descargado**. Reinicia `npm run dev` si estaba corriendo.

**3. Crear y compartir los calendarios** (en [calendar.google.com](https://calendar.google.com))
1. Crea un calendario por sucursal: **Otros calendarios → ＋ → Crear calendario nuevo** («Huánuco», «Tingo María», …).
2. En cada uno: ⋮ → **Configuración y uso compartido → Compartir con personas o grupos específicos → Agregar personas** → pega el correo de la cuenta de servicio y elige el permiso **«Hacer cambios en eventos»**. (Si eliges «Ver solo disponibilidad» el agente verá los huecos pero no podrá agendar.)
3. En la misma pantalla, sección **Integrar el calendario**, copia el **ID del calendario** (`xxxx@group.calendar.google.com`).
4. Zona horaria del calendario: **America/Lima**.

**4. Asignar cada ID a su sucursal y probar**
- En el panel: **Sucursales → Editar** en cada tarjeta → pega el ID → **Guardar**. Luego **Probar conexión** en la tarjeta: lee la disponibilidad y crea y borra un evento de prueba (verás «Prueba de conexión de Optuz CRM» un segundo).
- O todas a la vez desde la terminal: `npm run google -- check` (con `--no-write` solo lee; con `--only "Huánuco"` revisa una).
- Prueba completa de una cita real (horarios libres → agendar → evento en Google → doble reserva rechazada → cancelar): `npm run test:google`. Crea y BORRA una cita de prueba en Huánuco; no toca datos de clientes.

Si algo falla, el mensaje dice qué corregir. Los más comunes: *no encuentro ese calendario* (ID mal copiado o sin compartir), *se puede leer pero no escribir* (permiso equivocado) y *falta habilitar la API* (paso 1.2).

**Para Vercel:** copia `GOOGLE_SERVICE_ACCOUNT_EMAIL` y `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` de tu `.env.local` tal cual (la clave va en una sola línea con `\n` literales).

## Modelo del agente (OpenAI)

El agente usa la **API Responses** de OpenAI ([platform.openai.com](https://platform.openai.com) → *API keys*; se paga con crédito prepago, aparte de ChatGPT).
Se elige con `OPENAI_MODEL` en `.env.local`, sin tocar código:

| Modelo | Cuándo |
|---|---|
| `gpt-5.6-luna` | El más barato de la familia actual; razona. Buena opción para empezar. |
| `gpt-5.6-terra` | **Por defecto.** Equilibrio entre criterio y costo. |
| `gpt-5.6-sol` | El mejor criterio; para casos difíciles. |
| `gpt-4o-mini` | Muy barato pero sigue peor reglas complejas y **no razona** (el código lo maneja: no le manda `reasoning`). |

`OPENAI_REASONING_EFFORT` (`none`, `minimal`, `low`, `medium`, `high`) controla cuánto "piensa" un modelo de razonamiento antes de responder: más = mejor
criterio pero más lento y caro. Los precios cambian; revísalos en [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing).
Nota de privacidad: con la API Responses, OpenAI conserva las respuestas de cada corrida (hasta 30 días) para encadenar las llamadas de herramientas.

## Pasar a producción (Supabase en la nube)

1. Crea el proyecto en [supabase.com/dashboard](https://supabase.com/dashboard) (región South America / São Paulo) y guarda la contraseña de la base.
2. Enlaza y sube el esquema desde tu máquina:
   ```bash
   npx supabase login
   npx supabase link --project-ref <ref-del-proyecto>      # el <ref> está en la URL del dashboard
   npx supabase db push --dry-run                          # muestra qué se aplicará
   npx supabase db push --include-seed                     # aplica migraciones y carga las 5 sucursales
   ```
3. En *Authentication → Sign In / Providers*, desactiva **Allow new users to sign up**.
4. Pon en las variables de Vercel (no en git) la URL, la anon/publishable key y la service role/secret key **del proyecto en la nube**
   (*Project Settings → API Keys*) y crea tu admin con `npm run create-user` apuntando a esas claves, o desde el SQL Editor.
5. El resto de la puesta en marcha (WhatsApp, Google, Vercel) sigue abajo.

## Puesta en marcha completa

1. **Supabase** (si prefieres no usar el CLI: SQL Editor, pegar `0001_init.sql` y luego `seed.sql`). Crea el proyecto y ejecuta en el SQL Editor, en orden, [supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql) y [supabase/seed.sql](supabase/seed.sql).
2. **Primer administrador.** En Supabase → Authentication → Users crea tu usuario (correo + contraseña) y luego, en el SQL Editor:
   ```sql
   insert into users (id, nombre, email, role)
   select id, 'Tu nombre', email, 'admin' from auth.users where email = 'tu@correo.com';
   ```
   Para un asesor: `role = 'vendedor'`; con `branch_id` de su sucursal (`select id, nombre from branches;`) ve solo esa, y con `branch_id` nulo atiende todas.
3. **Google Calendar.** Sigue la guía de arriba («Conectar Google Calendar»): `npm run google -- key …` y `npm run google -- check`.
4. **Variables de entorno.** Copia [.env.example](.env.example) a `.env.local` y complétalo. En Vercel, las mismas variables en Project → Settings → Environment Variables (la clave privada con `\n` literales).
5. **WhatsApp.** Sigue "Conectar WhatsApp (API de Meta)" arriba.
6. **Panel → Sucursales.** Pega el ID de calendario de cada sucursal y los IDs de anuncio/campaña de Meta que la identifican.
7. **Panel → Promociones.** Crea las promociones vigentes; sin ellas, el agente dirá que no hay ninguna activa.

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck && npm test && npm run build
```

## Pendiente de verificar con datos reales

El parser sigue el formato documentado por Meta ([webhooks de la Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components),
[BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids)) y está cubierto por pruebas, pero nunca ha
recibido un mensaje real. Con el número de prueba, revisa (tabla `webhook_events` y el inbox):

- **Anuncios Click-to-WhatsApp:** el `referral` llega en el primer mensaje, solo con *Atribución de anuncios* activada. Confirma con un clic real
  en un anuncio que el lead queda con `ad_id` y sucursal.
- **Usuarios sin número:** desde 2026 Meta manda siempre `user_id` (BSUID) y puede omitir el teléfono si el cliente usa un usuario de WhatsApp.
  El lead se guarda por BSUID, el agente pide un teléfono de contacto al agendar y el envío usa `recipient` en vez de `to`
  (Meta lo admite desde julio de 2026; si tu cuenta aún no, verás el error en `webhook_events` y en el inbox).
- **Envío de texto libre:** solo dentro de las 24 h posteriores al último mensaje del cliente. Pasado ese plazo Meta responde `131047`: el agente
  marca la conversación como "Requiere humano" y el inbox avisa al asesor. Los recordatorios de cita usan una plantilla aprobada (ver arriba).
- **Multimedia:** las imágenes, notas de voz y documentos se descargan a un almacenamiento privado y se ven en el chat; las notas de voz se transcriben con el modelo y el agente responde sobre lo que dijo.
  El agente no analiza imágenes ni documentos: se los deja a un asesor.
- **No probado contra Meta real** (solo contra un simulador que sigue su documentación): la creación de plantillas (`POST /{waba}/message_templates`), los botones/listas interactivos,
  la descarga de medios y el evento de la API de Conversiones. Al conectar de verdad, revisa **Sistema** y `webhook_events`, y prueba cada uno con tu número.
- **Avisos por correo** del escalamiento: requieren `RESEND_API_KEY` y `ALERT_EMAIL_FROM` (sin ellos solo se avisa en el panel). No verificado contra Resend.
