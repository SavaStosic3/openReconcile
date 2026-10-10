# Release checklist

Use this checklist for each release. Check an item only when its evidence is recorded for that release; local tests do not establish production readiness. Keep any incomplete operational checks visible.

Record: GitHub commit, Sites source commit, artifact/version ID, deployment URL, check date, and outstanding issues. Keep secrets and plant data out of release notes.

## Code and deployment

- [ ] Run `npm test`, `npm run typecheck`, and `npm run build` on the final source; record results and any limitations.
- [ ] Review the diff, documentation, and license notices; exclude secrets, local database state, and generated runtime files from Git.
- [ ] Commit and push to the intended GitHub branch. Confirm the local tree is clean and its commit matches the remote.
- [ ] Confirm the Sites source checkout matches the reviewed source, and package the build produced from that source. Record both source commits and the artifact/version ID.
- [ ] Preserve the existing project ID, database binding, audience, and authentication configuration unless the release explicitly changes them.
- [ ] Deploy that saved version, confirm a successful deployment, and check the live URL and served assets. Record which checks ran locally and which ran on the live application.

## Data and access

- [ ] Review pending ordered migrations and their metadata. Keep applied migrations unchanged; use schema-only migrations and bounded, separate initialization when needed. Never seed or replace existing plant data as part of deployment.
- [ ] Verify a migration against an existing-data copy preserves models, published snapshots, grants, schedules, and runs. Check that only pending migrations are applied by the host.
- [ ] Confirm an authorized database backup/export and a tested restoration procedure are available for the release. Model JSON export alone does not back up users, grants, schedules, or run history.
- [ ] Record the previous deployed version and a rollback/recovery plan compatible with the new database schema. Confirm who can execute it.
- [ ] Check signed-out API denial and real sign-in through the trusted Sites authentication dispatch. Keep local simulated identities and administrator secrets out of the deployed client.
- [ ] Exercise administrator, editor, operator, viewer, disabled-account, and no-model-grant access. Confirm backend enforcement, editing/unpublishing locks, and administrator-only deletion/restoration.

## Reconciliation and model workflow

- [ ] Reconcile a known example: feed/outlet readings `100/60/35 kg`, uncertainties `1/2/2 kg`, produce `99.444444/62.222222/37.222222 kg`; the internal flow is `99.444444 kg`. Check unit closure and displayed rounding.
- [ ] Confirm inferred, unobservable, invalid, and failed-run states do not present fabricated values. Check saved history and results export.
- [ ] Edit and test a draft while its published copy and published results remain unchanged. Publish changes; the new version must await its own run before displaying values.
- [ ] Run the publication, reopen it, and inspect stream masses and incoming/outgoing totals above symbols. Confirm the results belong to that publication version and input snapshot.
- [ ] Drag common equipment symbols, connect their ports, move units, and change a symbol. Confirm connection endpoints and properties survive saving and reopening.
- [ ] Test an enabled schedule with an eligible browser session open; confirm a due run uses the publication and two sessions cannot claim the same occurrence. Confirm overdue reopening runs once, and unpublishing/deleting pauses the schedule. Record that unattended scheduling is not supported.

## Hidden lines and diagram usability

- [ ] Hide a line from its inspector and context menu. **Hidden lines** must list only hidden streams with their endpoints and a **Restore** button; visible streams must not appear in that list.
- [ ] Restore one line, use **Restore all**, and confirm the empty state reads clearly. Toggle **Show hidden lines** to reveal hidden streams temporarily without clearing their hidden preference.
- [ ] Repeat in the read-only published view. Confirm hiding/restoring does not edit the model, change its publication version, invalidate results, or remove streams from reconciliation or exports.
- [ ] Reopen the app and switch accounts/models; confirm preferences persist per account/model in that browser, without leaking between accounts or models.
- [ ] Check bridge bumps at perpendicular crossings, no bumps at real shared ports/touching endpoints, and updated bridges after moving or hiding a line.
- [ ] Check keyboard access, focus after restoring a row, accessible control names, and narrow layouts. Confirm diagram controls and published result labels remain usable.

## Closeout

- [ ] Update the README, roadmap, and release notes to match delivered behavior and current limits.
- [ ] Record remaining operational or live checks and assign follow-up work. Do not mark a release ready based only on local automated checks.
