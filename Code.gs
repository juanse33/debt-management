/**
 * BRASIL 2027 - Backend (Google Apps Script)
 *
 * Arquitectura: este script es la única fuente de verdad. Lee y escribe
 * directamente sobre las hojas de este Spreadsheet. Las hojas "Cuentas" y
 * "Pagos/Calendario" del planteamiento original NO se guardan como datos:
 * se calculan en caliente a partir de "Gastos" y "Viajeros" en cada
 * petición, para evitar que queden desincronizadas de los datos reales.
 *
 * Hojas que este script espera encontrar (ejecuta setupSheets() una vez
 * para crearlas/verificarlas automáticamente):
 *   - Viajeros:    NombreCorto | NombreCompleto | FechaNacimiento | Documento
 *   - Config:      Clave | Valor   (TRM_REFERENCIA, NOMBRE_VIAJE, ...)
 *   - Gastos:      ID | Fecha | Concepto | Categoria | Moneda | Monto | TRM |
 *                  MontoCOP | MontoUSD | Pago | Cuotas | FechaPrimerPago |
 *                  DiaPago | <una columna por cada NombreCorto de Viajeros>
 *   - Itinerario:  Dia | Fecha | Hora | Actividad | Lugar | Notas
 *   - Pendientes:  ID | Tarea | Responsable | Estado | FechaLimite
 */

const SHEETS = {
  VIAJEROS: 'Viajeros',
  CONFIG: 'Config',
  GASTOS: 'Gastos',
  ITINERARIO: 'Itinerario',
  PENDIENTES: 'Pendientes'
};

const GASTOS_FIXED_COLS = [
  'ID', 'Fecha', 'Concepto', 'Categoria', 'Moneda', 'Monto',
  'TRM', 'MontoCOP', 'MontoUSD', 'Pago', 'Cuotas', 'FechaPrimerPago', 'DiaPago'
];

const CATEGORIAS = ['Vuelos', 'Hospedaje', 'Transporte', 'Comida', 'Tomorrowland', 'Actividades', 'Otros'];

const VIAJEROS_SEED = [
  'Sebas', 'Mateo', 'Maria Alejandra', 'Juan Sebastián R.', 'Xiomara',
  'Yeimy', 'Juan José', 'Santiago', 'Stefanny'
];

// ID del Google Sheet que sirve de base de datos. Solo se usa si este script
// corre como proyecto independiente (no vinculado al Sheet); si lo pegaste
// dentro de Extensiones > Apps Script del propio Sheet, se ignora y se usa
// ese Sheet directamente.
const SPREADSHEET_ID = '1s6erboPxfc-WGpf-xlYKRXOCnbL6C-1auUEkJYpRidk';

function getSpreadsheet() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  return active || SpreadsheetApp.openById(SPREADSHEET_ID);
}

// ---------- Puntos de entrada del Web App ----------

