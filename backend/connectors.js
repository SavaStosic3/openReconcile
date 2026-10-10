import { validateSqlSource } from '../public/sql-sources.js';
import { validatePiSource } from '../public/pi-sources.js';
import { sqlAdapters } from './sql-connectors.js';
import { piAdapters } from './pi-connectors.js';

export function validateDataSource(source) {
  if (source?.type === 'sql') return validateSqlSource(source);
  if (source?.type === 'pi') return validatePiSource(source);
  throw new Error('Choose a supported SQL or PI Web API source.');
}

export function connectorAdapters(env) {
  const sql = sqlAdapters(env), pi = piAdapters(env);
  return { inputAdapters: { ...sql.inputAdapters, ...pi.inputAdapters }, outputAdapters: { ...sql.outputAdapters, ...pi.outputAdapters } };
}
