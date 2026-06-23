var SPREADSHEET_ID = '11v8cSAItQBNWiLg4QCgFb3dVKlZwNQUt2Y6ojmjyHOg';
var SHEET_NAME = 'Treatment Master';
var INVENTORY_SHEET_NAME = 'Inventory Movements Master';
var SCHEDULE_SHEET_NAME = 'Treatment Schedule Master';
var ROUTINGS_SHEET_NAME = 'Routings Master';
var ALLOCATION_TO_STACK_SHEET_NAME = 'Allocation to Stack';
var PMF_SPREADSHEET_ID = '1tqfKhQVOu0xl00isogq8FYQwIlSMDuRjD39o8FYUtEs';
var PMF_SHEET_NAME = 'PMF Associated Data';
var BRIDGE_VERSION = '2026-06-23-allocation-stack-v1';
var SHEET_GID = 115405406;
var MAX_TREATMENT_ROWS = 12000;
var MAX_INVENTORY_ROWS = 12000;
var MAX_SCHEDULE_ROWS = 12000;
var MAX_ROUTING_ROWS = 15000;
var MAX_ALLOCATION_ROWS = 20000;
var POLE_AVG_CHARGE_M3 = 38;
var ROUTING_DEFAULT_SHIFT_HOURS = 8;

function doGet(e) {
  var callback = e && e.parameter && e.parameter.callback;
  var action = e && e.parameter && String(e.parameter.action || '');
  if (action) {
    return writeJsonResponse_(handleLiveAction_(e.parameter), callback);
  }
  var includeInventory = e && e.parameter && String(e.parameter.includeInventory || '') === '1';
  var includeAllocationToStack = e && e.parameter && String(e.parameter.includeAllocationToStack || '') === '1';
  var includeProductMaster = e && e.parameter && String(e.parameter.includeProductMaster || '') === '1';
  var cacheKey = (includeInventory ? 'creosote_bridge_inventory_v28' : 'creosote_bridge_treatment_v28') +
    (includeAllocationToStack ? '_alloc' : '') +
    (includeProductMaster ? '_pmf' : '');
  var body = getCachedResponseText_(cacheKey);
  if (!body) {
    var output = buildResponse_(includeInventory, includeAllocationToStack, includeProductMaster);
    body = JSON.stringify(output);
    if (output && output.ok && (includeInventory || output.chargeCount > 0 || output.unassignedCount > 0)) putCachedResponseText_(cacheKey, body, 300);
  }
  var mimeType = ContentService.MimeType.JSON;

  if (callback) {
    body = callback + '(' + body + ');';
    mimeType = ContentService.MimeType.JAVASCRIPT;
  }

  return ContentService.createTextOutput(body).setMimeType(mimeType);
}

function writeJsonResponse_(payload, callback) {
  var body = JSON.stringify(payload);
  var mimeType = ContentService.MimeType.JSON;
  if (callback) {
    body = callback + '(' + body + ');';
    mimeType = ContentService.MimeType.JAVASCRIPT;
  }
  return ContentService.createTextOutput(body).setMimeType(mimeType);
}

function handleLiveAction_(params) {
  try {
    var action = String(params.action || '');
    if (action === 'getLiveState') return getLiveState_();
    if (action === 'saveActual') return saveLiveEntry_('actuals', params.key, params.value);
    if (action === 'deleteActual') return deleteLiveEntry_('actuals', params.key);
    if (action === 'saveGap') return saveLiveEntry_('gaps', params.key, params.value);
    if (action === 'deleteGap') return deleteLiveEntry_('gaps', params.key);
    if (action === 'clearPlant') return clearPlantLiveState_(params.day, params.pid);
    if (action === 'clearAllLive') return clearAllLiveState_();
    if (action === 'inspectRoutings') return inspectRoutings_(params);
    return { ok: false, error: 'Unknown live action: ' + action };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function getLiveState_() {
  var props = PropertiesService.getScriptProperties();
  var actuals = parseLiveJson_(props.getProperty('creosote_live_actuals'), {});
  var gaps = parseLiveJson_(props.getProperty('creosote_live_gaps'), {});
  var actualsPruned = pruneLiveStateToCurrentWeek_(actuals);
  var gapsPruned = pruneLiveStateToCurrentWeek_(gaps);
  var pruned = actualsPruned || gapsPruned;
  if (pruned) {
    props.setProperty('creosote_live_actuals', JSON.stringify(actuals));
    props.setProperty('creosote_live_gaps', JSON.stringify(gaps));
    props.setProperty('creosote_live_updated_at', new Date().toISOString());
  }
  return {
    ok: true,
    actuals: actuals,
    gaps: gaps,
    updatedAt: props.getProperty('creosote_live_updated_at') || '',
    serverTime: new Date().toISOString()
  };
}

function pruneLiveStateToCurrentWeek_(data) {
  var allowed = currentWeekIsoDateMap_();
  var changed = false;
  Object.keys(data || {}).forEach(function (key) {
    var entry = data[key];
    if (!entry || !allowed[String(entry.actualDate || '')]) {
      delete data[key];
      changed = true;
    }
  });
  return changed;
}

function currentWeekIsoDateMap_() {
  var now = new Date();
  var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  var out = {};
  for (var i = 0; i < 7; i++) {
    var d = new Date(monday);
    d.setDate(monday.getDate() + i);
    out[formatIsoDate_(d)] = true;
  }
  return out;
}

function formatIsoDate_(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function saveLiveEntry_(bucket, key, value) {
  if (!key) throw new Error('Missing live state key');
  var props = PropertiesService.getScriptProperties();
  var propName = bucket === 'gaps' ? 'creosote_live_gaps' : 'creosote_live_actuals';
  var data = parseLiveJson_(props.getProperty(propName), {});
  data[String(key)] = parseLiveJson_(value, {});
  props.setProperty(propName, JSON.stringify(data));
  props.setProperty('creosote_live_updated_at', new Date().toISOString());
  return getLiveState_();
}

function deleteLiveEntry_(bucket, key) {
  if (!key) throw new Error('Missing live state key');
  var props = PropertiesService.getScriptProperties();
  var propName = bucket === 'gaps' ? 'creosote_live_gaps' : 'creosote_live_actuals';
  var data = parseLiveJson_(props.getProperty(propName), {});
  delete data[String(key)];
  props.setProperty(propName, JSON.stringify(data));
  props.setProperty('creosote_live_updated_at', new Date().toISOString());
  return getLiveState_();
}

function clearPlantLiveState_(day, pid) {
  var d = String(day);
  var p = String(pid || '');
  var props = PropertiesService.getScriptProperties();
  var actuals = parseLiveJson_(props.getProperty('creosote_live_actuals'), {});
  var gaps = parseLiveJson_(props.getProperty('creosote_live_gaps'), {});
  Object.keys(actuals).forEach(function (key) {
    if (key.indexOf(d + '_' + p + '_') === 0) delete actuals[key];
  });
  Object.keys(gaps).forEach(function (key) {
    if (key.indexOf(d + '_' + p + '_gap') === 0) delete gaps[key];
  });
  props.setProperty('creosote_live_actuals', JSON.stringify(actuals));
  props.setProperty('creosote_live_gaps', JSON.stringify(gaps));
  props.setProperty('creosote_live_updated_at', new Date().toISOString());
  return getLiveState_();
}

function clearAllLiveState_() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('creosote_live_actuals');
  props.deleteProperty('creosote_live_gaps');
  props.setProperty('creosote_live_updated_at', new Date().toISOString());
  return getLiveState_();
}

function parseLiveJson_(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(String(raw));
  } catch (err) {
    return fallback;
  }
}

function inspectRoutings_(params) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = getSheetByFlexibleName_(ss, ROUTINGS_SHEET_NAME, ['routings', 'master']);
  if (!sheet) return { ok: false, error: 'Routings Master tab not found' };
  var lastRow = sheet.getLastRow();
  var lastCol = Math.min(sheet.getLastColumn(), 60);
  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h); });
  var startKey = String(params.start || '2026-05-25');
  var endKey = String(params.end || '2026-05-31');
  var shedFilter = String(params.shed || '').toLowerCase().trim();
  var maxRows = Math.min(250, Math.max(20, Number(params.limit) || 120));
  var rowCount = Math.min(Math.max(0, lastRow - 1), MAX_ROUTING_ROWS);
  var startDataRow = Math.max(2, lastRow - rowCount + 1);
  var data = sheet.getRange(startDataRow, 1, rowCount, lastCol).getDisplayValues();
  var rows = [];
  for (var r = 0; r < data.length && rows.length < maxRows; r++) {
    var row = data[r];
    var dayKey = normalizeDateKey_(row[4]);
    var shed = normalizeShed_(row[8]);
    if (dayKey < startKey || dayKey > endKey) continue;
    if (shedFilter && String(shed).toLowerCase().indexOf(shedFilter) < 0) continue;
    rows.push({
      rowNumber: startDataRow + r,
      dayKey: dayKey,
      A: row[0], B: row[1], C: row[2], D: row[3], E: row[4],
      F: row[5], G: row[6], H: row[7], I: row[8], J: row[9],
      K: row[10], L: row[11], M: row[12], N: row[13], O: row[14],
      P: row[15], Q: row[16], R: row[17], S: row[18], T: row[19],
      U: row[20], V: row[21], W: row[22], X: row[23], Y: row[24], Z: row[25],
      AA: row[26], AB: row[27], AC: row[28], AD: row[29]
    });
  }
  return {
    ok: true,
    bridgeVersion: BRIDGE_VERSION,
    sheetName: sheet.getName(),
    lastRow: lastRow,
    headers: headers.map(function (h, i) { return { column: columnName_(i + 1), index: i, header: h }; }),
    start: startKey,
    end: endKey,
    shed: shedFilter,
    rows: rows
  };
}