function doGet(e) {
  return jsonResponse(buildPayload());
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    return jsonResponse({ error: 'El sistema está ocupado procesando otra solicitud, intenta de nuevo en unos segundos.' });
  }
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    const action = body.action;

    switch (action) {
      case 'addGasto':
        addGasto(body.payload || {});
        break;
      case 'updateConfig':
        updateConfig(body.payload || {});
        break;
      case 'togglePendiente':
        togglePendiente(body.payload || {});
        break;
      default:
        throw new Error('Acción no reconocida: ' + action);
    }

    return jsonResponse(buildPayload());
  } catch (err) {
    return jsonResponse({ error: err.message });
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Construcción del payload consolidado ----------

function buildPayload() {
  const ss = getSpreadsheet();
  const viajeros = readViajeros(ss);
  const config = readConfig(ss);
  const gastos = readGastos(ss);
  const pendientes = readPendientes(ss);
  const itinerario = readItinerario(ss);

  const calendario = computeCalendario(gastos, viajeros);
  const resumen = computeResumen(gastos, viajeros, config, calendario.general);

  return {
    viajeros: viajeros,
    categorias: CATEGORIAS,
    config: config,
    gastos: gastos,
    resumen: resumen,
    calendario: calendario,
    itinerario: itinerario,
    pendientes: pendientes
  };
}

// ---------- Lectura genérica de hojas ----------

function getSheet(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('No existe la hoja "' + name + '". Ejecuta setupSheets() desde el editor de Apps Script.');
  return sheet;
}

function sheetToObjects(sheet) {
  const range = sheet.getDataRange().getValues();
  if (range.length < 2) return [];
  const headers = range[0];
  return range.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
}

function formatDate(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value);
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

// ---------- Viajeros ----------

function readViajeros(ss) {
  const sheet = getSheet(ss, SHEETS.VIAJEROS);
  return sheetToObjects(sheet)
    .map(v => ({
      nombreCorto: String(v.NombreCorto || '').trim(),
      nombreCompleto: v.NombreCompleto || '',
      fechaNacimiento: formatDate(v.FechaNacimiento),
      documento: v.Documento || ''
    }))
    .filter(v => v.nombreCorto);
}

// ---------- Config (TRM de referencia, nombre del viaje, etc.) ----------

function readConfig(ss) {
  const sheet = getSheet(ss, SHEETS.CONFIG);
  const config = {};
  sheetToObjects(sheet).forEach(r => { config[r.Clave] = r.Valor; });
  config.TRM_REFERENCIA = Number(config.TRM_REFERENCIA) || 4000;
  return config;
}

function updateConfig(payload) {
  const ss = getSpreadsheet();
  const sheet = getSheet(ss, SHEETS.CONFIG);
  const data = sheet.getDataRange().getValues();
  const clave = payload.clave;
  const valor = payload.valor;
  if (!clave) throw new Error('Falta la clave de configuración a actualizar.');

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === clave) {
      sheet.getRange(i + 1, 2).setValue(valor);
      return;
    }
  }
  sheet.appendRow([clave, valor]);
}

// ---------- Gastos ----------

function readGastos(ss) {
  const sheet = getSheet(ss, SHEETS.GASTOS);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0];
  const participantCols = headers.slice(GASTOS_FIXED_COLS.length);

  return data.slice(1)
    .filter(row => row[0] !== '' && row[0] !== null)
    .map(row => {
      const g = {};
      GASTOS_FIXED_COLS.forEach((h, i) => { g[h] = row[i]; });

      const participantes = [];
      participantCols.forEach((nombre, idx) => {
        const cell = row[GASTOS_FIXED_COLS.length + idx];
        if (String(cell).trim().toUpperCase() === 'X') participantes.push(nombre);
      });

      return {
        id: g.ID,
        fecha: formatDate(g.Fecha),
        concepto: g.Concepto,
        categoria: g.Categoria,
        moneda: g.Moneda,
        monto: Number(g.Monto) || 0,
        trm: Number(g.TRM) || 0,
        montoCOP: Number(g.MontoCOP) || 0,
        montoUSD: Number(g.MontoUSD) || 0,
        pago: g.Pago,
        cuotas: Number(g.Cuotas) || 1,
        fechaPrimerPago: formatDate(g.FechaPrimerPago),
        diaPago: g.DiaPago,
        participantes: participantes
      };
    });
}

function addGasto(p) {
  if (!p.concepto) throw new Error('El gasto necesita un concepto.');
  if (!p.pago) throw new Error('El gasto necesita indicar quién pagó.');
  if (!p.participantes || !p.participantes.length) throw new Error('El gasto necesita al menos un participante.');

  const ss = getSpreadsheet();
  const sheet = getSheet(ss, SHEETS.GASTOS);
  const headers = sheet.getDataRange().getValues()[0];
  const participantCols = headers.slice(GASTOS_FIXED_COLS.length);

  const moneda = p.moneda === 'USD' ? 'USD' : 'COP';
  const monto = Number(p.monto) || 0;
  const trm = Number(p.trm) || 0;

  let montoCOP, montoUSD;
  if (moneda === 'USD') {
    montoUSD = monto;
    montoCOP = Math.round(monto * trm);
  } else {
    montoCOP = monto;
    montoUSD = trm > 0 ? round2(monto / trm) : 0;
  }

  const participantesSet = new Set(p.participantes);
  const id = 'G' + new Date().getTime();

  const row = [
    id, p.fecha, p.concepto, p.categoria, moneda, monto,
    trm, montoCOP, montoUSD, p.pago, Number(p.cuotas) || 1,
    p.fechaPrimerPago || p.fecha, p.diaPago || ''
  ];
  participantCols.forEach(nombre => row.push(participantesSet.has(nombre) ? 'X' : ''));

  sheet.appendRow(row);
}

// ---------- Pendientes ----------

