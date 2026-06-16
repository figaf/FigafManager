"use strict";
// Tests for the manifest.yml name-rewrite helper used by update:pushSelf.
// Run via `node --test packages/core/manifest-patch.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { patchManifestName } = require("./manifest-patch");

const SAMPLE_MANIFEST = `# CF manifest for Figaf Manager
applications:
  - name: figaf-manager
    memory: 128M
    disk_quota: 512M
    instances: 1
    buildpack: nodejs_buildpack
    command: node cloud/server.js
    random-route: true
    env:
      NODE_ENV: production
      FIGAF_LOG_LEVEL: cli
`;

test("patchManifestName rewrites the application name", () => {
  const out = patchManifestName(SAMPLE_MANIFEST, "my-custom-figaf");
  assert.match(out, /^\s+- name: my-custom-figaf$/m);
  // Must NOT leave the old name behind anywhere.
  assert.doesNotMatch(out, /figaf-manager\b/);
  // Other fields must be untouched.
  assert.match(out, /memory: 128M/);
  assert.match(out, /command: node cloud\/server\.js/);
  assert.match(out, /FIGAF_LOG_LEVEL: cli/);
});

test("patchManifestName is a no-op when name already matches", () => {
  const out = patchManifestName(SAMPLE_MANIFEST, "figaf-manager");
  assert.equal(out, SAMPLE_MANIFEST);
});

test("patchManifestName leaves env vars that look like names alone", () => {
  // The env block has lines like `NODE_ENV: production`. The regex must
  // only touch a `- name:` line at the application level, not env keys.
  const m = `applications:
  - name: figaf-manager
    env:
      name: not-actually-the-app-name
`;
  const out = patchManifestName(m, "new-name");
  assert.match(out, /^\s+- name: new-name$/m);
  assert.match(out, /name: not-actually-the-app-name/);
});

test("patchManifestName tolerates extra whitespace around the name token", () => {
  const m = `applications:
  -   name:   figaf-manager
    memory: 128M
`;
  const out = patchManifestName(m, "new-name");
  assert.match(out, /name:\s+new-name/);
});

test("patchManifestName throws if no application name found", () => {
  assert.throws(
    () => patchManifestName("applications:\n  - memory: 128M\n", "new-name"),
    /no application name/i
  );
});