function getCachedResponseText_(key) {
  var cache = CacheService.getScriptCache();
  var metaRaw = cache.get(key + '_meta');
  if (!metaRaw) return null;
  try {
    var meta = JSON.parse(metaRaw);
    var out = '';
    for (var i = 0; i < meta.parts; i++) {
      var part = cache.get(key + '_' + i);
      if (part === null) return null;
      out += part;
    }
    return out;
  } catch (err) {
    return null;
  }
}

function putCachedResponseText_(key, text, seconds) {
  var cache = CacheService.getScriptCache();
  var chunkSize = 90000;
  var parts = Math.ceil(text.length / chunkSize);
  for (var i = 0; i < parts; i++) {
    cache.put(key + '_' + i, text.slice(i * chunkSize, (i + 1) * chunkSize), seconds);
  }
  cache.put(key + '_meta', JSON.stringify({ parts: parts, savedAt: new Date().toISOString() }), seconds);
}

function buildResponse_(includeInventory, includeAllocationToStack, includeProductMaster) {
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = getTreatmentSheet_(ss);
    var inventorySheet = includeInventory ? getSheetByFlexibleName_(ss, INVENTORY_SHEET_NAME, ['inventory', 'movements', 'master']) : null;
    var scheduleSheet = getSheetByFlexibleName_(ss, SCHEDULE_SHEET_NAME, ['treatment', 'schedule', 'master']);
    var routingSheet = getSheetByFlexibleName_(ss, ROUTINGS_SHEET_NAME, ['routings', 'master']);
    var allocationSheet = includeAllocationToStack ? getSheetByFlexibleName_(ss, ALLOCATION_TO_STACK_SHEET_NAME, ['allocation', 'stack']) : null;
    var allocationCubeLookup = includeAllocationToStack ? getPmfCubeLookupSafe_() : {};
    var allocationToStackRows = allocationSheet ? buildAllocationToStackRows_(allocationSheet, allocationCubeLookup) : [];

    if (!sheet) {
      throw new Error('Treatment Master tab not found. Available tabs: ' + getSheetList_(ss));
    }

    var lastRow = sheet.getLastRow();
    var lastCol = Math.min(sheet.getLastColumn(), 60);
    if (lastRow < 2) {
      throw new Error('Treatment Master has no data rows');
    }

    var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h); });
    var chargeIdx = findChargeColumn_(headers);

    if (chargeIdx < 0 && headers.length > 47) chargeIdx = 47; // AV
    if (chargeIdx < 0) {
      throw new Error('Charge number column not found. Headers: ' + headers.join(', '));
    }

    var vesselIdx = findColumn_(headers, ['vessel number', 'vessel']);
    var plannedIdx = findColumn_(headers, ['planned charge date', 'planned charge', 'charge date']);
    if (plannedIdx < 0 && headers.length > 46) plannedIdx = 46; // AU
    var rangeIdx = headers.length > 12 ? 12 : findColumn_(headers, ['product range', 'range']);
    var productIdx = findProductColumn_(headers, [
      'product description',
      'item description',
      'stock description',
      'sales description',
      'material description',
      'timber description',
      'description',
      'product',
      'material',
      'timber',
      'item',
      'size'
    ]);
    if (productIdx < 0 && headers.length > 27) productIdx = 27; // AB fallback
    var productFallbackIdxs = productFallbackIndexes_(headers, productIdx);
    var quantityIdx = findColumn_(headers, ['quantity', 'qty', 'pieces', 'pcs']);
    if (quantityIdx < 0 && headers.length > 34) quantityIdx = 34; // AI
    var volumeIdx = headers.length > 36 ? 36 : findColumn_(headers, ['volume', 'm3', 'm³', 'm^3', 'cbm', 'cubic']); // AK

    var summaryColumns = findSummaryColumns_(headers, chargeIdx, vesselIdx, plannedIdx, rangeIdx, productIdx, quantityIdx, volumeIdx);
    var rowCount = Math.min(lastRow - 1, MAX_TREATMENT_ROWS);
    var startDataRow = Math.max(2, lastRow - rowCount + 1);
    var columnData = {};
    var requiredColumns = summaryColumns.slice();
    [chargeIdx, vesselIdx, plannedIdx, rangeIdx, productIdx, quantityIdx, volumeIdx].concat(productFallbackIdxs).forEach(function (idx) {
      if (idx >= 0 && requiredColumns.indexOf(idx) < 0) requiredColumns.push(idx);
    });
    requiredColumns.forEach(function (idx) {
      columnData[idx] = readColumn_(sheet, idx, rowCount, startDataRow);
    });
    var productsByCharge = {};
    var unassignedProducts = [];
    var allProducts = [];

    for (var r = 0; r < rowCount; r++) {
      var charge = valueAt_(columnData, chargeIdx, r);
      var cleanCharge = /^\d{5}$/.test(charge) ? charge : '';

      var row = {};
      for (var c = 0; c < summaryColumns.length; c++) {
        var idx = summaryColumns[c];
        row[headers[idx] || ('Column ' + (idx + 1))] = valueAt_(columnData, idx, r);
      }
      row._chargeNumber = cleanCharge;
      row._vesselNumber = vesselIdx >= 0 ? valueAt_(columnData, vesselIdx, r) : '';
      row._plannedCharge = plannedIdx >= 0 ? valueAt_(columnData, plannedIdx, r) : '';
      row._productDescription = firstProductValue_(columnData, productFallbackIdxs, r);
      row.ProductDescription = row._productDescription;
      row['Product description'] = row._productDescription;
      row['Column AB'] = headers.length > 27 ? valueAt_(columnData, 27, r) : '';
      row._productRange = rangeIdx >= 0 ? valueAt_(columnData, rangeIdx, r) : '';
      row.ProductRange = row._productRange;
      row['Product range'] = row._productRange;
      row['Column M'] = row._productRange;
      row._quantity = quantityIdx >= 0 ? valueAt_(columnData, quantityIdx, r) : '';
      row._volumeM3 = volumeIdx >= 0 ? valueAt_(columnData, volumeIdx, r) : '';
      row.VolumeM3 = row._volumeM3;
      row['Volume m3'] = row._volumeM3;
      row['Column AK'] = row._volumeM3;
      row._rowNumber = startDataRow + r;

      if (cleanCharge) {
        if (!productsByCharge[cleanCharge]) productsByCharge[cleanCharge] = [];
        productsByCharge[cleanCharge].push(row);
      } else if (row._plannedCharge || row._vesselNumber) {
        unassignedProducts.push(row);
      }
      if (cleanCharge || row._plannedCharge || row._vesselNumber || row._productDescription) allProducts.push(row);
    }

    return {
      ok: true,
      bridgeVersion: BRIDGE_VERSION,
      updatedAt: new Date().toISOString(),
      sheetName: sheet.getName(),
      sheetId: sheet.getSheetId(),
      rowWindow: { startRow: startDataRow, endRow: startDataRow + rowCount - 1, totalRows: lastRow },
      columnMap: {
        productRange: { column: 'M', index: rangeIdx, header: rangeIdx >= 0 ? headers[rangeIdx] : '' },
        productDescription: { column: productIdx === 27 ? 'AB' : '', index: productIdx, header: productIdx >= 0 ? headers[productIdx] : '' },
        quantity: { column: 'AI', index: quantityIdx, header: quantityIdx >= 0 ? headers[quantityIdx] : '' },
        volumeM3: { column: 'AK', index: volumeIdx, header: volumeIdx >= 0 ? headers[volumeIdx] : '' },
        plannedCharge: { column: 'AU', index: plannedIdx, header: plannedIdx >= 0 ? headers[plannedIdx] : '' },
        chargeNumber: { column: 'AV', index: chargeIdx, header: chargeIdx >= 0 ? headers[chargeIdx] : '' }
      },
      volumeRowCount: allProducts.filter(function (row) { return row._volumeM3 !== ''; }).length,
      rangeRowCount: allProducts.filter(function (row) { return row._productRange !== ''; }).length,
      chargeCount: Object.keys(productsByCharge).length,
      unassignedCount: unassignedProducts.length,
      productsByCharge: productsByCharge,
      unassignedProducts: unassignedProducts,
      allProducts: allProducts,
      allocationToStackRows: allocationToStackRows,
      allocationToStackCount: allocationToStackRows.length,
      rawPoleProducts: allocationToStackRows,
      plannedScheduleProducts: scheduleSheet ? buildPlannedScheduleProducts_(scheduleSheet) : [],
      greenTreatmentProducts: scheduleSheet ? buildGreenTreatmentProducts_(scheduleSheet) : [],
      scheduleColumnMap: scheduleSheet ? getScheduleColumnMap_(scheduleSheet) : { error: 'Treatment Schedule Master tab not found' },
      poleForecast: buildPoleForecastPayload_(routingSheet),
      inventoryMovements: includeInventory && inventorySheet ? buildInventoryMovements_(inventorySheet) : [],
      inventoryColumnMap: includeInventory && inventorySheet ? getInventoryColumnMap_(inventorySheet) : (
        includeInventory ? { error: 'Inventory Movements Master tab not found' } : { skipped: true }
      )
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err)
    };
  }
}

