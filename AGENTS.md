# Project privacy rules

The owner intends to release this app. Treat every repository file, commit,
issue, pull request, CI output, package and release asset as future public
material, even while the repository is private.

- Include only source code, generic documentation and invented demo/test data.
- Never store or publish personal names, contact details, usernames, real chat
  titles, contact lists, messages, media, account IDs, credentials, auth inputs,
  TDLib sessions/databases, personal filesystem paths or real-account captures.
- Keep necessary live account storage outside the repository in the private
  data directory. Do not copy it into fixtures, debugging files or artifacts.
- Use project attribution and a reserved `.invalid` author email for automated
  commits. Do not copy the machine's personal Git identity into new commits.
- Use reserved `.invalid`, `.test` or example domains for email fixtures. Use
  generic home-directory placeholders in documentation.
- Real account inputs belong only in the user's local app. Do not inspect or
  capture the browser after real login starts. Validate UI with synthetic
  clients or demo mode. Public screenshots and videos must use demo mode and
  exclude startup tokens and personal browser/desktop chrome.
- Run the privacy guard before commits and pushes. Review changes manually;
  detection rules cannot identify every name, identifier or secret.
- Before public release, audit all Git history, commit metadata/messages,
  issues/PRs, CI logs and release assets. Never claim anonymity based on a scan
  of the latest files alone. GitHub itself shows the hosting account.
- Keep the repository private until the owner explicitly requests publication.
  Prepare a concrete cleanup before asking permission to replace published
  history. Do not force-push a history rewrite without explicit authorization.

Do not put the owner's identity or sensitive terms in this file. Any private
word list stays in the external live data directory and is never committed.
