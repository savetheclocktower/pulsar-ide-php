const { CompositeDisposable } = require('atom');
const Path = require('path');
const FS = require('fs');
const {
  AutoLanguageClient,
  Convert
} = require('@savetheclocktower/atom-languageclient');

const ROOT = Path.normalize(Path.join(__dirname, '..'));

// Convert Pulsar’s `core.ignoredNames` into the sort of path globs that
// Intelephense expects for `files.exclude`.
//
// The two settings aren’t quite the same shape: `core.ignoredNames` matches a
// file or directory’s _name_, whereas `files.exclude` matches its full path.
// So each name becomes two globs, and we need both of them:
//
// * The `**/{name}/**` form is what excludes the _contents_ of a directory.
//   Intelephense matches these globs against individual file paths, so this is
//   the form that does the real work for something like `.git`.
// * The bare `**/{name}` form looks redundant, since micromatch lets a
//   trailing globstar match zero path segments — `**/.git/**` happily matches
//   `.git` itself, which is why Intelephense’s own defaults can get away with
//   listing `.DS_Store` in that form even though it’s never a directory. But
//   that shortcut stops working for a dotted wildcard: the globstar form of
//   `._*` fails to match `._foo.php`, while the bare form matches it. And
//   `._*` is one of Pulsar’s default ignored names.
//
// Anything that already looks like a path glob is passed through untouched.
function convertIgnoredNamesToGlobs (ignoredNames = []) {
  let globs = [];
  for (let name of ignoredNames) {
    if (!name) continue;
    if (name.includes('/')) {
      globs.push(name);
    } else {
      globs.push(`**/${name}`, `**/${name}/**`);
    }
  }
  return globs;
}

const CONFIG_FILE_NAME = 'intelephense.config.json';

// How long the licence key has to stay unchanged before we act on it. Long
// enough that typing a key by hand doesn't restart the server several times
// over; short enough that a paste feels immediate.
const LICENSE_KEY_DEBOUNCE_MS = 1000;

function isPlainObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Merge `source` over `target`, recursing into plain objects. Arrays are
// replaced wholesale rather than concatenated — if a project says which stubs it
// wants, it means _those_ stubs, not those plus ours.
function deepMerge (target, source) {
  if (!isPlainObject(source)) return source;
  if (!isPlainObject(target)) return { ...source };

  let result = { ...target };
  for (let [key, value] of Object.entries(source)) {
    result[key] = key in target ? deepMerge(target[key], value) : value;
  }
  return result;
}

// Read a project's `intelephense.config.json`, if it has one.
//
// Intelephense knows how to read this file itself, but only for clients that
// _don't_ support `workspace/configuration` — and we do, so that code path is
// dead for us and we have to do the reading. The file may be either a bare
// settings object or one wrapped in an `intelephense` key; the server accepts
// both, so we should too.
async function readProjectConfigFile (projectPath) {
  if (!projectPath) return null;
  let configPath = Path.join(projectPath, CONFIG_FILE_NAME);
  let contents;
  try {
    contents = await FS.promises.readFile(configPath, 'utf8');
  } catch (err) {
    // A project without one of these files is the common case, not an error.
    if (err.code !== 'ENOENT') {
      console.warn(`Could not read ${configPath}:`, err.message);
    }
    return null;
  }

  try {
    let parsed = JSON.parse(contents);
    if (!isPlainObject(parsed)) return null;
    return isPlainObject(parsed.intelephense) ? parsed.intelephense : parsed;
  } catch (err) {
    atom.notifications.addWarning(
      `${CONFIG_FILE_NAME} could not be parsed`,
      {
        description: `The file at \`${configPath}\` is not valid JSON, so it will be ignored.`,
        detail: err.message,
        dismissable: true
      }
    );
    return null;
  }
}

class IntelephenseLanguageClient extends AutoLanguageClient {
  enableAutocomplete = true

  determineProjectPath(textEditor) {
    // If this is a project, use the project root…
    let result = super.determineProjectPath(textEditor);
    if (result) return result;
    // …but fall back to the buffer's directory if it exists.

    // TODO: Decide whether to make this configurable. I think it's fine as
    // implicit behavior, but if it causes any problems, we can revisit this
    // and add an opt-out via config.
    let bufferPath = textEditor.getPath();
    if (bufferPath) return Path.dirname(bufferPath);
    return undefined;
  }