function buildPlannedScheduleProducts_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.min(sheet.getLastColumn(), 60);
  if (lastRow < 2) return [];

  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h); });
  var rowCount = Math.min(lastRow - 1, MAX_SCHEDULE_ROWS);
  var startDataRow = Math.max(2, lastRow - rowCount + 1);

  var treatmentIdx = headers.length > 5 ? 5 : findColumn_(headers, ['treatment']);
  var originalQtyIdx = headers.length > 6 ? 6 : findColumn_(headers, ['original quantity', 'orig quantity', 'quantity']);
  var packsIdx = headers.length > 7 ? 7 : findColumn_(headers, ['packs']);
  var packSizeIdx = headers.length > 8 ? 8 : findColumn_(headers, ['pack size']);
  var treatmentDateIdx = headers.length > 9 ? 9 : findColumn_(headers, ['treatment date', 'planned treatment date', 'date']);
  var vesselIdx = headers.length > 10 ? 10 : findColumn_(headers, ['vessel number', 'vessel', 'plant']);
  var chargeAllocationIdx = headers.length > 11 ? 11 : findColumn_(headers, ['charge allocation', 'charge']);
  var productIdx = findProductColumn_(headers, [
    'product description',
    'item description',
    'stock description',
    'sales description',
    'material description',
    'timber description',
    'description',
    'product',
    'material',
    'timber',
    'item',
    'size'
  ]);
  var productFallbackIdxs = scheduleProductFallbackIndexes_(headers, productIdx);

  var requiredColumns = [treatmentIdx, originalQtyIdx, packsIdx, packSizeIdx, treatmentDateIdx, vesselIdx, chargeAllocationIdx].concat(productFallbackIdxs);
  var uniqueColumns = [];
  requiredColumns.forEach(function (idx) {
    if (idx >= 0 && uniqueColumns.indexOf(idx) < 0) uniqueColumns.push(idx);
  });

  var columnData = {};
  uniqueColumns.forEach(function (idx) {
    columnData[idx] = readColumn_(sheet, idx, rowCount, startDataRow);
  });

  var out = [];
  for (var r = 0; r < rowCount; r++) {
    var treatment = treatmentIdx >= 0 ? valueAt_(columnData, treatmentIdx, r) : '';
    if (String(treatment || '').toLowerCase().indexOf('creo') < 0) continue;

    var vessel = vesselIdx >= 0 ? valueAt_(columnData, vesselIdx, r) : '';
    if (normalizeGreenPlant_(vessel)) continue;
    if (!/(^|\D)[12](\D|$)/.test(String(vessel || ''))) continue;

    var plannedDate = treatmentDateIdx >= 0 ? valueAt_(columnData, treatmentDateIdx, r) : '';
    var chargeAllocation = chargeAllocationIdx >= 0 ? valueAt_(columnData, chargeAllocationIdx, r) : '';
    var originalQty = originalQtyIdx >= 0 ? valueAt_(columnData, originalQtyIdx, r) : '';
    var packs = packsIdx >= 0 ? valueAt_(columnData, packsIdx, r) : '';
    var packSize = packSizeIdx >= 0 ? valueAt_(columnData, packSizeIdx, r) : '';
    var product = firstProductValue_(columnData, productFallbackIdxs, r);

    if (!plannedDate || !chargeAllocation) continue;

    var row = {};
    row._scheduleSource = 'Treatment Schedule Master';
    row._plannedOnly = true;
    row._chargeNumber = '';
    row._vesselNumber = vessel;
    row._plannedCharge = plannedDate + ' - ' + chargeAllocation;
    row._productDescription = product;
    row.ProductDescription = product;
    row['Product description'] = product;
    row._productRange = 'Fencing';
    row.ProductRange = 'Fencing';
    row['Product range'] = 'Fencing';
    row['Column M'] = 'Fencing';
    row._quantity = originalQty;
    row._scheduleTreatment = treatment;
    row._scheduleOriginalQuantity = originalQty;
    row._schedulePacks = packs;
    row._schedulePackSize = packSize;
    row._scheduleTreatmentDate = plannedDate;
    row._scheduleChargeAllocation = chargeAllocation;
    row['Original quantity'] = originalQty;
    row.Packs = packs;
    row['Pack size'] = packSize;
    row['Treatment date'] = plannedDate;
    row['Charge allocation'] = chargeAllocation;
    row._rowNumber = startDataRow + r;

    if (product || originalQty || packs || packSize) out.push(row);
  }

  return out;
}

function getPmfCubeLookupSafe_() {
  try {
    var pmfSs = SpreadsheetApp.openById(PMF_SPREADSHEET_ID);
    var pmfSheet = getSheetByFlexibleName_(pmfSs, PMF_SHEET_NAME, ['pmf', 'associated', 'data']);
    return pmfSheet ? buildPmfCubeLookup_(pmfSheet).lookup : {};
  } catch (err) {
    return {};
  }
}

