---
name: User profile
description: afl@figaf.com, owns the figaf-installer monorepo and deploys figaf-manager to customer BTP tenants
type: user
---

The user is afl@figaf.com (Alexandru-Daniel Florea per git config). They own and develop the `figaf-installer` monorepo — both the Electron desktop variant (`figaf-local`) and the cloud-hosted wizard (`figaf-manager`) that gets deployed into customer SAP BTP Cloud Foundry spaces.

For security audits: they want senior-engineer-readable risk registers with concrete file:line references, not checklist dumps. They prefer findings prioritized P0/P1/P2 with code-level remediation guidance. They reported the audit was triggered by observing leaked SSO output and unauthenticated public reachability of the deployed wizard — i.e., they're at the point of asking "what do I have to fix before more customers deploy this?".
