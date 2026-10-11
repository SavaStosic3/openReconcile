# Repository contribution and merge controls

openReconcile uses public issues and fork-based contributions. Contributors can create branches in their own forks and open pull requests without write access to this repository. @SavaStosic3 retains the administrator role and controls final merges. Do not grant administrator access to ordinary contributors: that role also permits changes to repository rules.

## Community entry points

- [Contribution guide](../CONTRIBUTING.md): development setup, verification, and review expectations.
- [Issue forms](../.github/ISSUE_TEMPLATE/): bug reports, calculation issues, and feature requests.
- [Pull request template](../.github/pull_request_template.md): problem, resulting behavior, and validation.
- [CODEOWNERS](../.github/CODEOWNERS): review requests route to @SavaStosic3, including ownership and workflow changes.
- Security vulnerabilities use GitHub's private reporting form. Public issues and pull requests must not contain secrets or confidential plant data.

## Main branch rules

Two GitHub rulesets protect the default branch. Their version-controlled definitions are in [.github/rulesets](../.github/rulesets/). Committing these files alone does not activate GitHub protection; the maintainer must apply them in **Settings → Rules → Rulesets** or through the GitHub API.

1. **Maintainer-only main updates** restricts updates to the repository administrator role, through pull requests only. Force pushes and deletion are blocked. Ordinary write-access collaborators cannot merge to `main`, even after a review or successful CI.
2. **Pull requests and required checks** requires a pull request, resolved review conversations, squash merging, and successful **Application checks**, **SQL gateway tests**, and **docker** checks against the latest base. This ruleset has no bypass actors, so the maintainer's merge access does not bypass CI.

The approving-review count is deliberately zero: GitHub does not allow an author to approve their own pull request, and this project currently has one maintainer. CODEOWNERS requests their review of outside contributions, and the administrator-only merge gate reserves the final decision to them. If additional maintainers are appointed, reconsider required reviews and administrator access together.

Auto-merge is disabled; merged feature branches are deleted automatically. Maintainer changes also use branches and pull requests. Do not temporarily disable protection for routine changes.

## Workflow permissions

Both workflows use `pull_request`, read-only `contents` permissions, GitHub-hosted runners, and checkout without persisted credentials. They do not use `pull_request_target`, deploy the application, or pass production secrets to contributor code. Official Actions are pinned to reviewed commit SHAs.

All outside-contributor workflow runs require maintainer approval. Read the proposed workflow/code before approving execution. Approval to run CI and permission to merge are separate decisions.

The Docker workflow runs on every pull request, without path filters. A required workflow skipped by a path filter can otherwise leave a documentation-only pull request waiting for a check that never starts.

## Maintainer review sequence

1. Review the issue, diff, migrations, and independent calculation evidence where relevant.
2. Approve outside-contributor workflow execution after inspecting the proposed code.
3. Resolve feedback and have the author update the branch when the base changes.
4. Confirm all three required checks pass and inspect any validation limits.
5. Squash-merge the pull request yourself. Do not enable automatic merging.

A passing fixture is not evidence of real plant connector access or measurement correctness. Retain installation-specific acceptance checks in the [release checklist](../RELEASE_CHECKLIST.md).

GitHub [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository) are available for public repositories on GitHub Free. A private repository requires a supporting paid plan. If moving or copying the project, verify live settings and collaborator roles; configuration files do not transfer active protection automatically.
