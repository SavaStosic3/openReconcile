import { ApiError, fields, requireAdmin, safeId } from './policy.js';
import { validatePiConnections, testPiSource } from './pi-connectors.js';

const encoder = new TextEncoder();
const b64 = bytes => { let text = ''; for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte); return btoa(text); };
const unb64 = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
const unavailable = () => new ApiError(503, 'PI connection storage is unavailable. Restore the matching server secret and database before continuing.');
const settingsKey = 'openReconcile/pi-connections/v1';
async function key(env) {
  if (typeof env.LOCAL_AUTH_PEPPER !== 'string' || env.LOCAL_AUTH_PEPPER.length < 32) throw unavailable();
  const material = await crypto.subtle.importKey('raw', encoder.encode(env.LOCAL_AUTH_PEPPER), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(settingsKey), info: encoder.encode('server credential encryption') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encrypt(env, data, revision) {
  const bytes = encoder.encode(JSON.stringify(data));
  if (bytes.length > 1_000_000) throw new ApiError(400, 'PI connection settings must be smaller than 1 MB.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${settingsKey}:${revision}`) }, await key(env), bytes);
  return JSON.stringify({ iv: b64(iv), ciphertext: b64(ciphertext) });
}
async function read(env) {
  const row = await env.DB.prepare('SELECT * FROM pi_configuration WHERE id=1').first();
  if (!row) return { revision: 0, profiles: [], versions: {} };
  try {
    const encrypted = JSON.parse(row.encrypted_json), iv = unb64(encrypted.iv);
    if (iv.length !== 12 || typeof encrypted.ciphertext !== 'string' || encrypted.ciphertext.length > 1_400_000) throw new Error();
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${settingsKey}:${row.revision}`) }, await key(env), unb64(encrypted.ciphertext));
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear));
    const profiles = validatePiConnections(data.profiles);
    if (profiles.some(profile => !Number.isSafeInteger(data.versions?.[profile.id]) || data.versions[profile.id] < 1)) throw new Error();
    return { revision: row.revision, profiles, versions: data.versions };
  } catch { throw unavailable(); }
}
const fileProfiles = env => validatePiConnections(env.PI_CONNECTIONS ?? []);
const publicProfile = (profile, revision, readOnly = false) => ({ ...profile, revision, readOnly, auth: { type: profile.auth.type, ...(profile.auth.type === 'basic' ? { username: profile.auth.username } : {}), credentialConfigured: true } });

export async function getPiConfiguration(env) {
  const data = await read(env);
  return { available: typeof env.LOCAL_AUTH_PEPPER === 'string' && env.LOCAL_AUTH_PEPPER.length >= 32, revision: data.revision,
    profiles: [...fileProfiles(env).map(profile => publicProfile(profile, null, true)), ...data.profiles.map(profile => publicProfile(profile, data.versions[profile.id]))] };
}
function mergeProfile(env, data, submitted) {
  fields(submitted, ['id', 'name', 'baseUrl', 'auth', 'inputs', 'outputs'], ['id', 'name', 'baseUrl', 'auth', 'inputs', 'outputs']);
  safeId(submitted.id);
  if (fileProfiles(env).some(profile => profile.id === submitted.id)) throw new ApiError(400, 'This connection is managed by the server file. Use a different connection ID.');
  const prior = data.profiles.find(profile => profile.id === submitted.id), profile = structuredClone(submitted);
  fields(profile.auth, profile.auth.type === 'basic' ? ['type', 'username', 'password'] : ['type', 'token'], ['type']);
  const field = profile.auth.type === 'basic' ? 'password' : 'token';
  if (profile.auth[field] === undefined || profile.auth[field] === '') {
    let destination; try { destination = new URL(profile.baseUrl).toString().replace(/\/$/, ''); } catch {}
    if (!prior || prior.baseUrl !== destination || prior.auth.type !== profile.auth.type || prior.auth.username !== profile.auth.username) throw new ApiError(400, 'Enter a credential for a new connection, endpoint, authentication method, or username.');
    profile.auth[field] = prior.auth[field];
  }
  try {
    const validated = validatePiConnections([...fileProfiles(env), ...data.profiles.filter(item => item.id !== profile.id), profile]);
    return validated.find(item => item.id === profile.id);
  } catch { throw new ApiError(400, 'Check the HTTPS endpoint, credentials, unique aliases, PI paths, metrics, and units. Input and output points must be separate.'); }
}
function revisionMatches(data, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new ApiError(400, 'A connection settings revision is required.');
  if (data.revision !== revision) throw new ApiError(409, 'PI connections changed. Refresh connections before saving or testing.');
}
export async function testPiConfiguration(env, repo, actor, body) {
  requireAdmin(await repo.user(actor.id)); fields(body, ['profile', 'revision'], ['profile', 'revision']);
  const data = await read(env); revisionMatches(data, body.revision);
  const profile = mergeProfile(env, data, body.profile), testEnv = { ...env, PI_CONNECTIONS: [profile] };
  if (!profile.inputs.length && !profile.outputs.length) throw new ApiError(400, 'Add an input or output mapping before testing this connection.');
  for (const direction of ['input', 'output']) if (profile[direction === 'input' ? 'inputs' : 'outputs'].length) await testPiSource(testEnv, { id: 'connection-test', name: 'Connection test', type: 'pi', direction, connectionId: profile.id, ...(direction === 'input' ? { aggregation: 'latest' } : {}) });
  requireAdmin(await repo.user(actor.id)); revisionMatches(await read(env), body.revision);
  return { ok: true };
}
export async function savePiConfiguration(env, repo, actor, id, body, remove = false) {
  requireAdmin(await repo.user(actor.id)); fields(body, remove ? ['revision'] : ['profile', 'revision'], remove ? ['revision'] : ['profile', 'revision']);
  const data = await read(env); revisionMatches(data, body.revision);
  let profile;
  if (remove) {
    profile = data.profiles.find(item => item.id === id);
    if (!profile) throw new ApiError(404, 'That editable PI connection does not exist.');
    const used = await repo.first("SELECT id FROM models WHERE EXISTS(SELECT 1 FROM json_each(sources_json) WHERE json_extract(value,'$.type')='pi' AND json_extract(value,'$.connectionId')=?) LIMIT 1", [id]);
    if (used) throw new ApiError(409, 'Remove model sources using this connection before deleting it, including sources in archived models.');
  } else {
    if (body.profile?.id !== id) throw new ApiError(400, 'The connection ID must match the requested connection.');
    profile = mergeProfile(env, data, body.profile);
  }
  const revision = data.revision + 1, mutationId = repo.uuid(), stamp = repo.stamp();
  const profiles = data.profiles.filter(item => item.id !== id); if (!remove) profiles.push(profile);
  const versions = { ...data.versions }; if (remove) delete versions[id]; else versions[id] = revision;
  const encrypted = await encrypt(env, { profiles, versions }, revision);
  const authorization = "EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='admin')";
  // Recheck references atomically: source assignment can race with encryption.
  const deletionGuard = remove ? " AND NOT EXISTS(SELECT 1 FROM models,json_each(models.sources_json) WHERE json_extract(value,'$.type')='pi' AND json_extract(value,'$.connectionId')=?)" : '';
  const write = data.revision === 0
    ? repo.statement(`INSERT INTO pi_configuration(id,encrypted_json,revision,mutation_id,updated_at) SELECT 1,?,?,?,? WHERE ${authorization} AND NOT EXISTS(SELECT 1 FROM pi_configuration WHERE id=1)`, [encrypted, revision, mutationId, stamp, actor.id])
    : repo.statement(`UPDATE pi_configuration SET encrypted_json=?,revision=?,mutation_id=?,updated_at=? WHERE id=1 AND revision=? AND ${authorization}${deletionGuard}`, [encrypted, revision, mutationId, stamp, data.revision, actor.id, ...(remove ? [id] : [])]);
  const fence = 'EXISTS(SELECT 1 FROM pi_configuration WHERE id=1 AND mutation_id=?)';
  const references = "json_extract(value,'$.type')='pi' AND json_extract(value,'$.connectionId')=?";
  const results = await env.DB.batch([
    write,
    repo.statement(`UPDATE models SET sources_json=(SELECT json_group_array(json(CASE WHEN ${references} THEN json_set(value,'$.connectionRevision',?) ELSE value END)) FROM json_each(models.sources_json)), schedule_json=CASE WHEN EXISTS(SELECT 1 FROM json_each(sources_json) WHERE ${references} AND json_extract(value,'$.id') IN (json_extract(schedule_json,'$.inputSourceId'),json_extract(schedule_json,'$.outputSourceId'))) THEN json_set(schedule_json,'$.enabled',json('false'),'$.nextRunAt',NULL) ELSE schedule_json END, revision=revision+1,updated_at=? WHERE ${fence} AND EXISTS(SELECT 1 FROM json_each(sources_json) WHERE ${references})`, [id, revision, id, stamp, mutationId, id]),
    repo.statement(`INSERT INTO audit_events(id,occurred_at,actor_id,actor_name,category,action,summary,target_id,target_name,changes_json,revision_before,revision_after,truncated) SELECT ?,?,id,name,'connector',?,?,?,?,'[]',?,?,0 FROM users WHERE id=? AND ${fence}`, [repo.uuid(), stamp, remove ? 'pi_connection_deleted' : 'pi_connection_saved', remove ? 'Deleted a PI connection.' : 'Saved PI connection settings. Affected source configurations were invalidated and selected schedules paused.', id, profile.name, data.revision, revision, actor.id, mutationId])
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) { requireAdmin(await repo.user(actor.id)); throw new ApiError(409, 'PI connections changed. Refresh before saving.'); }
  return getPiConfiguration(env);
}

// Resolve encrypted settings only on the server and only for PI operations.
export async function piRuntime(env) {
  const data = await read(env), fixed = fileProfiles(env);
  let profiles; try { profiles = validatePiConnections([...fixed, ...data.profiles]); } catch { throw unavailable(); }
  return { ...env, PI_CONNECTIONS: profiles, PI_CONNECTION_VERSIONS: data.versions, PI_REGISTRY_REVISION: data.revision,
    PI_CONFIGURATION_CHECK: async source => {
      if (data.versions[source.connectionId] === undefined) return;
      const latest = await read(env);
      if (latest.versions[source.connectionId] !== data.versions[source.connectionId] || source.connectionRevision !== latest.versions[source.connectionId]) throw new ApiError(409, 'PI connection settings changed. Refresh the workspace and review the sources before rerunning.');
    } };
}
