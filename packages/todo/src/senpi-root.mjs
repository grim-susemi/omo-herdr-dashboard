// Resolve and load the installed Senpi SDK read-only.
//
// There is deliberately no default root, no environment lookup and no fallback
// to an ambient/public runtime: a caller that forgets `--senpi-root` gets an
// explicit error instead of a silent import from somewhere else.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SDK_PACKAGE_NAME = '@code-yeongyu/senpi';

/** Native entry points the host harness loads from the SDK root. */
export const REQUIRED_MODULES = Object.freeze({
  resourceLoader: 'dist/core/resource-loader.js',
  settingsManager: 'dist/core/settings-manager.js',
  sessionManager: 'dist/core/session-manager.js',
  runner: 'dist/core/extensions/runner.js',
  interactiveMode: 'dist/modes/interactive/interactive-mode.js',
  theme: 'dist/modes/interactive/theme/theme.js',
  todoState: 'dist/core/extensions/builtin/todotools/state.js',
  builtinIndex: 'dist/core/extensions/builtin/index.js',
});

export class SenpiRootError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SenpiRootError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Validate a `--senpi-root` path and return its identity.
 * Throws SenpiRootError with a stable code; never returns a fallback root.
 */
export function resolveSenpiRoot(root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new SenpiRootError('MISSING_ARGUMENT',
      'A --senpi-root path is required; this harness never falls back to an installed or public runtime.');
  }
  const absolute = resolve(root);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new SenpiRootError('MISSING_ROOT', `--senpi-root is not an existing directory: ${absolute}`, { root: absolute });
  }
  const manifestPath = join(absolute, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new SenpiRootError('MISSING_MANIFEST', `--senpi-root has no package.json: ${absolute}`, { root: absolute });
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new SenpiRootError('INVALID_MANIFEST',
      `--senpi-root package.json is not valid JSON (${manifestPath}): ${error.message}`, { root: absolute });
  }
  if (manifest.name !== SDK_PACKAGE_NAME) {
    throw new SenpiRootError('NOT_SDK',
      `--senpi-root is not ${SDK_PACKAGE_NAME} (package name: ${JSON.stringify(manifest.name ?? null)}): ${absolute}`,
      { root: absolute, name: manifest.name ?? null });
  }
  const missing = Object.values(REQUIRED_MODULES).filter(relative => !existsSync(join(absolute, relative)));
  if (missing.length > 0) {
    throw new SenpiRootError('MISSING_MODULE',
      `--senpi-root ${absolute} is missing native modules: ${missing.join(', ')}`, { root: absolute, missing });
  }
  return { root: absolute, version: manifest.version ?? null, manifest, modules: REQUIRED_MODULES };
}

/** Assert the resolved SDK version against a recorded expectation. */
export function assertSenpiVersion(info, expectedVersion) {
  if (expectedVersion && info.version !== expectedVersion) {
    throw new SenpiRootError('VERSION_MISMATCH',
      `--senpi-root version mismatch: expected ${expectedVersion}, found ${String(info.version)}`,
      { root: info.root, expected: expectedVersion, actual: info.version ?? null });
  }
  return info;
}

/** Load the native modules the harness uses. Dynamic import only from `--senpi-root`. */
export async function loadNativeModules(root) {
  const info = resolveSenpiRoot(root);
  const load = relative => import(pathToFileURL(join(info.root, relative)).href);
  const [resourceLoader, settingsManager, sessionManager, runner, interactiveMode, theme, todoState] =
    await Promise.all([
      load(REQUIRED_MODULES.resourceLoader),
      load(REQUIRED_MODULES.settingsManager),
      load(REQUIRED_MODULES.sessionManager),
      load(REQUIRED_MODULES.runner),
      load(REQUIRED_MODULES.interactiveMode),
      load(REQUIRED_MODULES.theme),
      load(REQUIRED_MODULES.todoState),
    ]);
  return {
    info,
    DefaultResourceLoader: resourceLoader.DefaultResourceLoader,
    SettingsManager: settingsManager.SettingsManager,
    SessionManager: sessionManager.SessionManager,
    ExtensionRunner: runner.ExtensionRunner,
    InteractiveMode: interactiveMode.InteractiveMode,
    initTheme: theme.initTheme,
    getLatestTodoStateFromBranchEntries: todoState.getLatestTodoStateFromBranchEntries,
  };
}
