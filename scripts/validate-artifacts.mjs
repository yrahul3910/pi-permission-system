import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const permissionStates = new Set(["allow", "deny", "ask"]);

function readJson(relativePath) {
  const filePath = join(root, relativePath);
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validatePermissionStateMap(sectionName, value) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${sectionName} must be an object`);
  for (const [key, state] of Object.entries(value)) {
    assert(typeof key === "string" && key.length > 0, `${sectionName} contains an empty key`);
    assert(permissionStates.has(state), `${sectionName}.${key} must be one of allow, deny, ask`);
  }
}

function validateDefaultPolicy(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "defaultPolicy must be an object");
  for (const key of ["tools", "bash", "mcp", "skills", "special"]) {
    assert(permissionStates.has(value[key]), `defaultPolicy.${key} must be one of allow, deny, ask`);
  }
}

function validateBashRuleList(name, value) {
  if (value === undefined) {
    return;
  }
  assert(Array.isArray(value), `${name} must be an array of prefix rule strings`);
  for (const entry of value) {
    assert(typeof entry === "string" && entry.trim().length > 0, `${name} entries must be non-empty strings`);
  }
}

function validateBashSection(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "bash must be an object");
  for (const listName of ["allow", "ask", "deny"]) {
    validateBashRuleList(`bash.${listName}`, value[listName]);
  }
  if (value.syntax !== undefined) {
    assert(value.syntax && typeof value.syntax === "object" && !Array.isArray(value.syntax), "bash.syntax must be an object");
    for (const [key, state] of Object.entries(value.syntax)) {
      assert(["subshells", "unanalyzable"].includes(key), `bash.syntax.${key} is not a recognized key`);
      assert(permissionStates.has(state), `bash.syntax.${key} must be one of allow, deny, ask`);
    }
  }
  if (value.registryOverrides !== undefined) {
    assert(
      value.registryOverrides && typeof value.registryOverrides === "object" && !Array.isArray(value.registryOverrides),
      "bash.registryOverrides must be an object",
    );
  }
}

function validatePolicyExample(config) {
  validateDefaultPolicy(config.defaultPolicy);
  for (const section of ["tools", "mcp", "skills", "special"]) {
    if (config[section] !== undefined) {
      validatePermissionStateMap(section, config[section]);
    }
  }
  if (config.bash !== undefined) {
    validateBashSection(config.bash);
  }
  if (config.protectedPaths !== undefined) {
    validateBashRuleList("protectedPaths", config.protectedPaths);
  }
}

// This fork intentionally does not ship a root config.json: it is gitignored and
// omitted from the published "files" list so installs fall back to runtime defaults
// (see commit af1b531). The shipped policy artifact is config/config.example.json,
// which is fully validated by validatePolicyExample() below.

const schema = readJson("schemas/permissions.schema.json");
const specialProperties = schema?.properties?.special?.properties;
assert(specialProperties && typeof specialProperties === "object", "schema special properties must be present");
assert(!Object.prototype.hasOwnProperty.call(specialProperties, "tool_call_limit"), "schema must not expose unsupported special.tool_call_limit");
assert(Object.prototype.hasOwnProperty.call(specialProperties, "external_directory"), "schema must expose special.external_directory");

validatePolicyExample(readJson("config/config.example.json"));

const packageJson = readJson("package.json");
assert(packageJson.scripts?.typecheck?.includes("tsc"), "package.json must expose a TypeScript typecheck script");
assert(!packageJson.scripts?.build?.includes("--noCheck"), "package.json build must not disable TypeScript checks");
assert(packageJson.engines?.bun === undefined, "package.json engines must not require Bun for tests");
assert(packageJson.scripts?.test?.includes("tsx"), "package.json test script must use the Node.js-compatible tsx runner");
assert(!packageJson.scripts?.test?.includes("bun "), "package.json test script must not invoke Bun");

const readme = readFileSync(join(root, "README.md"), "utf8");
assert(!readme.includes("tool_call_limit"), "README must not document unsupported special.tool_call_limit");
assert(readme.includes("npm run validate:artifacts"), "README development commands must include artifact validation");

console.log("Artifact validation passed.");