function readPendientes(ss) {
  const sheet = getSheet(ss, SHEETS.PENDIENTES);
  return sheetToObjects(sheet).map(r => ({
    id: r.ID,
    tarea: r.Tarea,
    responsable: r.Responsable,
    estado: r.Estado || 'Pendiente',
    fechaLimite: formatDate(r.FechaLimite)
  }));
}

function togglePendiente(p) {
  if (!p.id) throw new Error('Falta el id del pendiente.');
  const ss = getSpreadsheet();
  const sheet = getSheet(ss, SHEETS.PENDIENTES);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.id)) {
      const actual = data[i][3];
      sheet.getRange(i + 1, 4).setValue(actual === 'Hecho' ? 'Pendiente' : 'Hecho');
      return;
    }
  }
  throw new Error('No se encontró el pendiente con id ' + p.id);
}

// ---------- Itinerario ----------

function readItinerario(ss) {
  const sheet = getSheet(ss, SHEETS.ITINERARIO);
  return sheetToObjects(sheet).map(r => ({
    dia: r.Dia,
    fecha: formatDate(r.Fecha),
    hora: r.Hora,
    actividad: r.Actividad,
    lugar: r.Lugar,
    notas: r.Notas
  }));
}

// ---------- Cálculos: resumen de saldos y algoritmo "saldar cuentas" ----------

function computeResumen(gastos, viajeros, config, calendarioGeneral) {
  const porViajero = {};
  viajeros.forEach(v => {
    porViajero[v.nombreCorto] = { nombreCorto: v.nombreCorto, pago: 0, leTocaba: 0 };
  });

  let totalCOP = 0;

  gastos.forEach(g => {
    totalCOP += g.montoCOP;
    if (porViajero[g.pago]) porViajero[g.pago].pago += g.montoCOP;

    const n = g.participantes.length;
    if (n === 0) return;
    const share = g.montoCOP / n;
    g.participantes.forEach(nombre => {
      if (porViajero[nombre]) porViajero[nombre].leTocaba += share;
    });
  });

  const porViajeroArr = Object.values(porViajero).map(v => {
    const saldo = v.pago - v.leTocaba;
    return {
      nombreCorto: v.nombreCorto,
      pago: round2(v.pago),
      leTocaba: round2(v.leTocaba),
      saldo: round2(saldo),
      estado: saldo >= 0 ? 'Le deben' : 'Debe'
    };
  });

  const numPersonas = viajeros.length || 1;
  const trm = config.TRM_REFERENCIA || 4000;
  const hoy = formatDate(new Date());
  const proximoVencimiento = calendarioGeneral
    .map(c => c.fecha)
    .filter(f => f >= hoy)
    .sort()[0] || null;

  return {
    totalCOP: round2(totalCOP),
    totalUSD: round2(totalCOP / trm),
    promedioCOP: round2(totalCOP / numPersonas),
    promedioUSD: round2(totalCOP / numPersonas / trm),
    proximoVencimiento: proximoVencimiento,
    porViajero: porViajeroArr,
    saldar: computeSaldar(porViajeroArr),
    deudasPorGasto: computeDeudasPorGasto(gastos)
  };
}

// Deuda de cada gasto, individual y sin netear contra otros gastos:
// cada participante (menos quien pagó) le debe su parte exacta al pagador.
function computeDeudasPorGasto(gastos) {
  const detalle = [];
  gastos.forEach(g => {
    const n = g.participantes.length;
    if (n === 0) return;
    const shareCOP = round2(g.montoCOP / n);
    const shareUSD = round2(g.montoUSD / n);
    g.participantes.forEach(nombre => {
      if (nombre === g.pago) return;
      detalle.push({
        gastoId: g.id,
        concepto: g.concepto,
        de: nombre,
        para: g.pago,
        montoCOP: shareCOP,
        montoUSD: shareUSD
      });
    });
  });
  return detalle;
}

function computeSaldar(porViajeroArr) {
  const deudores = [];
  const acreedores = [];
  porViajeroArr.forEach(v => {
    if (v.saldo < -1) deudores.push({ nombre: v.nombreCorto, monto: -v.saldo });
    else if (v.saldo > 1) acreedores.push({ nombre: v.nombreCorto, monto: v.saldo });
  });
  deudores.sort((a, b) => b.monto - a.monto);
  acreedores.sort((a, b) => b.monto - a.monto);

  const transacciones = [];
  let i = 0, j = 0;
  while (i < deudores.length && j < acreedores.length) {
    const d = deudores[i];
    const a = acreedores[j];
    const monto = Math.min(d.monto, a.monto);
    transacciones.push({ de: d.nombre, para: a.nombre, monto: round2(monto) });
    d.monto -= monto;
    a.monto -= monto;
    if (d.monto <= 1) i++;
    if (a.monto <= 1) j++;
  }
  return transacciones;
}