  onSpawnError(err) {
    // `atom-languageclient` seems to think it'll be able to detect failed
    // spawns in its `catch` clause. But an ordinary `spawn` that exits with a
    // non-zero code doesn't seem to do the trick, and it's not clear to me how
    // I'm meant to inform the server manager of this failure.
    //
    // Instead, I need to clear this promise from the registry or else it'll
    // hang forever and we'll never be able to restart cleanly.
    this._serverManager._startingServerPromises.clear();

    this.errorNotification = atom.notifications.addError(
      `${this.getPackageName()}: ${this.getServerName()} language server cannot start`,
      {
        description: `The ${this.getServerName()} language server failed to start. Check the settings below — in particular the **Memory Limit** under **Advanced** — and consult the README for more information.`,
        detail: err.message,
        buttons: [
          {
            text: 'Open Settings',
            onDidClick: () => {
              atom.workspace.open(`atom://config/packages/${this.getPackageName()}`);
            }
          }
        ],
        dismissable: true
      }
    );
  }

  // Check if we need to migrate config settings from an old package name.
  checkConfigMigration(oldPackageName, newPackageName) {
    if (oldPackageName === newPackageName) {
      // Package hasn’t been renamed yet! Be patient.
      return;
    }
    let oldSettings = atom.config.get(
      `${oldPackageName}`,
      { sources: [atom.config.mainSource] }
    );
    let newSettings = atom.config.get(
      `${newPackageName}`,
      { sources: [atom.config.mainSource] }
    );

    // Don’t migrate if there’s nothing to migrate — or if the user has already
    // set some config values at the new location.
    if (!oldSettings || newSettings) return;

    atom.notifications.addInfo(
      `${this.getPackageName()}: Migrated configuration`,
      {
        description: `This package’s name has changed from \`${oldPackageName}\` to \`${newPackageName}\`. Your existing configuration values have been migrated to the new setting path.`,
        dismissable: true
      }
    );
  }

  activate(...args) {
    super.activate(...args);
    let packageName = this.getPackageName();

    this.subscriptions = new CompositeDisposable();

    this.subscriptions.add(
      // `atom-languageclient` notifies the servers whenever _our_ config
      // changes, but it can’t know that we also read `core.ignoredNames`, so we
      // have to nudge them ourselves.
      atom.config.onDidChange('core.ignoredNames', () => {
        this.notifyServersOfConfigurationChange();
      }),

      // Likewise, a server only re-reads its configuration when we tell it that
      // something changed — so an edit to a project's `intelephense.config.json`
      // has to be relayed by hand, or it wouldn't take effect until the next
      // time the server started.
      atom.project.onDidChangeFiles((events) => {
        let touched = events.some(
          ({ path, oldPath }) => {
            return Path.basename(path) === CONFIG_FILE_NAME ||
              (oldPath && Path.basename(oldPath) === CONFIG_FILE_NAME);
          }
        );
        if (touched) this.notifyServersOfConfigurationChange();
      }),

      // The licence key is read exactly once, when the server initializes: it's
      // sent in `initializationOptions`, and the server decides there and then
      // which premium features to advertise. Nothing later re-checks it, and
      // Intelephense never dynamically registers those capabilities afterward.
      // So the only way to make a newly entered key take effect is to start the
      // server over.
      atom.config.onDidChange(
        `${packageName}.intelephense.licenseKey`,
        () => this.restartServersForLicenseKeyChange()
      ),

      atom.config.onDidChange(
        `${packageName}.autocomplete.enable`,
        (newValue) => this.enableAutocomplete = newValue
      )
    );

    this.promptForJsconfigJson();

    this.commandDisposable = atom.commands.add(
      'atom-workspace',
      {
        [`${packageName}:start-language-server`]: () => {
          // This command doesn't do anything on its own. Its purpose is to
          // start the language server manually when the user wants to use it
          // for non-PHP files. It only has that effect because this command is
          // defined in `activationCommands` in `package.json`.
          //
          // The main method of auto-activating this package is via
          // `activationHooks` — it'll activate whenever a user opens a
          // PHP file for editing.
          //
          // This command is thus available as an explicit activation trigger
          // alongside these hooks. It's not obvious why someone would want to
          // start a PHP language server if they're not actually editing any
          // PHP files, but I won't rule out the possiblity altogether.
          //
          // It'd be rude to start the language server 100% of the time, and
          // there's no way to programmatically add to the list of
          // `activationHooks` present in `package.json`, so the compromise
          // option is to provide automatic startup for obvious PHP files and
          // ask the user to invoke startup for everything else.
          console.debug(`Starting language server...`);
        },

        [`${packageName}:restart-language-server`]: async () => {
          // Restarts the language server. This is useful as a debugging step
          // or if you switch Git branches and want a blank slate. (The
          // language server ought to adapt to changes like that, but there are
          // no guarantees.)
          try {
            await this.restartAllServers();
            atom.notifications.addSuccess(`Restarted ${this.getServerName()}`);
          } catch (err) {
            console.error(`Error restarting ${this.getServerName()}`);
            console.error(err);
            atom.notifications.addError(
              `Failed to restart ${this.getServerName()}`,
              { description: err.message }
            )
          }
        },
      }
    );
  }

