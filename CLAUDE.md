# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

This is a deployment configuration repository for **Figaf Tool** on **SAP Business Technology Platform (BTP)** Cloud Foundry. It contains no application source code — only infrastructure-as-code, configuration templates, and deployment scripts.

## Deployment Commands

All deployment uses the SAP BTP CLI (`btp`) and Cloud Foundry CLI (`cf`).

**Login:**
```sh
btp login --sso
cf login -a https://api.cf.<LANDSCAPE_DOMAIN> --sso
```

**Service creation (run once, then poll until status = `create succeeded`):**
```sh
cf create-service postgresql-db <plan> figaf-db -c db.json
cf create-service xsuaa application figaf-xsuaa -c xs-security.json
cf service figaf-db
cf service figaf-xsuaa
```

**User role assignment:**
```sh
btp list security/user --subaccount <SUBACCOUNT_ID>
btp assign security/role-collection "Figaf IRT Admin" --to-user <EMAIL> --subaccount <SUBACCOUNT_ID>
```

**Deploy:**
```sh
cd Figaf-BTP-Deployment-btp-users
cf push --vars-file vars.yml
```

**Approuter dependencies (only needed if modifying `approuter/package.json`):**
```sh
cd Figaf-BTP-Deployment-btp-users/approuter
npm install
```

## Architecture

The deployment consists of two Cloud Foundry apps and two managed services, all configured in [Figaf-BTP-Deployment-btp-users/manifest.yml](Figaf-BTP-Deployment-btp-users/manifest.yml):

```
User → approuter (Node.js, @sap/approuter) → figaf-app (Docker: figaf/app:<VERSION>)
                     ↓                                  ↓
              figaf-xsuaa (XSUAA)              figaf-db (PostgreSQL 16)
```

- **approuter** — SAP standard application router handling OAuth2 login/session and proxying requests to `figaf-app`. Routing rules are in [Figaf-BTP-Deployment-btp-users/approuter/xs-app.json](Figaf-BTP-Deployment-btp-users/approuter/xs-app.json).
- **figaf-app** — Docker image `figaf/app:<DOCKER_IMAGE_VERSION>`, runs on port 8080. Receives forwarded requests from the approuter.
- **figaf-db** — PostgreSQL 16 managed service with extensions: ltree, citext, pgcrypto, hstore, btree_gist, btree_gin, pg_trgm, uuid-ossp.
- **figaf-xsuaa** — XSUAA OAuth2 service defining 18 role scopes (IRTAdmin, IRTUser, IRTConfigurator, IRTOperator, IRTManager, IRTSensitivePayloadViewer, IRTDevOpsOperator, etc.). Defined in [Figaf-BTP-Deployment-btp-users/xs-security.json](Figaf-BTP-Deployment-btp-users/xs-security.json).

## Key Configuration Files

| File | Purpose |
|------|---------|
| [Figaf-BTP-Deployment-btp-users/manifest.yml](Figaf-BTP-Deployment-btp-users/manifest.yml) | CF deployment manifest — app names, memory, Docker image, service bindings |
| [Figaf-BTP-Deployment-btp-users/vars.yml](Figaf-BTP-Deployment-btp-users/vars.yml) | Variable template — fill in `ID`, `LANDSCAPE_DOMAIN`, `DOCKER_IMAGE_VERSION`, `LOCATION_ID`, Docker registry credentials |
| [Figaf-BTP-Deployment-btp-users/xs-security.json](Figaf-BTP-Deployment-btp-users/xs-security.json) | XSUAA role definitions and role collections |
| [Figaf-BTP-Deployment-btp-users/db.json](Figaf-BTP-Deployment-btp-users/db.json) | PostgreSQL service parameters (extensions, version) |
| [Figaf-BTP-Deployment-btp-users/approuter/xs-app.json](Figaf-BTP-Deployment-btp-users/approuter/xs-app.json) | Approuter routing rules and authentication config |

## Full Deployment Guide

Step-by-step instructions are in [instructions.md](instructions.md). BTP CLI command reference is in [BTP-CLI/bttp-cli-commands.md](BTP-CLI/bttp-cli-commands.md).