function buildAllocationToStackRows_(sheet, cubeLookup) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(7, Math.min(sheet.getLastColumn(), 60));
  if (lastRow < 2) return [];

  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h || '').trim(); });
  var rowCount = Math.min(lastRow - 1, MAX_ALLOCATION_ROWS);
  var startDataRow = Math.max(2, lastRow - rowCount + 1);
  var data = sheet.getRange(startDataRow, 1, rowCount, lastCol).getDisplayValues();
  var out = [];
  var seen = {};

  for (var r = 0; r < data.length; r++) {
    var vals = data[r];
    var description = String(vals[5] || '').trim(); // Column F
    var code = String(vals[6] || '').trim().toUpperCase(); // Column G
    if (code.indexOf('PR') !== 0) continue;
    if (/plug|softwood|\bSYP\b/i.test(description)) continue;
    var cube = cubeForRoutingCode_(cubeLookup || {}, code);

    var row = {};
    for (var c = 0; c < vals.length; c++) {
      row[headers[c] || ('Column ' + (c + 1))] = String(vals[c] || '').trim();
    }

    row.productCode = code;
    row.ProductCode = code;
    row['Product Code'] = code;
    row['Raw Product Code'] = code;
    row['Column G'] = code;
    row['Column 7'] = code;
    row.productDescription = description;
    row.ProductDescription = description;
    row['Product Description'] = description;
    row['Raw Product Description'] = description;
    row['Column F'] = description;
    row['Column 6'] = description;
    row.m3PerPole = cube > 0 ? cube : '';
    row.cubeEachM3 = cube > 0 ? cube : '';
    row['Product m3'] = cube > 0 ? cube : '';
    row['Column E'] = cube > 0 ? cube : '';
    row._sourceSheet = sheet.getName();
    row._rowNumber = startDataRow + r;

    var key = code + '|' + description;
    if (!seen[key]) {
      seen[key] = true;
      out.push(row);
    }
  }

  return out;
}

function buildGreenTreatmentProducts_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.min(sheet.getLastColumn(), 60);
  if (lastRow < 2) return [];

  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h); });
  var rowCount = Math.min(lastRow - 1, MAX_SCHEDULE_ROWS);
  var startDataRow = Math.max(2, lastRow - rowCount + 1);

  var productIdx = headers.length > 3 ? 3 : findColumn_(headers, ['product description', 'description', 'product']); // D
  var piecesIdx = headers.length > 6 ? 6 : findColumn_(headers, ['pieces', 'pieces amount', 'quantity', 'qty']); // G
  var packsIdx = headers.length > 7 ? 7 : findColumn_(headers, ['pack amount', 'packs']); // H
  var perPackIdx = headers.length > 8 ? 8 : findColumn_(headers, ['amount per pack', 'per pack', 'pack size']); // I
  var dateIdx = headers.length > 9 ? 9 : findColumn_(headers, ['treatment date', 'planned treatment date', 'date']); // J
  var plantIdx = headers.length > 10 ? 10 : findColumn_(headers, ['plant', 'treatment plant', 'vessel']); // K
  var chargeIdx = headers.length > 11 ? 11 : findColumn_(headers, ['charge allocation', 'charge']); // L

  var requiredColumns = [productIdx, piecesIdx, packsIdx, perPackIdx, dateIdx, plantIdx, chargeIdx];
  var uniqueColumns = [];
  requiredColumns.forEach(function (idx) {
    if (idx >= 0 && uniqueColumns.indexOf(idx) < 0) uniqueColumns.push(idx);
  });

  var columnData = {};
  uniqueColumns.forEach(function (idx) {
    columnData[idx] = readColumn_(sheet, idx, rowCount, startDataRow);
  });

  var out = [];
  for (var r = 0; r < rowCount; r++) {
    var plant = plantIdx >= 0 ? valueAt_(columnData, plantIdx, r) : '';
    var plantNorm = normalizeGreenPlant_(plant);
    if (!plantNorm) continue;

    var plannedDate = dateIdx >= 0 ? valueAt_(columnData, dateIdx, r) : '';
    var charge = chargeIdx >= 0 ? valueAt_(columnData, chargeIdx, r) : '';
    if (!plannedDate || !charge) continue;

    var product = productIdx >= 0 ? valueAt_(columnData, productIdx, r) : '';
    var pieces = piecesIdx >= 0 ? valueAt_(columnData, piecesIdx, r) : '';
    var packs = packsIdx >= 0 ? valueAt_(columnData, packsIdx, r) : '';
    var perPack = perPackIdx >= 0 ? valueAt_(columnData, perPackIdx, r) : '';
    if (!product && !pieces && !packs && !perPack) continue;

    out.push({
      _scheduleSource: 'Treatment Schedule Master',
      _greenTreatment: true,
      _greenPlant: plantNorm,
      _greenPlantRaw: plant,
      _greenChargeAllocation: charge,
      _greenTreatmentDate: plannedDate,
      _greenProductDescription: product,
      _greenPieces: pieces,
      _greenPacks: packs,
      _greenPerPack: perPack,
      productDescription: product,
      pieces: pieces,
      packs: packs,
      amountPerPack: perPack,
      treatmentDate: plannedDate,
      plant: plantNorm,
      chargeAllocation: charge,
      _rowNumber: startDataRow + r
    });
  }

  return out;
}

function normalizeGreenPlant_(value) {
  var s = String(value || '').toLowerCase().trim();
  if (!s) return '';
  if (s.indexOf('wtt') >= 0) return 'WTT';
  if (s.indexOf('hickson') >= 0 || s.indexOf('hicson') >= 0 || s.indexOf('hixon') >= 0) return 'Hickson';
  return '';
}

function scheduleProductFallbackIndexes_(headers, primaryIdx) {
  var out = [];
  function add(idx) {
    if (idx >= 0 && idx < headers.length && out.indexOf(idx) < 0) out.push(idx);
  }
  add(primaryIdx);
  for (var i = 0; i < Math.min(5, headers.length); i++) add(i);
  for (var j = 0; j < headers.length; j++) {
    var h = String(headers[j] || '').toLowerCase();
    if (/product|description|material|timber|item|size|species|length/.test(h) && !/treatment|quantity|qty|packs|pack size|date|vessel|plant|charge/.test(h)) add(j);
  }
  return out;
}

function getScheduleColumnMap_(sheet) {
  var lastCol = Math.min(sheet.getLastColumn(), 60);
  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h); });
  return {
    treatment: { column: 'F', index: headers.length > 5 ? 5 : findColumn_(headers, ['treatment']), header: headers[5] || '' },
    originalQuantity: { column: 'G', index: headers.length > 6 ? 6 : findColumn_(headers, ['original quantity', 'orig quantity', 'quantity']), header: headers[6] || '' },
    packs: { column: 'H', index: headers.length > 7 ? 7 : findColumn_(headers, ['packs']), header: headers[7] || '' },
    packSize: { column: 'I', index: headers.length > 8 ? 8 : findColumn_(headers, ['pack size']), header: headers[8] || '' },
    treatmentDate: { column: 'J', index: headers.length > 9 ? 9 : findColumn_(headers, ['treatment date', 'planned treatment date', 'date']), header: headers[9] || '' },
    vesselNumber: { column: 'K', index: headers.length > 10 ? 10 : findColumn_(headers, ['vessel number', 'vessel', 'plant']), header: headers[10] || '' },
    chargeAllocation: { column: 'L', index: headers.length > 11 ? 11 : findColumn_(headers, ['charge allocation', 'charge']), header: headers[11] || '' }
  };
}