  deactivate(...args) {
    super.deactivate(...args);
    if (this._licenseKeyTimeout) {
      clearTimeout(this._licenseKeyTimeout);
      this._licenseKeyTimeout = null;
    }
    this.subscriptions.dispose();
    this.commandDisposable.dispose();
  }

  getRootConfigurationKey() {
    return `${this.getPackageName()}`;
  }

  // Intelephense asks us for its settings via `workspace/configuration`, so we
  // opt into having `atom-languageclient` answer those requests for us.
  supportsWorkspaceConfiguration() {
    return true;
  }

  // Intelephense asks for a single configuration section called `intelephense`,
  // so all we have to do is hand back the subtree of our own config that has
  // deliberately been given the same shape.
  mapConfigurationObject (config) {
    let intelephense = { ...(config?.intelephense ?? {}) };

    // Intelephense spells this the Commonwealth way. We spell it the way most
    // of our users will look for it, then translate on the way out.
    let { licenseKey } = intelephense;
    delete intelephense.licenseKey;
    if (licenseKey) intelephense.licenceKey = licenseKey;

    // Pulsar already knows most of the names the user wants left alone, so our
    // own `exclude` setting only has to describe the things that are specific
    // to PHP projects.
    intelephense.files = {
      ...(intelephense.files ?? {}),
      exclude: [
        ...convertIgnoredNamesToGlobs(atom.config.get('core.ignoredNames')),
        ...(intelephense.files?.exclude ?? [])
      ]
    };

    return { intelephense };
  }

  // Answer the server's `workspace/configuration` requests.
  //
  // We override this instead of leaving it to `atom-languageclient` because we
  // care about the `scopeUri` on each requested item. Intelephense asks for the
  // `intelephense` section once with no scope — the settings to fall back on —
  // and then once per workspace folder, which is our chance to layer that
  // folder's `intelephense.config.json` on top.
  //
  // A setting in a project's config file beats the same setting in the Pulsar
  // settings UI, on the grounds that the more specific answer should win.
  async getWorkspaceConfiguration (params) {
    let base = this.mapConfigurationObject(
      atom.config.get(this.getRootConfigurationKey()) ?? {}
    );

    return Promise.all(
      params.items.map(async ({ section, scopeUri }) => {
        let settings = base;

        let projectPath = scopeUri ?
          Convert.uriToPath(scopeUri) :
          atom.project.getPaths()[0];

        let projectConfig = await readProjectConfigFile(projectPath);
        if (projectConfig) {
          settings = {
            ...settings,
            intelephense: deepMerge(settings.intelephense, projectConfig)
          };
        }

        return section ? settings[section] : settings;
      })
    );
  }

  // Restart the servers so that a newly entered licence key gets picked up.
  //
  // Debounced, because this fires on each keystroke: without it, typing a key by
  // hand — or pasting one into a field that already had a value — would thrash
  // the server. We wait for the value to stop changing before doing anything, so
  // the running server keeps working right up until we replace it.
  //
  // No success notification here on purpose. The server announces the outcome
  // itself via `window/showMessage` once it has actually talked to the
  // activation service, and it knows whether the key was good; we don't.
  restartServersForLicenseKeyChange () {
    if (this._licenseKeyTimeout) {
      clearTimeout(this._licenseKeyTimeout);
    }

    this._licenseKeyTimeout = setTimeout(async () => {
      this._licenseKeyTimeout = null;
      try {
        await this.restartAllServers();
      } catch (err) {
        console.error(`Error restarting ${this.getServerName()}`);
        console.error(err);
        atom.notifications.addError(
          `Failed to restart ${this.getServerName()}`,
          {
            description: `Your licence key was saved, but the language server could not be restarted to apply it. Try the **Restart Language Server** command or relaunch Pulsar.`,
            detail: err.message,
            dismissable: true
          }
        );
      }
    }, LICENSE_KEY_DEBOUNCE_MS);
  }

