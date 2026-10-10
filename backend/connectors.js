import { validateSqlSource } from '../public/sql-sources.js';
import { validatePiSource } from '../public/pi-sources.js';
import { sqlAdapters } from './sql-connectors.js';
import { piAdapters } from './pi-connectors.js';
import { piRuntime } from './pi-configuration.js';

export function validateDataSource(source) {
  if (source?.type === 'sql') return validateSqlSource(source);
  if (source?.type === 'pi') return validatePiSource(source);
  throw new Error('Choose a supported SQL or PI Web API source.');
}

export function connectorAdapters(env) {
  const sql = sqlAdapters(env);
  const invokePi = direction => async (source, modelOrRun, context) => {
    const runtime = await piRuntime(env);
    await runtime.PI_CONFIGURATION_CHECK(source);
    const result = await piAdapters(runtime)[`${direction}Adapters`].pi(source, modelOrRun, context);
    if (direction === 'input') await runtime.PI_CONFIGURATION_CHECK(source);
    return result;
  };
  return { inputAdapters: { ...sql.inputAdapters, pi: invokePi('input') }, outputAdapters: { ...sql.outputAdapters, pi: invokePi('output') } };
}