function buildPoleForecastPayload_(routingSheet) {
  var payload = {
    ok: false,
    averageChargeM3: POLE_AVG_CHARGE_M3,
    generatedAt: new Date().toISOString(),
    rows: [],
    days: [],
    products: [],
    diagnostics: {}
  };
  try {
    if (!routingSheet) {
      payload.error = 'Routings Master tab not found';
      return payload;
    }
    var pmfSs = SpreadsheetApp.openById(PMF_SPREADSHEET_ID);
    var pmfSheet = getSheetByFlexibleName_(pmfSs, PMF_SHEET_NAME, ['pmf', 'associated', 'data']);
    if (!pmfSheet) {
      payload.error = 'PMF Associated Data tab not found';
      return payload;
    }
    var cubeLookup = buildPmfCubeLookup_(pmfSheet);
    var routing = buildRoutingRows_(routingSheet, cubeLookup.lookup);
    payload.ok = true;
    payload.rows = routing.rows;
    payload.days = routing.days;
    payload.products = routing.products;
    payload.diagnostics = {
      routingSheetName: routingSheet.getName(),
      pmfSheetName: pmfSheet.getName(),
      mode: 'planned poles with PMF m3',
      pmfProducts: Object.keys(cubeLookup.lookup).length,
      unmatchedProducts: routing.unmatchedProducts,
      routingColumnMap: routing.columnMap,
      pmfColumnMap: cubeLookup.columnMap
    };
    return payload;
  } catch (err) {
    payload.error = err && err.message ? err.message : String(err);
    return payload;
  }
}

function buildPmfCubeLookup_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.min(sheet.getLastColumn(), 80);
  var headers = lastRow > 0 ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h); }) : [];
  var codeIdx = headers.length > 2 ? 2 : findRoutingProductCodeColumn_(headers); // C
  var cubeIdx = headers.length > 4 ? 4 : findColumn_(headers, ['m3 per pole', 'm3 each', 'm3', 'volume per pole', 'volume each', 'cubic metre', 'cubic meter', 'cube']); // E
  var lookup = {};
  if (lastRow < 2 || cubeIdx < 0) {
    return { lookup: lookup, columnMap: { productCode: codeIdx, cubeM3: cubeIdx } };
  }
  var rowCount = Math.min(lastRow - 1, 20000);
  var cols = [codeIdx, cubeIdx].filter(function (idx, pos, arr) { return idx >= 0 && arr.indexOf(idx) === pos; });
  var data = {};
  cols.forEach(function (idx) { data[idx] = readColumn_(sheet, idx, rowCount); });
  for (var r = 0; r < rowCount; r++) {
    var cube = parseNumber_(valueAt_(data, cubeIdx, r));
    if (!(cube > 0)) continue;
    var code = normalizeProductCode_(valueAt_(data, codeIdx, r));
    addCubeLookup_(lookup, code, cube);
  }
  return {
    lookup: lookup,
    columnMap: {
      productCode: { index: codeIdx, header: codeIdx >= 0 ? headers[codeIdx] : '' },
      cubeM3: { index: cubeIdx, header: cubeIdx >= 0 ? headers[cubeIdx] : '' }
    }
  };
}

function addCubeLookup_(lookup, code, cube) {
  code = normalizeProductCode_(code);
  if (!code || !(cube > 0)) return;
  if (!lookup[code]) lookup[code] = cube;
  var numeric = code.replace(/\D/g, '');
  [5, 6, 7, 8].forEach(function (len) {
    if (numeric.length >= len) {
      var prefix = numeric.slice(0, len).replace(/^0+/, '');
      if (prefix && !lookup[prefix]) lookup[prefix] = cube;
    }
  });
}

function cubeForRoutingCode_(lookup, code) {
  code = normalizeProductCode_(code);
  if (!code) return 0;
  if (lookup[code]) return lookup[code];
  var numeric = code.replace(/\D/g, '');
  for (var len = Math.min(8, numeric.length); len >= 5; len--) {
    var prefix = numeric.slice(0, len).replace(/^0+/, '');
    if (prefix && lookup[prefix]) return lookup[prefix];
  }
  return 0;
}

function buildRoutingRows_(sheet, cubeLookup) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.min(sheet.getLastColumn(), 80);
  var headers = lastRow > 0 ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h); }) : [];
  var dateIdx = headers.length > 4 ? 4 : findColumn_(headers, ['shadow date', 'routing date', 'planned date', 'production date', 'process date', 'date', 'day']); // E
  var shedIdx = headers.length > 8 ? 8 : findColumn_(headers, ['fabrication shed', 'fab shed', 'shed', 'production shed', 'shed number']); // I
  var productIdx = headers.length > 9 ? 9 : findProductColumn_(headers, ['product description', 'description', 'product', 'material', 'item']); // J
  var codeIdx = headers.length > 11 ? 11 : findRoutingProductCodeColumn_(headers); // L
  var minutesIdx = headers.length > 12 ? 12 : findColumn_(headers, ['minutes per pole', 'mins per pole', 'minutes', 'mins']); // M
  var qtyIdx = headers.length > 13 ? 13 : findColumn_(headers, ['quantity', 'qty', 'poles', 'pieces', 'pcs']); // N
  var startIdx = headers.length > 20 ? 20 : findColumn_(headers, ['start time', 'shift start', 'work start']); // U
  var finishIdx = headers.length > 21 ? 21 : findColumn_(headers, ['finish time', 'shift finish', 'work finish']); // V
  var durationIdx = headers.length > 22 ? 22 : findColumn_(headers, ['duration', 'run time', 'work hours', 'hours']); // W
  var totalMinutesIdx = headers.length > 23 ? 23 : findColumn_(headers, ['time alloted minutes', 'time allotted minutes', 'total minutes']); // X
  var shedQtyCols = [];
  var rowCount = Math.min(Math.max(0, lastRow - 1), MAX_ROUTING_ROWS);
  var startDataRow = Math.max(2, lastRow - rowCount + 1);
  var cols = [dateIdx, shedIdx, codeIdx, productIdx, minutesIdx, qtyIdx, startIdx, finishIdx, durationIdx, totalMinutesIdx].concat(shedQtyCols.map(function (c) { return c.index; })).filter(function (idx, pos, arr) { return idx >= 0 && arr.indexOf(idx) === pos; });
  var data = {};
  cols.forEach(function (idx) { data[idx] = readColumn_(sheet, idx, rowCount, startDataRow); });
  var rows = [];
  var dayMap = {};
  var productMap = {};
  var unmatched = {};
  var routeInputs = [];

  for (var r = 0; r < rowCount; r++) {
    var date = valueAt_(data, dateIdx, r);
    if (!date) continue;
    var dayKey = normalizeDateKey_(date);
    var codeRaw = valueAt_(data, codeIdx, r);
    var product = valueAt_(data, productIdx, r);
    if (!isPoleRoutingProduct_(product)) continue;
    var cube = cubeForRoutingCode_(cubeLookup, codeRaw);
    var cubeMissing = !(cube > 0);
    if (cubeMissing) unmatched[codeRaw || product || ('row ' + (startDataRow + r))] = true;
    var sourceSheds = [];
    var qty = parseNumber_(valueAt_(data, qtyIdx, r));
    if (qty > 0) sourceSheds.push({ shed: normalizeShed_(valueAt_(data, shedIdx, r)), qty: qty });
    var minutesPerPole = parseNumber_(valueAt_(data, minutesIdx, r));
    var allocatedHours = parseDurationHours_(valueAt_(data, durationIdx, r));
    var allocatedMinutes = allocatedHours * 60;
    var totalMinutes = parseNumber_(valueAt_(data, totalMinutesIdx, r));
    if (!(totalMinutes > 0) && minutesPerPole > 0) totalMinutes = qty * minutesPerPole;
    if (!(allocatedMinutes > 0)) allocatedMinutes = totalMinutes;
    sourceSheds.forEach(function (entry) {
      var scheduledQty = entry.qty;
      if (allocatedMinutes > 0 && totalMinutes > 0) scheduledQty = entry.qty * Math.min(allocatedMinutes, totalMinutes) / totalMinutes;
      routeInputs.push({
        date: date,
        dayKey: dayKey,
        shed: entry.shed,
        productCode: codeRaw,
        productDescription: product,
        quantity: scheduledQty,
        cube: cube,
        cubeMissing: cubeMissing,
        minutesPerPole: minutesPerPole,
        rowHours: allocatedHours || (totalMinutes / 60),
        rowNumber: startDataRow + r
      });
    });
  }

  routeInputs.sort(function (a, b) {
    var cmp = String(a.dayKey).localeCompare(String(b.dayKey));
    return cmp || String(a.shed).localeCompare(String(b.shed), undefined, { numeric: true }) || (a.rowNumber - b.rowNumber);
  });

  routeInputs.forEach(function (input) {
    addRoutingForecastRow_(rows, dayMap, productMap, {
      date: input.date,
      dayKey: input.dayKey,
      shed: input.shed,
      productCode: input.productCode,
      productDescription: input.productDescription,
      quantity: input.quantity,
      cube: input.cube,
      cubeMissing: input.cubeMissing,
      minutesPerPole: input.minutesPerPole,
      allocatedHours: input.rowHours,
      sourceDate: input.date,
      rowNumber: input.rowNumber
    });
  });

  Object.keys(dayMap).forEach(function (key) {
    var day = dayMap[key];
    day.totalM3 = round_(day.totalM3, 3);
    day.totalQty = round_(day.totalQty, 0);
    day.chargeEquivalent = round_(day.totalM3 / POLE_AVG_CHARGE_M3, 2);
    day.roundedCharges = Math.ceil(day.totalM3 / POLE_AVG_CHARGE_M3);
    Object.keys(day.sheds).forEach(function (shed) {
      day.sheds[shed].quantity = round_(day.sheds[shed].quantity, 0);
      day.sheds[shed].totalM3 = round_(day.sheds[shed].totalM3, 3);
      day.sheds[shed].hours = round_(day.sheds[shed].hours, 2);
    });
    day.totalHours = round_(day.totalHours, 2);
  });
  var days = Object.keys(dayMap).map(function (key) { return dayMap[key]; }).sort(function (a, b) { return String(a.dayKey).localeCompare(String(b.dayKey)); });
  var products = Object.keys(productMap).map(function (key) {
    var p = productMap[key];
    p.quantity = round_(p.quantity, 0);
    p.totalM3 = round_(p.totalM3, 3);
    return p;
  }).sort(function (a, b) { return b.totalM3 - a.totalM3; }).slice(0, 20);

  return {
    rows: rows.slice(-2000),
    days: days,
    products: products,
    unmatchedProducts: Object.keys(unmatched).slice(0, 30),
    columnMap: {
      date: { index: dateIdx, header: dateIdx >= 0 ? headers[dateIdx] : '' },
      shed: { index: shedIdx, header: shedIdx >= 0 ? headers[shedIdx] : '' },
      shedQuantityColumns: shedQtyCols,
      productCode: { index: codeIdx, header: codeIdx >= 0 ? headers[codeIdx] : '' },
      productDescription: { index: productIdx, header: productIdx >= 0 ? headers[productIdx] : '' },
      minutesPerPole: { index: minutesIdx, header: minutesIdx >= 0 ? headers[minutesIdx] : '' },
      quantity: { index: qtyIdx, header: qtyIdx >= 0 ? headers[qtyIdx] : '' },
      shiftStart: { index: startIdx, header: startIdx >= 0 ? headers[startIdx] : '' },
      shiftFinish: { index: finishIdx, header: finishIdx >= 0 ? headers[finishIdx] : '' },
      duration: { index: durationIdx, header: durationIdx >= 0 ? headers[durationIdx] : '' },
      totalMinutes: { index: totalMinutesIdx, header: totalMinutesIdx >= 0 ? headers[totalMinutesIdx] : '' }
    }
  };
}

