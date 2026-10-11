# PI Web API input and output

openReconcile connects to an existing AVEVA PI Web API service from the application server. PI input replaces readings in the detached reconciliation snapshot; it does not overwrite saved model measurements. PI output writes selected reconciled values to pre-existing destination points. Input and output can use different PI connections, or be combined with SQL sources.

## Supported integration

| Capability | Behavior |
| --- | --- |
| Authentication | Basic authentication over HTTPS, or a bearer token accepted by a company-managed proxy in front of PI Web API. Native Windows/Kerberos negotiation is not implemented. |
| Input identity | An allowed PI point path, or a numeric AF attribute backed by a PI point with a verifiable `Links.Point` identity on the configured service. |
| Input periods | Completed calendar hours, reporting days, shifts, or explicit batches using the model's reporting settings and time zone. |
| Input calculation | Latest reading, interval-total sum, arithmetic average, time-weighted flow average, or totalizer difference. |
| Storage | Exact recorded opening and closing inventory readings, including mass, volume, or level values in the model's configured units. |
| Output identity | Allowed existing `Float64` PI points, selected independently by Source Name and result metric. The connector does not create points. |
| Output units | Mass in `kg`, `t`, or `g`; average mass flow in `kg/h` or `t/h` for stream mass and unit incoming/outgoing mass. Inventory and accumulation remain mass values. Volume output is not supported. |
| Output timestamp | Reporting-period end, except opening inventory at reporting-period start. |
| Delivery | Scalar `Stream.UpdateValue` requests with `Replace` and `DoNotBuffer`, acknowledged individually by HTTP 202. Multiple point updates are not a transaction. |

The connector uses ordinary PI Web API REST endpoints and requires the capabilities listed above. Consult the installed service's `/piwebapi/help` reference and test the installed PI Web API version before enabling a plant schedule. No live PI system is available in this project's automated tests; those tests use strict HTTP fixtures and analytical reconciliation examples.

## 1. Configure a connection in the application

Sign in as an administrator and open **☰ → Data connectors → PI connection settings → + Add PI connection**. Enter a name, HTTPS PI Web API endpoint, and Basic service account or company-proxy bearer token. Add input mappings with **Source Name**, PI point or AF path, and exact unit. Add output mappings with Source Name, result metric, existing destination point path, and exact unit. **Test connection** verifies numeric metadata and units without writing results. Then **Save connection**.

This screen is available on internal installations and the hosted site. The endpoint must be reachable from the application server. An internal Docker server can reach the plant network; the hosted cloud service needs an accessible HTTPS endpoint or company-approved proxy. It cannot reach a plant-only private address automatically.

UI-managed profiles are encrypted in the database using AES-GCM with a key derived from the installation's `LOCAL_AUTH_PEPPER`. Passwords/tokens are never returned to the browser. Administrators can see endpoint, username and mapping paths in connection settings. Ordinary connection metadata, model exports, run records and audit history contain no credentials or private paths. Leave the credential blank when editing to retain it; endpoint, account or authentication-method changes require re-entry.

Saving changes takes effect without restarting. It advances affected source revisions, invalidates earlier input-result matching and pauses schedules selecting those sources. Runs recheck the connection before reading/writing; changes prevent subsequent writes. Review and explicitly re-enable affected schedules. Remove all sources referencing a connection before deleting it, including sources in archived models.

Back up the database and matching server secret together. The standalone backup includes both. Losing or replacing the pepper makes saved settings unreadable; restore the matching pair rather than independently rotating this secret. Hosted installations must retain the existing runtime secret across deployments.

### Optional server-managed file

Create a private JSON file, for example `deploy/pi-connections.json`. Do not commit populated connection files or credentials. The file must be a JSON array no larger than 1 MB. Only the server reads it.

