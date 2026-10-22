# Brasil 2027 — App de gastos, cuotas y logística

SPA (`index.html`) + backend en Google Apps Script (`Code.gs`) que lee y
escribe directamente sobre un Google Sheet. No hay base de datos aparte:
el Sheet **es** la base de datos.

## Decisión de arquitectura: qué se guarda y qué se calcula

Se guardan solo 5 hojas: **Viajeros**, **Config**, **Gastos**, **Itinerario**,
**Pendientes**. Las pestañas "Cuentas" (saldos) y "Pagos/Calendario" (cuotas)
del planteamiento original **no se guardan**: `Code.gs` las calcula en cada
petición a partir de `Gastos` + `Viajeros`. Esto evita que un Sheet quede
desincronizado del otro (el problema típico de mantener un resumen a mano).
La TRM por USD también vive en cada fila de `Gastos` (lo que ya cobró ese
pago puntual) más una `TRM_REFERENCIA` global en `Config` (para mostrar
totales agregados convertidos entre COP y USD).

## Paso 1 — Crear el Google Sheet y el proyecto de Apps Script

1. Crea un Google Sheet nuevo (el nombre no importa), por ejemplo "Brasil 2027 - Datos".
2. Dentro del Sheet: `Extensiones` → `Apps Script`.
3. Borra el contenido de `Code.gs` que viene por defecto y pega el contenido
   de [`Code.gs`](Code.gs) de esta carpeta.
4. Guarda (Ctrl+S / ícono de disquete). Ponle un nombre al proyecto, p. ej. "Brasil 2027 Backend".

## Paso 2 — Crear las hojas automáticamente

1. Vuelve al Google Sheet (recarga la pestaña del navegador si ya la tenías abierta).
2. Debería aparecer un nuevo menú **"Brasil 2027"** en la barra superior
   (junto a Archivo, Edición, etc.). Si no aparece, recarga la página.
3. Click en **Brasil 2027 → Configurar hojas (setup)**.
4. La primera vez te pedirá autorizar el script (es tu propio script, dale
   "Avanzado" → "Ir a ... (no seguro)" → "Permitir" si Google muestra la
   advertencia estándar de scripts no verificados).
5. Esto crea las 5 hojas con sus encabezados correctos y siembra la hoja
   `Viajeros` con los 9 integrantes y la hoja `Config` con una TRM de
   referencia inicial (4000).

Después de esto puedes completar a mano:
- `Viajeros`: fecha de nacimiento y documento de cada quien.
- `Itinerario`: tus actividades por día.
- `Pendientes`: tareas iniciales (la app también permite marcarlas como
  hechas, pero agregarlas nuevas se hace directamente en el Sheet).

Los gastos **no los llenes a mano** en la hoja `Gastos`: usa el botón
"Nuevo gasto" de la app, porque el backend necesita calcular `MontoCOP`,
`MontoUSD` y las columnas X de participantes de forma consistente.

## Paso 3 — Publicar el script como Web App

1. En el editor de Apps Script: botón **Implementar** (Deploy) → **Nueva implementación**.
2. Tipo: selecciona el ícono de engranaje → **Aplicación web**.
3. Configuración:
   - **Descripción**: "Brasil 2027 API" (o lo que quieras).
   - **Ejecutar como**: *Yo (tu correo)*.
   - **Quién tiene acceso**: **Cualquier usuario** (`Anyone`) — así tus 8
     compañeros de viaje pueden usar la app sin tener que iniciar sesión
     ni pedir permisos individuales.
4. Click **Implementar**. Google te pedirá autorizar de nuevo la primera vez.
5. Copia la **URL de la aplicación web** que te entrega (termina en `/exec`).
   Esa es la URL que necesitas para el Paso 4.

> Cada vez que vuelvas a cambiar `Code.gs`, debes crear una **nueva
> implementación** (o editar la existente desde "Gestionar implementaciones"
> y publicar una nueva versión) para que los cambios se reflejen en la URL
> publicada.

## Paso 4 — Conectar el frontend

1. Abre [`index.html`](index.html) con un editor de texto.
2. Busca, cerca del final del archivo, dentro de la etiqueta `<script>`:

   ```js
   const CONFIG = {
     SCRIPT_URL: 'PEGA_AQUI_LA_URL_DE_TU_WEB_APP'
   };
   ```

3. Reemplaza el valor por la URL que copiaste en el Paso 3:

   ```js
   const CONFIG = {
     SCRIPT_URL: 'https://script.google.com/macros/s/AKfycb.../exec'
   };
   ```

4. Guarda el archivo.

## Paso 5 — Usar la app

`index.html` es un archivo estático: no necesita un servidor propio.
Opciones para compartirlo con el grupo:

- **Más simple**: súbelo a Google Drive (o cualquier almacenamiento) y que
  cada quien lo descargue y lo abra localmente (doble clic abre el archivo
  en el navegador).
- **Recomendado para compartir por link**: súbelo a un hosting estático
  gratuito como GitHub Pages, Netlify o Vercel. Así todos entran con una
  sola URL, sin descargar nada, y puedes actualizar el archivo cuando
  quieras sin reenviarlo.

La app funciona igual en cualquiera de los dos casos: el único requisito es
que `CONFIG.SCRIPT_URL` apunte a tu Web App publicada.

## Notas técnicas

- **CORS**: las peticiones `POST` desde el frontend se mandan sin la
  cabecera `Content-Type: application/json` a propósito (el `fetch` usa
  `text/plain` por defecto al mandar un string). Apps Script no responde
  bien a las peticiones *preflight* (`OPTIONS`) que exige el navegador
  cuando sí se declara `application/json`, así que este es el workaround
  estándar para hablar con un Web App de Apps Script desde JS puro.
- **Concurrencia**: `doPost` usa `LockService.getScriptLock()` para que dos
  personas no registren un gasto exactamente al mismo tiempo y se pisen los
  datos.
- **Multi-moneda**: cada gasto guarda su propio `Moneda`, `Monto` y `TRM`
  aplicada en el momento de registrarlo, más `MontoCOP` y `MontoUSD` ya
  calculados. Los saldos y el "saldar cuentas" siempre se calculan en COP
  internamente; el toggle COP/USD del header solo cambia cómo se *muestran*
  los totales (usando `TRM_REFERENCIA`).
- **Algoritmo "Saldar cuentas"**: es un algoritmo greedy clásico de
  liquidación de deudas — empareja al mayor deudor con el mayor acreedor
  repetidamente, minimizando el número de transferencias necesarias para
  dejar al grupo en ceros.