function isPoleRoutingProduct_(value) {
  return /^\s*\d/.test(String(value || ''));
}

function allocateRoutingTime_(startDayKey, startDateDisplay, shed, qty, rowHours, rowStart, rowFinish, shiftMap, shedCursor) {
  if (!(rowHours > 0)) {
    return [{ dayKey: startDayKey, date: startDateDisplay, qty: qty, hours: rowHours || 0 }];
  }
  var totalHours = rowHours;
  var remainingHours = rowHours;
  var dayKey = startDayKey;
  var cursorKey = shed + '|' + dayKey;
  var firstShift = shiftMap[dayKey + '|' + shed] || { start: rowStart !== null ? rowStart : 360, finish: rowFinish !== null ? rowFinish : null, date: startDateDisplay };
  var initialStart = firstShift.start !== null && firstShift.start !== undefined ? firstShift.start : (rowStart !== null ? rowStart : 360);
  var current = Math.max(Number(shedCursor[cursorKey]) || initialStart, initialStart);
  var allocations = [];
  var guard = 0;

  while (remainingHours > 0.0001 && guard < 21) {
    var shift = shiftMap[dayKey + '|' + shed] || { start: initialStart, finish: null, date: displayDateFromKey_(dayKey) };
    var shiftStart = shift.start !== null && shift.start !== undefined ? shift.start : initialStart;
    var shiftFinish = shift.finish !== null && shift.finish !== undefined ? shift.finish : shiftStart + (ROUTING_DEFAULT_SHIFT_HOURS * 60);
    if (shiftFinish <= shiftStart) shiftFinish = shiftStart + (ROUTING_DEFAULT_SHIFT_HOURS * 60);
    if (current < shiftStart || current >= shiftFinish) current = shiftStart;
    var availableHours = Math.max(0, (shiftFinish - current) / 60);
    if (!(availableHours > 0)) {
      dayKey = addDaysToKey_(dayKey, 1);
      cursorKey = shed + '|' + dayKey;
      current = shiftMap[dayKey + '|' + shed] ? shiftMap[dayKey + '|' + shed].start : rowStart;
      guard++;
      continue;
    }
    var usedHours = Math.min(remainingHours, availableHours);
    var splitQty = qty * (usedHours / totalHours);
    allocations.push({
      dayKey: dayKey,
      date: shift.date || displayDateFromKey_(dayKey),
      qty: splitQty,
      hours: usedHours
    });
    current += usedHours * 60;
    shedCursor[cursorKey] = current;
    remainingHours -= usedHours;
    if (remainingHours > 0.0001) {
      dayKey = addDaysToKey_(dayKey, 1);
      cursorKey = shed + '|' + dayKey;
      current = shiftMap[dayKey + '|' + shed] ? shiftMap[dayKey + '|' + shed].start : rowStart;
    }
    guard++;
  }

  if (!allocations.length) allocations.push({ dayKey: startDayKey, date: startDateDisplay, qty: qty, hours: rowHours });
  return allocations;
}

function addRoutingForecastRow_(rows, dayMap, productMap, input) {
  var qty = Number(input.quantity) || 0;
  var cube = Number(input.cube) || 0;
  if (!(qty > 0)) return;
  var totalM3 = qty * cube;
  var row = {
    date: input.date,
    dayKey: input.dayKey || normalizeDateKey_(input.date),
    shed: input.shed,
    productCode: input.productCode,
    productDescription: input.productDescription,
    quantity: qty,
    cubeEachM3: round_(cube, 4),
    totalM3: round_(totalM3, 3),
    cubeMissing: !!input.cubeMissing,
    minutesPerPole: round_(input.minutesPerPole || 0, 2),
    allocatedHours: round_(input.allocatedHours || 0, 2),
    sourceDate: input.sourceDate || input.date,
    rowNumber: input.rowNumber
  };
  rows.push(row);
  var dayKey = row.dayKey || input.date;
  if (!dayMap[dayKey]) dayMap[dayKey] = { dayKey: dayKey, date: input.date, sheds: {}, totalM3: 0, totalQty: 0, totalHours: 0, chargeEquivalent: 0, roundedCharges: 0 };
  var day = dayMap[dayKey];
  if (!day.sheds[input.shed]) day.sheds[input.shed] = { quantity: 0, totalM3: 0, hours: 0 };
  day.sheds[input.shed].quantity += qty;
  day.sheds[input.shed].totalM3 += totalM3;
  day.sheds[input.shed].hours += Number(input.allocatedHours) || 0;
  day.totalQty += qty;
  day.totalM3 += totalM3;
  day.totalHours += Number(input.allocatedHours) || 0;

  var productKey = input.productCode || input.productDescription;
  if (!productMap[productKey]) productMap[productKey] = { productCode: input.productCode, productDescription: input.productDescription, quantity: 0, totalM3: 0, cubeEachM3: round_(cube, 4), cubeMissing: !!input.cubeMissing };
  productMap[productKey].quantity += qty;
  productMap[productKey].totalM3 += totalM3;
  productMap[productKey].cubeMissing = productMap[productKey].cubeMissing && !!input.cubeMissing;
}