```json
[
  {
    "id": "plant-pi",
    "name": "Plant PI",
    "baseUrl": "https://piwebapi.company.internal/piwebapi",
    "auth": {
      "type": "basic",
      "username": "DOMAIN\\reconcile-service",
      "password": "REPLACE_WITH_PRIVATE_SERVICE_ACCOUNT_PASSWORD"
    },
    "inputs": [
      { "sourceName": "PLANT.FEED.FLOW", "path": "\\\\PIARCHIVE\\FEED.FLOW", "unit": "kg/h" },
      { "sourceName": "PLANT.PRODUCT.FLOW", "path": "\\\\PIARCHIVE\\PRODUCT.FLOW", "unit": "kg/h" },
      { "sourceName": "PLANT.TANK.LEVEL", "path": "\\\\AFSERVER\\Plant\\Area\\Tank|Level", "unit": "m" }
    ],
    "outputs": [
      { "sourceName": "PLANT.FEED.FLOW", "metric": "mass", "path": "\\\\PIARCHIVE\\RECON.FEED.FLOW", "unit": "kg/h" },
      { "sourceName": "PLANT.TANK.RESULTS", "metric": "opening_inventory", "path": "\\\\PIARCHIVE\\RECON.TANK.OPENING", "unit": "kg" },
      { "sourceName": "PLANT.TANK.RESULTS", "metric": "closing_inventory", "path": "\\\\PIARCHIVE\\RECON.TANK.CLOSING", "unit": "kg" },
      { "sourceName": "PLANT.TANK.RESULTS", "metric": "accumulation", "path": "\\\\PIARCHIVE\\RECON.TANK.ACCUMULATION", "unit": "kg" }
    ]
  }
]
```

Replace these example paths with existing plant assets. Every physical meter and measured inventory needs an allowed input alias. A tank can use one alias for both inventory boundaries. The input alias's unit must exactly match both the model unit and PI metadata (`EngineeringUnits` for points, `DefaultUnitsOfMeasureAbbreviation` or `DefaultUnitsOfMeasure` for AF attributes). A mismatch fails the run; the connector does not assume a density, convert input units, or guess unit labels.

Each input alias must identify a distinct physical sensor. Duplicate PI paths are compared without case sensitivity, and resolved point identities are checked before reading. AF attributes must expose a verifiable underlying point identity so that an AF alias and a point alias cannot count one sensor as two independent meters. Represent dependent measurements as virtual meters.

Each output binding must have a unique point path and a unique Source Name/metric pair. Output points must be separate from configured raw input points. Resolved output identities are checked before writing. Empty `inputs` or `outputs` arrays disable that direction. File-managed profiles appear read-only in the browser; edit the file and restart to change them. UI profiles cannot replace a file-managed connection ID.

For a company proxy that accepts bearer authentication, replace the `auth` object with:

```json
{ "type": "bearer", "token": "REPLACE_WITH_PRIVATE_PROXY_TOKEN" }
```

Bearer authentication is a proxy contract, rather than a claim that every PI Web API installation accepts bearer tokens. Configure the proxy's PI identity and read/write authorization according to company policy. The connector does not mint or renew tokens.

## 2. Trust the certificate; optionally mount a file

UI-managed connections require no connection-file mount. Use the normal Compose installation. The override below is only needed for file-managed connections.

For Docker, add to the repository-root `.env`:

```dotenv
PI_CONNECTIONS_FILE_HOST=./deploy/pi-connections.json
```

The app image runs as the `node` account (UID/GID 1000). File-based Compose secrets use a read-only mount; arrange host ownership and permissions so that this account can read the private file while other host users cannot. On a Linux host, an administrator can assign ownership to UID/GID 1000 and mode 0600. Keep the file outside backups or repositories that are accessible to general users.

Start or recreate the app with both Compose files:

```sh
docker compose -f compose.yaml -f deploy/compose.pi.yaml up -d --build
```

The override mounts the JSON file at `/run/secrets/pi_connections` and sets `PI_CONNECTIONS_FILE`. Use the same `-f` arguments for subsequent Compose operations. A direct Node installation can set `PI_CONNECTIONS_FILE` to the absolute path of a private file readable by the service account. Restart the application after editing the file.