  // Tell every running server to re-read our configuration. Since we advertise
  // support for `workspace/configuration`, the settings we send along here are
  // mostly a formality; the server will turn around and ask us for the values
  // it actually cares about.
  notifyServersOfConfigurationChange () {
    let servers = this._serverManager?.getActiveServers() ?? [];
    let settings = this.mapConfigurationObject(
      atom.config.get(this.getRootConfigurationKey()) ?? {}
    );
    for (let server of servers) {
      server.connection.didChangeConfiguration({ settings });
    }
  }

  getInitializeParams (projectPath, lsProcess) {
    let params = super.getInitializeParams(projectPath, lsProcess);

    // The licence key has to be present at initialization; the server won't
    // pick it up from the configuration alone.
    let licenseKey = atom.config.get(
      `${this.getPackageName()}.intelephense.licenseKey`
    );

    params.initializationOptions = {
      ...(params.initializationOptions ?? {}),
      ...(licenseKey ? { licenceKey: licenseKey } : {})
    };

    return params;
  }

  getGrammarScopes() {
    return ['text.html.php', 'source.php']
  }

  getLanguageName() { return 'PHP'; }
  getServerName() { return 'Intelephense (PHP)'; }

  getPackageName() {
    return Path.basename(ROOT) ?? 'pulsar-ide-php';
  }

  constructor() {
    super();
  }

  getPathToBin () {
    return Path.join(ROOT, 'node_modules', 'intelephense', 'lib', 'intelephense.js');
  }

  startServerProcess() {
    let bin = this.getPathToBin();
    let args = [];

    // Intelephense's own `maxMemory` setting only takes effect when the server
    // is told which Node to use. Since we always use the Node that ships with
    // Pulsar, we have to apply the limit ourselves.
    let memoryLimit = atom.config.get(
      `${this.getPackageName()}.advanced.memoryLimit`
    );
    if (memoryLimit > 0) {
      args.push(`--max-old-space-size=${memoryLimit}`);
    }

    args.push(bin, '--stdio');

    return super.spawnChildNode(args, {
      cwd: atom.project.getPaths()[0] || __dirname
    });
  }

  _getSettingForScope(scope, key) {
    return atom.config.get(key, { scope: [scope] });
  }

  postInitialization(server) {
    // Ordinarily we'll just assume the server started successfully and that it
    // isn't worth informing the user about. But if the server was previously
    // in an error state…
    if (this.errorNotification) {
      // …dismiss that old notification (if it's still present)…
      this.errorNotification.dismiss();
      // …and tell the user that it's been fixed.
      atom.notifications.addSuccess(
        `${this.getPackageName()}: ${this.getServerName()} started`
      );
      this.errorNotification = null;
    }

    this._server = server;
  }

  // Look up scope-specific settings for a particular editor. If `editor` is
  // `undefined`, it'll return general settings for the same key.
  getScopedSettingsForKey(key, editor) {
    let schema = atom.config.getSchema(key);
    if (!schema) throw new Error(`Unknown config key: ${schema}`);

    let base = atom.config.get(key);
    if (!editor) return base;

    let grammar = editor.getGrammar();
    let scoped = atom.config.get(key, { scope: [grammar.scopeName] });

    if (schema?.type === 'object') {
      return { ...base, ...scoped };
    } else {
      return scoped ?? base;
    }
  }

  // AUTOCOMPLETE
  // ============

  provideAutocomplete () {
    let result = super.provideAutocomplete();
    if (!result) return result;
    let original = result.getSuggestions;
    // We wrap `getSuggestions` rather than declining to be a provider at all so
    // that toggling this setting takes effect without a window reload.
    result.getSuggestions = async (request) => {
      if (!this.enableAutocomplete) return Promise.resolve([]);
      return original(request);
    };
    return result;
  }