function findShedQuantityColumns_(headers) {
  var out = [];
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').toLowerCase().replace(/\s+/g, ' ').trim();
    var m = h.match(/(?:fab(?:rication)?\s*)?shed\s*([1-5])|shed\s*([1-5])|fabrication\s*([1-5])/i);
    if (m && !/date|time|start|finish|department|resource|status|reason/.test(h)) {
      var n = m[1] || m[2] || m[3];
      out.push({ index: i, header: headers[i], shed: 'Shed ' + n });
    }
  }
  return out;
}

function findRoutingProductCodeColumn_(headers) {
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (/colour|color/.test(h)) continue;
    if (h === 'product code' || h === 'stock code' || h === 'item code' || h === 'material code') return i;
  }
  for (var j = 0; j < headers.length; j++) {
    var h2 = String(headers[j] || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (/colour|color/.test(h2)) continue;
    if (/(product|stock|item|material).{0,12}code|code.{0,12}(product|stock|item|material)/.test(h2)) return j;
  }
  return -1;
}

function normalizeShed_(value) {
  var s = String(value || '').trim();
  var m = s.match(/(?:shed\s*)?([1-5])/i);
  return m ? ('Shed ' + m[1]) : (s || 'Unallocated');
}

function normalizeProductCode_(value) {
  var s = String(value || '').toUpperCase().trim();
  if (!s) return '';
  s = s.replace(/[^A-Z0-9]/g, '');
  if (!s || !/[0-9]/.test(s)) return '';
  if (/^[A-Z]{2,}\d{3,}[A-Z0-9]*$/.test(s)) return s;
  if (/^\d{5,}[A-Z0-9]*$/.test(s)) return s.replace(/^0+/, '');
  var m = s.match(/[A-Z]{2,}\d{3,}[A-Z0-9]*|\d{5,}[A-Z0-9]*/);
  if (!m) return '';
  return /^\d/.test(m[0]) ? m[0].replace(/^0+/, '') : m[0];
}

function parseNumber_(value) {
  var n = Number(String(value || '').replace(/,/g, '').replace(/[^\d.\\-]/g, ''));
  return isFinite(n) ? n : 0;
}

function round_(value, places) {
  var p = Math.pow(10, places || 0);
  return Math.round((Number(value) || 0) * p) / p;
}

function columnName_(n) {
  var out = '';
  while (n > 0) {
    var rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseClockMinutes_(value) {
  var s = String(value || '').trim();
  if (!s) return null;
  var numeric = Number(s);
  if (isFinite(numeric) && numeric > 0 && numeric < 1) return Math.round(numeric * 1440);
  var ampm = s.match(/\b(am|pm)\b/i);
  var m = s.match(/(\d{1,2})(?::(\d{2}))?(?::\d{2})?/);
  if (!m) return null;
  var h = Number(m[1]);
  var min = Number(m[2] || 0);
  if (ampm) {
    var ap = ampm[1].toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  }
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

function parseDurationHours_(value) {
  var s = String(value || '').trim();
  if (!s) return 0;
  var hm = s.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (hm) return Number(hm[1]) + (Number(hm[2]) / 60) + (Number(hm[3] || 0) / 3600);
  var n = parseNumber_(s);
  if (!(n > 0)) return 0;
  return n;
}

function addDaysToKey_(key, days) {
  var d = new Date(String(key || '') + 'T00:00:00');
  if (isNaN(d.getTime())) return key;
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function displayDateFromKey_(key) {
  var d = new Date(String(key || '') + 'T00:00:00');
  if (isNaN(d.getTime())) return key;
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

function normalizeDateKey_(value) {
  var s = String(value || '').trim();
  var m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    var y = Number(m[3]);
    if (y < 100) y += 2000;
    return y + '-' + String(Number(m[2])).padStart(2, '0') + '-' + String(Number(m[1])).padStart(2, '0');
  }
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  return s;
}

function buildInventoryMovements_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.min(sheet.getLastColumn(), 60);
  if (lastRow < 2) return [];
  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h); });
  var map = inventoryIndexes_(headers);
  var rowCount = Math.min(lastRow - 1, MAX_INVENTORY_ROWS);
  var cols = [map.date, map.type, map.quantityDry, map.quantityWet, map.reason, map.product, map.customer, map.supplier]
    .filter(function (idx, pos, arr) { return idx >= 0 && arr.indexOf(idx) === pos; });
  var columnData = {};
  cols.forEach(function (idx) {
    columnData[idx] = readColumn_(sheet, idx, rowCount);
  });
  var out = [];

  for (var r = 0; r < rowCount; r++) {
    var row = {};
    row._movementDate = map.date >= 0 ? valueAt_(columnData, map.date, r) : '';
    row._type = map.type >= 0 ? valueAt_(columnData, map.type, r) : '';
    row._quantityDry = map.quantityDry >= 0 ? valueAt_(columnData, map.quantityDry, r) : '';
    row._quantityWet = map.quantityWet >= 0 ? valueAt_(columnData, map.quantityWet, r) : '';
    row._movementReason = map.reason >= 0 ? valueAt_(columnData, map.reason, r) : '';
    row._productDescription = map.product >= 0 ? valueAt_(columnData, map.product, r) : '';
    row.ProductDescription = row._productDescription;
    row['Product description'] = row._productDescription;
    row['Column AB'] = row._productDescription;
    row._customer = map.customer >= 0 ? valueAt_(columnData, map.customer, r) : '';
    row.Customer = row._customer;
    row['Style/Length'] = row._customer;
    row['Column W'] = row._customer;
    row._supplier = map.supplier >= 0 ? valueAt_(columnData, map.supplier, r) : '';
    row.Supplier = row._supplier;
    row['Column AM'] = row._supplier;
    row._rowNumber = r + 2;

    var type = String(row._type || '').toLowerCase();
    var styleLength = String(row._customer || '').toLowerCase().trim();
    if (type.indexOf('inventory movement') >= 0 || styleLength === '1. pole component') continue;

    if (row._type || row._quantityDry || row._quantityWet || row._movementReason || row._productDescription) {
      out.push(row);
    }
  }

  return out;
}

function getInventoryColumnMap_(sheet) {
  var lastCol = Math.min(sheet.getLastColumn(), 60);
  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (h) { return String(h); });
  var map = inventoryIndexes_(headers);
  return {
    movementDate: { index: map.date, header: map.date >= 0 ? headers[map.date] : '' },
    type: { column: 'M', index: map.type, header: map.type >= 0 ? headers[map.type] : '' },
    quantityDry: { column: 'AD', index: map.quantityDry, header: map.quantityDry >= 0 ? headers[map.quantityDry] : '' },
    quantityWet: { column: 'AF', index: map.quantityWet, header: map.quantityWet >= 0 ? headers[map.quantityWet] : '' },
    movementReason: { column: 'AK', index: map.reason, header: map.reason >= 0 ? headers[map.reason] : '' },
    productDescription: { column: 'AB', index: map.product, header: map.product >= 0 ? headers[map.product] : '' },
    customer: { column: 'W', index: map.customer, header: map.customer >= 0 ? headers[map.customer] : '' },
    supplier: { column: 'AM', index: map.supplier, header: map.supplier >= 0 ? headers[map.supplier] : '' }
  };
}