HTTPS and certificate verification are required. For a company certificate authority, mount the PEM bundle read-only and set Node's `NODE_EXTRA_CA_CERTS` to the container path, for example through an additional local Compose override:

```yaml
services:
  app:
    environment:
      NODE_EXTRA_CA_CERTS: /run/certs/company-ca.pem
    volumes:
      - ./deploy/pi-ca.pem:/run/certs/company-ca.pem:ro
```

Ensure the account can read this certificate file. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`. No browser CORS configuration is required for this server-side integration. PI must be reachable from the app container/server, and the service identity needs read access to configured inputs and write access to configured outputs. Use separate connections/accounts when different permissions are required.

## 3. Map and select the sources

1. Sign in as an administrator and open **Data connectors** from the hamburger menu.
2. Select a model, choose **PI Web API**, and add an input or output source using an available connection. The source form shows aliases, metrics and units. Endpoint and path settings are restricted to the separate administrator connection screen.
3. In **Data mapping**, or the stream/tank settings, set **Source Name** to the input alias for each physical meter and inventory boundary. Unit output mappings select the alias shared by that unit's output metric bindings.
4. Test the connection and preview input for a completed period. Connection testing resolves numeric metadata and units without writing output; it does not prove write permission by creating a test event.
5. Select the PI input/output sources in **Model Management**. These selections also apply to manual runs. Publish and save the schedule to authorize unattended execution on a standalone installation.

Changing or removing a selected source pauses its schedule for review. SQL and PI sources retain independent configurations. Connector setup remains subject to administrator access and the model's edit lock.

## Input quality and mathematical behavior

An accepted PI reading must have `Good=true`, `Questionable=false`, and `Substituted=false`, with a finite numeric value. These intrinsic flags cannot be disabled or broadened to accept questionable, substituted, or bad readings. A digital/status object is never converted into zero. Malformed quality metadata and invalid numeric readings fail the run.

Integer streams must contain whole values within JavaScript's safe integer range (absolute value at most 9,007,199,254,740,991). Larger integer counters are rejected before reconciliation so that adjacent archive counts cannot collapse into a false zero delta. Floating-point inputs retain the precision of their PI point/attribute type.

Choose whether other quality states reject the reporting period or are excluded. Excluded events remain barriers in the series; time integration does not bridge their gaps. Configure maximum sample age, minimum coverage, interpolation, and gap policy. Flow gap scaling is an explicit assumption and adds a warning. Unknown totalizer gaps are never scaled. Counter decreases require the selected reset or rollover policy and generate audit warnings when those assumptions are used.

Simple latest, sum, and arithmetic-average input uses a half-open period: **start included, end excluded**. Sums are appropriate for interval totals, not cumulative counters or instantaneous rates. Time-weighted flow uses recorded samples and the configured step or linear rule; the shared reconciliation engine converts its mean rate using the actual elapsed reporting duration, including time-zone boundary changes. Totalizer differences use cumulative mass or volume units and require complete boundary coverage.

Inventory readings require a recorded value exactly at each reporting boundary. A stale snapshot, interpolated value, or period average is not substituted for opening/closing inventory. The existing storage conversion, uncertainty propagation, and accumulation equation remain unchanged.

The connector requests at most 10,000 recorded events per mapped input. A full response or continuation link fails closed because completion cannot be proven; select a smaller period. Responses are limited to 4 MB and each request has a 15-second timeout. PI timestamps with ISO offsets and up to seven fractional digits are supported when the digits beyond milliseconds are zero. Nonzero submillisecond precision fails rather than silently collapsing separate events.

## Output results and reruns

Supported result metrics are:

| Model item | Metric | Allowed destination units |
| --- | --- | --- |
| Stream | `mass` | `kg`, `t`, `g`, `kg/h`, `t/h` |
| Process unit | `incoming_mass`, `outgoing_mass` | `kg`, `t`, `g`, `kg/h`, `t/h` |
| Storage unit | `opening_inventory`, `closing_inventory`, `accumulation` | `kg`, `t`, `g` |

Mass-flow output is the reconciled period mass divided by the actual elapsed period hours. For example, 100 kg over a two-hour batch writes 50 kg/h to an explicitly configured rate destination. It is a period mean. A rate unit cannot be used for an inventory or accumulation result.

Only allowed bindings that match the model's mapped result aliases and metrics are written. Every intended result must be observable and every selected destination must have matching PI units and `Float64` point type before the first write. Other model results can remain unmapped. Point precision, compression/archive settings, and downstream consumers remain the plant's responsibility; validate retrieval from destination points during acceptance testing.

Before each event, the server rechecks the acting user's permissions, selected source configuration, model/publication and execution lease. Revocation during metadata preflight prevents the first write; revocation after an acknowledgement prevents subsequent writes and leaves the partial delivery for review.

Each scalar update sets the timestamp and value with `updateOption=Replace` and `bufferOption=DoNotBuffer`. A deliberate rerun replaces that same point/timestamp value. Opening inventory uses the period start; closing inventory, accumulation, stream mass, and unit totals use the period end. Read-only flags such as `Substituted` are not supplied in write requests.

Output quality follows the conservative `conservative-v1` policy. A clean successful reconciliation writes `Good: true, Questionable: false`. Any reconciliation/input warning or an underdetermined model writes observable results with `Good: true, Questionable: true`, so consumers can distinguish usable numbers requiring review from clean results. Modeling-assumption warnings also count. Failed/invalid runs and unobservable values cannot be exported. The output audit retains the verdict, original reconciliation status, warnings, and each event's flags; CSV exports carry the verdict and warnings as well. Confirm downstream PI consumers inspect `Questionable` rather than relying only on `Good`.

The run audit records aliases, units, values, timestamps, and the acknowledged event count. A complete batch requires HTTP 202 with an empty response for every event. Partial acknowledgements, unexpected statuses, lost responses, and interruptions leave delivery uncertain. Earlier events may already have been accepted. The standalone server records the failed/interrupted run and pauses the model's automatic schedule; it does not replay that occurrence. Review the selected PI points at the recorded period timestamps, decide whether a deliberate rerun is needed, then explicitly re-enable and save the schedule. This is not an exactly-once or transactional delivery guarantee. Retained application history remains 20 runs per model.

## Acceptance checks

Use isolated pre-existing PI input/output points before enabling a plant schedule. Verify point/AF identity and units, exact tank boundaries, known reconciliation results, quality failures and coverage, totalizer reset behavior, returned destination values, a deliberate historical rerun, and permission revocation. Confirm automatic execution continues with all browsers closed and an interrupted/uncertain output requires destination review. Record the installed PI Web API version, app commit, connection configuration, and evidence without including passwords or tokens.

## Vendor references

- [AVEVA PI Web API samples and configuration requirements](https://github.com/AVEVA/AVEVA-Samples-PI-System/blob/main/docs/PI-Web-API-Docs/COMMON_ACTION_README.md).
- [AVEVA Python read example](https://github.com/AVEVA/sample-pi_web_api-common_actions-python/blob/main/read_attributes.py): AF path resolution followed by stream recorded-value access.
- [AVEVA Python write example](https://github.com/AVEVA/sample-pi_web_api-common_actions-python/blob/main/write_attributes.py): Basic/Kerberos examples, `X-Requested-With`, and scalar stream HTTP 202 acknowledgement. openReconcile implements the Basic route and proxy bearer route described above.
- [Recorded values reference](https://docs.aveva.com/bundle/pi-web-api-reference/page/help/controllers/stream/actions/getrecorded.html) and [scalar update reference](https://docs.aveva.com/bundle/pi-web-api-reference/page/help/controllers/stream/actions/updatevalue.html). The installed service's version-specific help is the deployment reference for these endpoints and options.
