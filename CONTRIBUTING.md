# Contributing to openReconcile

Issues and pull requests are welcome. **@SavaStosic3 reviews contributions and controls final merges.** Contributors work in forks and submit pull requests to `main`; repository write access is not needed.

## Report a problem or propose a feature

Search [existing issues](https://github.com/SavaStosic3/openReconcile/issues) and the [roadmap](ROADMAP.md) first. Use the bug, calculation, or feature form when opening an issue. Include your commit/version, installation type, reproduction steps, and expected behavior.

For a calculation issue, include a small synthetic model, reporting period, readings, units, uncertainties, and an independently calculated expected result. Explain the balances or conversion assumptions. A closed balance alone does not establish meter accuracy.

Do not include plant-confidential data, passwords, connection strings, tokens, private certificates, or unredacted logs. Report security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/SavaStosic3/openReconcile/security/advisories/new), rather than a public issue.

## Make a contribution

For substantial features or changes to reconciliation mathematics, discuss the approach in an issue first. Small fixes and documentation improvements can go directly to a pull request.

1. Fork [openReconcile](https://github.com/SavaStosic3/openReconcile/fork) to your account.
2. Clone your fork and create a branch. Replace `YOUR_USERNAME` and choose a descriptive branch name:

   ```sh
   git clone https://github.com/YOUR_USERNAME/openReconcile.git
   cd openReconcile
   git remote add upstream https://github.com/SavaStosic3/openReconcile.git
   git switch -c fix/short-description
   ```

3. Install **Node.js 24.13 or later** and run the checks below.
4. Make a focused change with an appropriate regression test. Update the relevant documentation when behavior changes. Follow existing code conventions and preserve the standalone Docker and hosted deployment paths.
5. Commit and push your branch to your fork, then open a pull request targeting upstream `main`:

   ```sh
   git add path/to/changed-file
   git commit -m "Describe the change"
   git push -u origin fix/short-description
   ```

Use a draft pull request for unfinished work. Link the related issue and describe the problem, resulting behavior, validation, and any remaining limitations. Contributions are made under the project's [MIT License](LICENSE); retain third-party attribution.

## Validate your change

From the repository root:

```sh
npm ci
npm ci --prefix connectors/sql-gateway
npm test
npm run typecheck
npm run build
npm test --prefix connectors/sql-gateway
```

For standalone/deployment changes, also run `docker compose config --quiet`, `docker compose build`, and `npm run test:docker` with Linux containers available. The Docker check uses disposable fixtures. Local and CI checks do not prove real plant SQL/PI connectivity or production measurement accuracy; describe that verification separately.

For mathematics changes, verify conservation, units and reporting periods, uncertainty/covariance, observability, storage accumulation, and relevant physical bounds against an independent known case. Keep original readings intact and fail explicitly when valid results cannot be established.

## Review and merge

The required checks are **Application checks**, **SQL gateway tests**, and **docker**. They run on every pull request, including documentation changes. Workflows from outside contributors require maintainer approval before running.

@SavaStosic3 is the code owner and final merger. `main` requires a pull request, passing checks against the latest base, and resolved review conversations. Direct pushes, force pushes, and deletion of `main` are blocked. Auto-merge is disabled. Approval or passing CI does not give a contributor permission to merge.

Keep feedback respectful and focused on the work. The maintainer may request changes, defer proposals, or decline contributions that do not fit the product's scope.