  // LINTER
  // ======

  getLinterSettings(editor) {
    return this.getScopedSettingsForKey(`${this.getPackageName()}.linter`, editor);
  }

  // Set a limit on linter messages that can be sent to a single buffer by the
  // language server.
  getLinterMessageLimitForBuffer (_buffer) {
    return 1000;
  }

  shouldIgnoreLinterMessage(_diagnostic, editor, _range) {
    // This lets us set a scope-specific override to the `enable` setting. It
    // also saves the user from having to restart before changing this setting
    // takes effect.
    let settings = this.getLinterSettings(editor);
    return !settings.enable;
  }

  transformLinterMessage(message, diagnostic, editor) {
    let settings = this.getLinterSettings(editor);
    let { code } = diagnostic;
    if (code && settings.includeMessageCodeInMessageBody) {
      message.excerpt = `${message.excerpt} (${diagnostic.code})`;
    }
  }

  // SYMBOLS
  // =======

  getSymbolSettings(editor) {
    return this.getScopedSettingsForKey(`${this.getPackageName()}.symbols`, editor);
  }

  canProvideSymbols(meta) {
    let { editor, type } = meta;
    let settings = this.getSymbolSettings(editor);
    if (!settings.enable) return false;
    // Allow the user to toggle file symbols and project symbols independently.
    // (Maybe they like Tree-sitter symbols better for files, but want to keep
    // the project-wide symbol search.)
    if (type === 'file' && !settings.enableForFileSymbols) {
      return false;
    } else if (type !== 'file' && !settings.enableForProjectSymbols) {
      return false;
    }
    return true;
  }

  shouldIgnoreSymbol(symbol, editor) {
    let { ignoredTags = [] } = this.getSymbolSettings(editor);
    return ignoredTags.includes(symbol.tag);
  }

  minimumQueryLengthForSymbolSearch(meta) {
    let { minimumQueryLength = 3 } = this.getSymbolSettings(meta.editor);
    return minimumQueryLength;
  }

  // HOVER
  // =====

  getPriorityForHover() {
    return atom.config.get(`${this.getPackageName()}.hover.priority`);
  }

  provideHover () {
    let enabled = atom.config.get(`${this.getPackageName()}.hover.enable`);
    if (!enabled) return;
    return super.provideHover();
  }

  // SIGNATURE
  // =========

  getPriorityForSignatureHelp() {
    return atom.config.get(`${this.getPackageName()}.signatureHelp.priority`);
  }

  provideSignature () {
    let enabled = atom.config.get(`${this.getPackageName()}.signatureHelp.enable`);
    if (!enabled) return;
    return super.provideSignature();
  }


  // CODE FORMATTING
  // ===============

  getPriorityForCodeFormat () {
    return atom.config.get(`${this.getPackageName()}.codeFormat.priority`);
  }

  // Allow the user to configure whether code formatting is enabled. Unlike most
  // other such settings, this one requires a restart/reload to apply, and isn't
  // scope-specific.
  //
  // TODO: This can be made scope-specific if we just hot-swap in an inert code
  // formatter that makes no suggestions. Revisit this.
  //
  // TODO: It would be nice to give granular control over which code-formatter
  // kinds are disabled and which aren't. That would let someone disable
  // implicit format-on-save behavior while still being able to reformat a range
  // they'd selected.
  //
  // But `atom-ide-code-format` will try to cross over and use whichever ones
  // are available — e.g., a range formatter (applied over the entire file) if a
  // file formatter is not available — so this isn't practical.
  codeFormatIsEnabled () {
    return atom.config.get(`${this.getPackageName()}.codeFormat.enable`);
  }

  provideRangeCodeFormat(...args) {
    if (!this.codeFormatIsEnabled()) return;
    return super.provideRangeCodeFormat(...args);
  }

  provideFileCodeFormat(...args) {
    if (!this.codeFormatIsEnabled()) return;
    return super.provideFileCodeFormat(...args);
  }

  provideOnSaveCodeFormat(...args) {
    if (!this.codeFormatIsEnabled()) return;
    return super.provideOnSaveCodeFormat(...args);
  }

  provideOnTypeCodeFormat(...args) {
    if (!this.codeFormatIsEnabled()) return;
    return super.provideOnTypeCodeFormat(...args);
  }
}

module.exports = new IntelephenseLanguageClient();
