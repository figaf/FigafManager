# Screenshots for the user manual

Images referenced by [../USER-MANUAL.md](../USER-MANUAL.md). Drop the files in this
directory using exactly the filenames below and they will resolve.

## Naming

`<section>-<order>-<slug>.png` — section number from the manual, order within that
section, then a short slug. Keep the names as-is; the manual links to them literally.

PNG, actual-size browser screenshots. Crop to the wizard window (or the relevant cockpit
panel) rather than the whole desktop. Redact any real setup token, service key, tenant
subdomain or user name before committing.

## Shot list

| File | What to capture |
|---|---|
| `01-01-layout.png` | The whole wizard window on any screen: step rail on the left, main pane, collapsed **CLI details** bar at the bottom. |
| `03-01-cockpit-deploy.png` | BTP cockpit **Deploy Application** dialog with the zip as application archive and `manifest.yml` as deployment descriptor. |
| `03-02-app-started.png` | The space's application list with `figaf-manager` in state **Started**. |
| `03-03-route.png` | The `figaf-manager` application page showing its generated route. |
| `04-01-cockpit-log-token.png` | Cockpit **Logs** tab with the `[SETUP] Token:` line visible. **Redact the token value.** |
| `04-02-setup-page.png` | The `/setup` page — *Figaf Installer — Setup*, the token field, **Claim and continue** / **Show**. |
| `05-01-welcome.png` | Step 1 · Welcome with all prerequisite rows green, including the **Installer version** row. |
| `05-02-login.png` | Step 2 · Authenticate, both cards visible, before signing in. |
| `05-03-account-pickers.png` | The **Choose a global account** or **Choose a subaccount** list — ideally one showing a greyed-out **No CF** entry. |
| `05-04-passcode.png` | The **One-time passcode** field with **Paste** and **Continue**. Do not capture a real passcode. |
| `05-05-choice.png` | Step 3 · Choose action with all four tiles. |
| `06-01-xsuaa-before.png` | The persistent-login screen before starting: target check row, the **Assign me FigafManagerAdmin** checkbox, the phase list all pending. |
| `06-02-xsuaa-running.png` | The same screen mid-run, with some phases done and one running. |
| `06-03-xsuaa-done.png` | The green success panel with **Continue** enabled. |
| `06-04-assign-role.png` | The manual role-assignment fallback screen with its four numbered steps. |
| `07-01-config-general.png` | Step 4 · Configuration, upper half — General and Application settings. |
| `07-02-config-services.png` | Step 4, lower half — CF services checkboxes, database service name, plan cards. |
| `07-03-provision.png` | Step 5 · Provisioning with rows in mixed states (one running, others done). |
| `07-04-deploy.png` | Step 6 · Deploy while pushing. |
| `07-05-done.png` | Step 7 · Finish with the summary grid and footer buttons. |
| `08-01-update-config.png` | Step 4 · Configure update — detected deployment, target tag dropdown, both strategy options. |
| `08-02-update-progress.png` | Step 5 · Apply update with phases running. |
| `09-01-connect-provision.png` | Step 4 · Provision with all four rows done and both key cards visible. **Redact the key contents.** |
| `09-02-connect-idp.png` | Step 5 · BTP access, all four identity tiles. |
| `09-03-saml-trust.png` | Step 6 · the three numbered SAML-trust instructions, ideally with the **?** hint popover open. |
| `09-04-connect-assign.png` | Step 7 · the three PI role rows and the SSO URL block. |
| `10-01-update-banner.png` | The floating **Installer update available** banner on a post-login screen. |
| `10-02-update-preflight.png` | The **Self-update — figaf-manager** dialog showing the three comparison rows. |