function readColumn_(sheet, zeroBasedIndex, rowCount, startRow) {
  if (zeroBasedIndex < 0 || rowCount < 1) return [];
  startRow = startRow || 2;
  return sheet
    .getRange(startRow, zeroBasedIndex + 1, rowCount, 1)
    .getDisplayValues()
    .map(function (r) { return String(r[0] || '').trim(); });
}

function valueAt_(columnData, zeroBasedIndex, rowIndex) {
  if (zeroBasedIndex < 0 || !columnData[zeroBasedIndex]) return '';
  return String(columnData[zeroBasedIndex][rowIndex] || '').trim();
}

function inventoryIndexes_(headers) {
  return {
    date: findColumn_(headers, ['movement date', 'date', 'transaction date', 'created', 'posted']),
    type: headers.length > 12 ? 12 : findColumn_(headers, ['type']),
    customer: headers.length > 22 ? 22 : findColumn_(headers, ['style/length', 'style length', 'customer']),
    product: headers.length > 27 ? 27 : findProductColumn_(headers, [
      'product description',
      'item description',
      'stock description',
      'material description',
      'description',
      'product',
      'material',
      'item',
      'size'
    ]),
    quantityDry: headers.length > 29 ? 29 : findColumn_(headers, ['quantity dry', 'qty dry', 'dry quantity']),
    quantityWet: headers.length > 31 ? 31 : findColumn_(headers, ['quantity wet', 'qty wet', 'wet quantity']),
    reason: headers.length > 36 ? 36 : findColumn_(headers, ['movement reason', 'reason']),
    supplier: headers.length > 38 ? 38 : findColumn_(headers, ['supplier'])
  };
}

function getTreatmentSheet_(ss) {
  var sheets = ss.getSheets();

  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === SHEET_GID) return sheets[i];
  }

  var exact = ss.getSheetByName(SHEET_NAME);
  if (exact) return exact;

  var normalizedTarget = SHEET_NAME.toLowerCase().replace(/\s+/g, '');

  for (var j = 0; j < sheets.length; j++) {
    var name = sheets[j].getName().toLowerCase().replace(/\s+/g, '');
    if (name === normalizedTarget || (name.indexOf('treatment') >= 0 && name.indexOf('master') >= 0)) {
      return sheets[j];
    }
  }

  return null;
}

function getSheetByFlexibleName_(ss, exactName, requiredWords) {
  var exact = ss.getSheetByName(exactName);
  if (exact) return exact;

  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var normalized = sheets[i].getName().toLowerCase().replace(/\s+/g, '');
    var ok = true;
    for (var j = 0; j < requiredWords.length; j++) {
      if (normalized.indexOf(String(requiredWords[j]).toLowerCase()) < 0) {
        ok = false;
        break;
      }
    }
    if (ok) return sheets[i];
  }
  return null;
}

function getSheetList_(ss) {
  var sheets = ss.getSheets();
  var names = [];

  for (var i = 0; i < sheets.length; i++) {
    names.push(sheets[i].getName() + ' (' + sheets[i].getSheetId() + ')');
  }

  return names.join(', ');
}

function findChargeColumn_(headers) {
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '');
    if (/charge/i.test(h) && /(no|num|number|#)/i.test(h)) {
      return i;
    }
  }

  return -1;
}

function productFallbackIndexes_(headers, primaryIdx) {
  var out = [];
  function add(idx) {
    if (idx >= 0 && idx < headers.length && out.indexOf(idx) < 0) out.push(idx);
  }
  add(primaryIdx);
  for (var i = 20; i <= 33; i++) add(i);
  for (var j = 0; j < headers.length; j++) {
    var h = String(headers[j] || '').toLowerCase();
    if (/product|description|material|timber|item|size|species|length/.test(h) && !/range|quantity|qty|pieces|pcs|volume|m3|mÂ³|m\^3|cbm|cubic|charge|vessel|planned|date/.test(h)) add(j);
  }
  return out;
}

function firstProductValue_(columnData, indexes, rowIdx) {
  for (var i = 0; i < indexes.length; i++) {
    var idx = indexes[i];
    var value = valueAt_(columnData, idx, rowIdx);
    if (looksLikeProductDescription_(value)) return value;
  }
  return '';
}

function looksLikeProductDescription_(value) {
  var s = String(value || '').trim();
  if (!s) return false;
  if (/^\d{5}$/.test(s)) return false;
  if (/^\d+(?:\.\d+)?$/.test(s)) return false;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) return false;
  if (/^charge\s*\d+/i.test(s)) return false;
  return /[a-zA-Z]/.test(s);
}

function findSummaryColumns_(headers, chargeIdx, vesselIdx, plannedIdx, rangeIdx, productIdx, quantityIdx, volumeIdx) {
  var keywords = [
    'product',
    'range',
    'description',
    'material',
    'timber',
    'item',
    'size',
    'species',
    'customer',
    'quantity',
    'qty',
    'volume',
    'm3',
    'm³',
    'm^3',
    'cbm',
    'cubic',
    'pack',
    'length',
    'order',
    'reference',
    'vessel',
    'planned',
    'date'
  ];
  var cols = [];

  if (vesselIdx >= 0) cols.push(vesselIdx);
  if (plannedIdx >= 0 && cols.indexOf(plannedIdx) < 0) cols.push(plannedIdx);
  if (chargeIdx >= 0 && cols.indexOf(chargeIdx) < 0) cols.push(chargeIdx);
  if (rangeIdx >= 0 && cols.indexOf(rangeIdx) < 0) cols.push(rangeIdx);
  if (productIdx >= 0 && cols.indexOf(productIdx) < 0) cols.push(productIdx);
  if (quantityIdx >= 0 && cols.indexOf(quantityIdx) < 0) cols.push(quantityIdx);
  if (volumeIdx >= 0 && cols.indexOf(volumeIdx) < 0) cols.push(volumeIdx);

  for (var i = 0; i < headers.length; i++) {
    if (i === chargeIdx) continue;
    var h = String(headers[i] || '').toLowerCase();
    for (var k = 0; k < keywords.length; k++) {
      if (h.indexOf(keywords[k]) >= 0) {
        if (cols.indexOf(i) < 0) cols.push(i);
        break;
      }
    }
  }

  if (!cols.length) {
    for (var j = 0; j < Math.min(headers.length, 10); j++) {
      if (j !== chargeIdx) cols.push(j);
    }
  }

  return cols.slice(0, 24);
}

function findColumn_(headers, names) {
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').toLowerCase().replace(/\s+/g, ' ').trim();
    var hNorm = h.replace(/³/g, '3');
    for (var n = 0; n < names.length; n++) {
      var name = String(names[n]).toLowerCase().replace(/\s+/g, ' ').trim();
      var nameNorm = name.replace(/³/g, '3');
      if (h === name || h.indexOf(name) >= 0 || hNorm === nameNorm || hNorm.indexOf(nameNorm) >= 0) return i;
    }
  }
  return -1;
}

function findProductColumn_(headers, names) {
  var blocked = /range|quantity|qty|pieces|pcs|volume|m3|m³|m\^3|cbm|cubic|charge|vessel|planned|date/i;
  for (var n = 0; n < names.length; n++) {
    var name = String(names[n]).toLowerCase().replace(/\s+/g, ' ').trim();
    for (var i = 0; i < headers.length; i++) {
      var raw = String(headers[i] || '');
      if (blocked.test(raw)) continue;
      var h = raw.toLowerCase().replace(/\s+/g, ' ').trim();
      if (h === name || h.indexOf(name) >= 0) return i;
    }
  }
  return -1;
}