// ---------- Cálculos: calendario de cuotas ----------

function computeCalendario(gastos, viajeros) {
  const porViajero = {};
  viajeros.forEach(v => { porViajero[v.nombreCorto] = []; });
  const general = [];

  gastos.forEach(g => {
    const cuotas = g.cuotas || 1;
    const n = g.participantes.length;
    if (n === 0 || cuotas < 1) return;

    const montoCuotaTotal = g.montoCOP / cuotas;
    const montoCuotaUSDTotal = g.montoUSD / cuotas;
    const montoCuotaPorPersona = montoCuotaTotal / n;
    const montoCuotaUSDPorPersona = montoCuotaUSDTotal / n;
    const fechaBase = g.fechaPrimerPago ? new Date(g.fechaPrimerPago) : new Date(g.fecha);

    for (let c = 0; c < cuotas; c++) {
      const fecha = new Date(fechaBase);
      fecha.setMonth(fecha.getMonth() + c);
      if (g.diaPago) fecha.setDate(Number(g.diaPago));
      const fechaStr = formatDate(fecha);

      general.push({
        gastoId: g.id,
        concepto: g.concepto,
        fecha: fechaStr,
        numeroCuota: c + 1,
        totalCuotas: cuotas,
        montoCOP: round2(montoCuotaTotal),
        montoUSD: round2(montoCuotaUSDTotal),
        participantes: g.participantes
      });

      g.participantes.forEach(nombre => {
        if (!porViajero[nombre]) return;
        porViajero[nombre].push({
          gastoId: g.id,
          concepto: g.concepto,
          fecha: fechaStr,
          numeroCuota: c + 1,
          totalCuotas: cuotas,
          montoCOP: round2(montoCuotaPorPersona),
          montoUSD: round2(montoCuotaUSDPorPersona)
        });
      });
    }
  });

  Object.keys(porViajero).forEach(nombre => {
    porViajero[nombre].sort((a, b) => a.fecha.localeCompare(b.fecha));
  });
  general.sort((a, b) => a.fecha.localeCompare(b.fecha));

  return { general: general, porViajero: porViajero };
}

// ---------- Setup inicial (ejecutar una sola vez desde el editor) ----------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Brasil 2027')
    .addItem('Configurar hojas (setup)', 'setupSheets')
    .addToUi();
}

function setupSheets() {
  const ss = getSpreadsheet();

  ensureSheet(ss, SHEETS.VIAJEROS, ['NombreCorto', 'NombreCompleto', 'FechaNacimiento', 'Documento']);
  ensureSheet(ss, SHEETS.CONFIG, ['Clave', 'Valor']);
  ensureSheet(ss, SHEETS.GASTOS, GASTOS_FIXED_COLS.concat(VIAJEROS_SEED));
  ensureSheet(ss, SHEETS.ITINERARIO, ['Dia', 'Fecha', 'Hora', 'Actividad', 'Lugar', 'Notas']);
  ensureSheet(ss, SHEETS.PENDIENTES, ['ID', 'Tarea', 'Responsable', 'Estado', 'FechaLimite']);

  const viajerosSheet = ss.getSheetByName(SHEETS.VIAJEROS);
  if (viajerosSheet.getDataRange().getNumRows() < 2) {
    VIAJEROS_SEED.forEach(nombre => viajerosSheet.appendRow([nombre, nombre, '', '']));
  }

  const configSheet = ss.getSheetByName(SHEETS.CONFIG);
  if (configSheet.getDataRange().getNumRows() < 2) {
    configSheet.appendRow(['TRM_REFERENCIA', 4000]);
    configSheet.appendRow(['NOMBRE_VIAJE', 'Brasil 2027']);
  }

  const mensaje = 'Listo. Hojas creadas/verificadas correctamente.';
  try {
    SpreadsheetApp.getUi().alert(mensaje);
  } catch (e) {
    Logger.log(mensaje);
  }
}

function ensureSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (firstRow.join('') === '') {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
