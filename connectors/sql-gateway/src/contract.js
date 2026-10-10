export const MAX_ROWS = 10_000;
export const MAX_WRITE_ROWS = 900;
export const OUTPUT_COLUMNS = Object.freeze([
  'run_id', 'model_id', 'model_name', 'published_version', 'item_id', 'item_type',
  'source_name', 'metric', 'value_kg', 'raw_kg', 'correction_kg', 'uncertainty_kg',
  'status', 'batch_start', 'batch_end', 'finished_at',
]);
export class GatewayError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function fail(message) { throw new GatewayError('INVALID_REQUEST', message); }
export function identifier(value, table = false) {
  if (typeof value !== 'string' || value.length > 129 || !(table
    ? /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63})?$/
    : /^[A-Za-z_][A-Za-z0-9_]{0,63}$/).test(value)) fail('Use a valid table or column identifier.');
  return value;
}
export function quoteIdentifier(value, dialect, table = false) {
  identifier(value, table);
  return value.split('.').map(part => dialect === 'sqlserver' ? `[${part}]`
    : dialect === 'mysql' ? `\`${part}\`` : `"${part}"`).join('.');
}
export function stringField(value, label, max = 200, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail(`${label} is required and must be at most ${max} characters.`);
  return value;
}
export function dateField(value, label) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO timestamp with a timezone.`);
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) fail(`${label} must be a valid calendar timestamp.`);
  return new Date(value).toISOString();
}
export function numberField(value, label, nullable = false, signed = false) {
  if (nullable && value === null) return null;
  if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value) || (!signed && value < 0)) fail(`${label} must be a finite ${signed ? '' : 'nonnegative '}number.`);
  return value;
}
export function authorizeTable(connection, table, direction) {
  identifier(table, true);
  const tables = direction === 'input' ? connection.readableTables : connection.writableTables;
  if (!tables.includes(table)) throw new GatewayError('TABLE_NOT_ALLOWED', 'This table is not allowed for the selected direction.', 403);
}
export function validateRead(body, connection) {
  authorizeTable(connection, body.table, 'input');
  const columns = ['tagColumn', 'valueColumn', 'timestampColumn'];
  for (const key of columns) identifier(body[key]);
  if (new Set(columns.map(key => body[key])).size !== 3) fail('Input columns must be distinct.');
  if (!Array.isArray(body.tags) || body.tags.length < 1 || body.tags.length > 500) fail('Request between 1 and 500 source tags.');
  const tags = body.tags.map(tag => stringField(tag, 'Source tag'));
  if (new Set(tags).size !== tags.length) fail('Source tags must be unique.');
  const start = dateField(body.start, 'Batch start'), end = dateField(body.end, 'Batch end');
  if (start >= end || Date.parse(end) - Date.parse(start) > 366 * 86_400_000) fail('Select a nonempty batch window of at most 366 days.');
  if (!['latest', 'sum', 'average'].includes(body.aggregation)) fail('Select latest, sum, or average aggregation.');
  return { ...body, tags, start, end };
}
export function readQuery(connection, input) {
  const dialect = connection.dialect;
  const q = value => quoteIdentifier(value, dialect);
  const params = [...input.tags, new Date(input.start), new Date(input.end)];
  const placeholder = i => dialect === 'postgres' ? `$${i + 1}` : dialect === 'sqlserver' ? `@p${i}` : '?';
  const top = dialect === 'sqlserver' ? `TOP (${MAX_ROWS + 1}) ` : '';
  const limit = dialect === 'sqlserver' ? '' : ` LIMIT ${MAX_ROWS + 1}`;
  return {
    sql: `SELECT ${top}${q(input.tagColumn)} AS ${q('source_name')}, ${q(input.valueColumn)} AS ${q('value')}, ${q(input.timestampColumn)} AS ${q('timestamp')} FROM ${quoteIdentifier(input.table, dialect, true)} WHERE ${q(input.tagColumn)} IN (${input.tags.map((_, i) => placeholder(i)).join(', ')}) AND ${q(input.timestampColumn)} >= ${placeholder(input.tags.length)} AND ${q(input.timestampColumn)} < ${placeholder(input.tags.length + 1)} ORDER BY ${q(input.timestampColumn)} DESC${limit}`,
    params,
  };
}
export function testQuery(connection, input) {
  if (!['input', 'output'].includes(input.direction)) fail('Select input or output.');
  authorizeTable(connection, input.table, input.direction);
  const columns = input.direction === 'output' ? OUTPUT_COLUMNS : [input.tagColumn, input.valueColumn, input.timestampColumn];
  columns.forEach(column => identifier(column));
  return { sql: `SELECT ${columns.map(column => quoteIdentifier(column, connection.dialect)).join(', ')} FROM ${quoteIdentifier(input.table, connection.dialect, true)} WHERE 1 = 0`, params: [] };
}
export function aggregateReadings(rawRows, input) {
  if (!Array.isArray(rawRows) || rawRows.length > MAX_ROWS) throw new GatewayError('TOO_MANY_ROWS', 'The batch contains more than 10,000 source rows. Use a smaller window.', 422);
  const grouped = new Map(input.tags.map(tag => [tag, []]));
  for (const row of rawRows) {
    if (typeof row.source_name !== 'string' || !grouped.has(row.source_name)) throw new GatewayError('INVALID_SOURCE_DATA', 'The source returned an unexpected tag.', 422);
    let timestamp = row.timestamp;
    if (timestamp instanceof Date) timestamp = timestamp.toISOString();
    try { timestamp = dateField(timestamp, 'Source timestamp'); } catch { throw new GatewayError('INVALID_SOURCE_DATA', 'The source returned an invalid timestamp.', 422); }
    if (timestamp < input.start || timestamp >= input.end) throw new GatewayError('INVALID_SOURCE_DATA', 'The source returned a row outside the batch window.', 422);
    let value;
    try { value = numberField(row.value, 'Source reading'); } catch { throw new GatewayError('INVALID_SOURCE_DATA', 'A source reading is missing, negative, or not numeric.', 422); }
    grouped.get(row.source_name).push({ value, timestamp });
  }
  const readings = input.tags.map(sourceName => {
    const rows = grouped.get(sourceName);
    if (!rows.length) throw new GatewayError('MISSING_SOURCE_DATA', `No source reading was found for ${sourceName}.`, 422);
    const latestTimestamp = rows.reduce((latest, row) => row.timestamp > latest ? row.timestamp : latest, rows[0].timestamp);
    let value;
    if (input.aggregation === 'latest') {
      const latest = rows.filter(row => row.timestamp === latestTimestamp);
      if (new Set(latest.map(row => row.value)).size > 1) throw new GatewayError('AMBIGUOUS_SOURCE_DATA', `Multiple different latest readings were found for ${sourceName}.`, 422);
      value = latest[0].value;
    } else {
      // Divide before adding for averages to avoid overflowing finite samples.
      value = rows.reduce((sum, row) => sum + (input.aggregation === 'average' ? row.value / rows.length : row.value), 0);
      if (!Number.isFinite(value)) throw new GatewayError('INVALID_SOURCE_DATA', 'The aggregated source reading is not finite.', 422);
    }
    return { sourceName, value, timestamp: latestTimestamp };
  });
  return { readings, window: { start: input.start, end: input.end } };
}
export function validateWrite(body, connection) {
  authorizeTable(connection, body.table, 'output');
  if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > MAX_WRITE_ROWS) fail('Write between 1 and 900 result rows.');
  const keys = new Set();
  const rows = body.rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('A result row must be an object.');
    const result = {};
    for (const key of ['run_id', 'model_id', 'item_id']) result[key] = stringField(row[key], key, 128);
    result.model_name = stringField(row.model_name, 'model_name');
    result.source_name = stringField(row.source_name, 'source_name');
    if (!['stream', 'unit'].includes(row.item_type)) fail('item_type must be stream or unit.');
    result.item_type = row.item_type;
    const metrics = row.item_type === 'stream' ? ['mass'] : ['incoming_mass', 'outgoing_mass'];
    if (!metrics.includes(row.metric)) fail('The result metric does not match its item type.');
    result.metric = row.metric;
    if (row.published_version !== null && (!Number.isInteger(row.published_version) || row.published_version < 1)) fail('published_version must be null or a positive integer.');
    result.published_version = row.published_version;
    result.value_kg = numberField(row.value_kg, 'value_kg');
    result.raw_kg = numberField(row.raw_kg, 'raw_kg', true);
    result.correction_kg = numberField(row.correction_kg, 'correction_kg', true, true);
    result.uncertainty_kg = numberField(row.uncertainty_kg, 'uncertainty_kg', true);
    if (!(row.item_type === 'stream' ? ['measured', 'estimated'] : ['reconciled']).includes(row.status)) fail('Only observable reconciled results can be exported.');
    result.status = row.status;
    for (const key of ['batch_start', 'batch_end', 'finished_at']) result[key] = dateField(row[key], key);
    if (result.batch_start >= result.batch_end) fail('The result batch window must be nonempty.');
    const identity = JSON.stringify([result.run_id, result.item_type, result.item_id, result.metric]);
    if (keys.has(identity)) fail('The output contains a duplicate result identity.');
    keys.add(identity);
    return result;
  });
  if (new Set(rows.map(row => JSON.stringify([row.run_id, row.model_id, row.model_name, row.published_version, row.batch_start, row.batch_end, row.finished_at]))).size !== 1) fail('Export one consistent model run per request.');
  return rows;
}
export function insertQuery(connection, table, row) {
  const dialect = connection.dialect;
  return {
    sql: `INSERT INTO ${quoteIdentifier(table, dialect, true)} (${OUTPUT_COLUMNS.map(column => quoteIdentifier(column, dialect)).join(', ')}) VALUES (${OUTPUT_COLUMNS.map((_, i) => dialect === 'postgres' ? `$${i + 1}` : dialect === 'sqlserver' ? `@p${i}` : '?').join(', ')})`,
    params: OUTPUT_COLUMNS.map(column => ['batch_start', 'batch_end', 'finished_at'].includes(column) ? new Date(row[column]) : row[column]),
  };
}
