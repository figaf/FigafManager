"use strict";
// Minimal regex-based rewrite of the manifest.yml application name. Used by
// update:pushSelf so the cf push targets the operator's actual app name
// (whatever VCAP_APPLICATION.application_name reports), not the literal
// `figaf-manager` baked into the bundled manifest.
//
// Why regex and not js-yaml: the manifest is a controlled artifact we
// generate from this repo, so its format is predictable — a single
// `applications:` block with `- name: <token>` at the top. Adding a YAML
// parser dependency for one field rewrite is not worth ~60KB.
//
// Pattern: matches the FIRST `- name: <token>` line under an
// `applications:` block. Captures leading whitespace + indent so the
// rewrite preserves the original indentation exactly. Env vars or any
// other `name:` keys deeper in the document are unaffected (they don't
// have the leading `-`).

const NAME_LINE_RE = /^(\s*-\s+name:\s+)\S+/m;

function patchManifestName(yaml, newName) {
  if (!NAME_LINE_RE.test(yaml)) {
    throw new Error("manifest-patch: no application name line found");
  }
  return yaml.replace(NAME_LINE_RE, `$1${newName}`);
}

module.exports = { patchManifestName };
