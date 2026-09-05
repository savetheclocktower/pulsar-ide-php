const FS = require('fs');
const OS = require('os');
const Path = require('path');

const client = require('../lib/main');

const CONFIG_FILE_NAME = 'intelephense.config.json';

// The helpers under test — `convertIgnoredNamesToGlobs`, `deepMerge`,
// `readProjectConfigFile` — are private to `lib/main.js`, so we exercise them
// through the two methods that use them: `mapConfigurationObject`, which
// answers “what would we tell the server?”, and `getWorkspaceConfiguration`,
// which is what the server actually calls.

describe('pulsar-ide-php configuration', () => {
  let tempDirectories;

  // Make a directory to stand in for a project root, optionally containing an
  // `intelephense.config.json` with the given contents. Pass a string to write
  // something that isn't valid JSON.
  function makeProjectDirectory (configFileContents = null) {
    let directory = FS.realpathSync(
      FS.mkdtempSync(Path.join(OS.tmpdir(), 'pulsar-ide-php-'))
    );
    tempDirectories.push(directory);

    if (configFileContents !== null) {
      let contents = typeof configFileContents === 'string' ?
        configFileContents :
        JSON.stringify(configFileContents);
      FS.writeFileSync(
        Path.join(directory, CONFIG_FILE_NAME),
        contents,
        'utf8'
      );
    }

    return directory;
  }

  function fileUriForPath (path) {
    return `file://${path}`;
  }

  // Ask for the `intelephense` section the same way the server does.
  function requestConfiguration (scopeUri = undefined) {
    let item = { section: 'intelephense' };
    if (scopeUri) item.scopeUri = scopeUri;
    return client.getWorkspaceConfiguration({ items: [item] });
  }

  beforeEach(() => {
    tempDirectories = [];
    // Start from a known value rather than whatever the user's own Pulsar has.
    atom.config.set('core.ignoredNames', []);
  });

  afterEach(() => {
    atom.config.unset('core.ignoredNames');
    atom.config.unset('pulsar-ide-php');
    for (let directory of tempDirectories) {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  describe('mapConfigurationObject', () => {
    it('wraps its result in the section name the server asks for', () => {
      let result = client.mapConfigurationObject({ intelephense: {} });
      expect(Object.keys(result)).toEqual(['intelephense']);
    });

    it('copes with an empty configuration object', () => {
      expect(() => client.mapConfigurationObject({})).not.toThrow();
      expect(() => client.mapConfigurationObject()).not.toThrow();
    });

    describe('the licence key', () => {
      it('is renamed to the spelling the server expects', () => {
        let { intelephense } = client.mapConfigurationObject({
          intelephense: { licenseKey: 'ABC123' }
        });

        expect(intelephense.licenceKey).toBe('ABC123');
        // The server warns about unrecognized keys, so the original must go.
        expect('licenseKey' in intelephense).toBe(false);
      });

      it('is omitted entirely when it has not been set', () => {
        let { intelephense } = client.mapConfigurationObject({
          intelephense: {}
        });

        expect('licenceKey' in intelephense).toBe(false);
        expect('licenseKey' in intelephense).toBe(false);
      });

      it('is omitted when it has been set to an empty string', () => {
        let { intelephense } = client.mapConfigurationObject({
          intelephense: { licenseKey: '' }
        });

        expect('licenceKey' in intelephense).toBe(false);
      });
    });

    describe('files.exclude', () => {
      it('adds Pulsar’s ignored names to the configured excludes', () => {
        atom.config.set('core.ignoredNames', ['.git']);

        let { intelephense } = client.mapConfigurationObject({
          intelephense: { files: { exclude: ['**/vendor/**'] } }
        });

        expect(intelephense.files.exclude).toEqual([
          '**/.git',
          '**/.git/**',
          '**/vendor/**'
        ]);
      });

      // Both forms are needed. The `**/{name}/**` form is what excludes a
      // directory's contents; the bare form is what catches a dotted wildcard
      // like `._*`, for which the trailing globstar stops matching. See the
      // comment on `convertIgnoredNamesToGlobs` in `lib/main.js`.
      it('produces both a bare and a globstar form for each ignored name', () => {
        atom.config.set('core.ignoredNames', ['._*']);

        let { intelephense } = client.mapConfigurationObject({
          intelephense: {}
        });

        expect(intelephense.files.exclude).toEqual(['**/._*', '**/._*/**']);
      });

      it('passes through names that already look like path globs', () => {
        atom.config.set('core.ignoredNames', ['build/generated/**']);

        let { intelephense } = client.mapConfigurationObject({
          intelephense: {}
        });

        expect(intelephense.files.exclude).toEqual(['build/generated/**']);
      });

      it('skips empty ignored names', () => {
        atom.config.set('core.ignoredNames', ['', '.git']);

        let { intelephense } = client.mapConfigurationObject({
          intelephense: {}
        });

        expect(intelephense.files.exclude).toEqual(['**/.git', '**/.git/**']);
      });

      it('leaves the other `files` settings alone', () => {
        let { intelephense } = client.mapConfigurationObject({
          intelephense: { files: { maxSize: 5000, associations: ['*.php'] } }
        });

        expect(intelephense.files.maxSize).toBe(5000);
        expect(intelephense.files.associations).toEqual(['*.php']);
      });

      it('adds a `files` section even when there wasn’t one', () => {
        let { intelephense } = client.mapConfigurationObject({
          intelephense: {}
        });

        expect(intelephense.files.exclude).toEqual([]);
      });
    });

    it('does not modify the configuration object it was given', () => {
      let config = {
        intelephense: {
          licenseKey: 'ABC123',
          files: { exclude: ['**/vendor/**'] }
        }
      };
      atom.config.set('core.ignoredNames', ['.git']);

      client.mapConfigurationObject(config);

      expect(config.intelephense.licenseKey).toBe('ABC123');
      expect(config.intelephense.files.exclude).toEqual(['**/vendor/**']);
    });
  });

  describe('getWorkspaceConfiguration', () => {
    it('returns one result per requested item, in order', async () => {
      let directory = makeProjectDirectory();
      atom.project.setPaths([directory]);

      let results = await client.getWorkspaceConfiguration({
        items: [
          { section: 'intelephense' },
          { section: 'intelephense' }
        ]
      });

      expect(results.length).toBe(2);
    });

    it('returns the whole object when an item names no section', async () => {
      let directory = makeProjectDirectory();
      atom.project.setPaths([directory]);

      let [result] = await client.getWorkspaceConfiguration({
        items: [{}]
      });

      expect(Object.keys(result)).toEqual(['intelephense']);
    });

    it('falls back to the settings menu when there is no config file', async () => {
      let directory = makeProjectDirectory();
      atom.project.setPaths([directory]);
      atom.config.set('pulsar-ide-php.intelephense.environment', {
        phpVersion: '8.5.0'
      });

      let [settings] = await requestConfiguration();

      expect(settings.environment.phpVersion).toBe('8.5.0');
    });

    describe('when the project has an intelephense.config.json', () => {
      it('lets the file win over the settings menu', async () => {
        let directory = makeProjectDirectory({
          environment: { phpVersion: '8.1.0' }
        });
        atom.project.setPaths([directory]);
        atom.config.set('pulsar-ide-php.intelephense.environment', {
          phpVersion: '8.5.0'
        });

        let [settings] = await requestConfiguration();

        expect(settings.environment.phpVersion).toBe('8.1.0');
      });

      it('leaves settings the file doesn’t mention alone', async () => {
        let directory = makeProjectDirectory({
          environment: { phpVersion: '8.1.0' }
        });
        atom.project.setPaths([directory]);
        atom.config.set('pulsar-ide-php.intelephense.environment', {
          phpVersion: '8.5.0',
          shortOpenTag: true
        });

        let [settings] = await requestConfiguration();

        expect(settings.environment.shortOpenTag).toBe(true);
      });

      it('replaces lists rather than combining them', async () => {
        let directory = makeProjectDirectory({
          files: { exclude: ['**/generated/**'] }
        });
        atom.project.setPaths([directory]);
        atom.config.set('core.ignoredNames', ['.git']);
        atom.config.set('pulsar-ide-php.intelephense.files', {
          exclude: ['**/vendor/**']
        });

        let [settings] = await requestConfiguration();

        expect(settings.files.exclude).toEqual(['**/generated/**']);
      });

      it('passes through settings that aren’t in the settings menu', async () => {
        let directory = makeProjectDirectory({
          stubs: ['Core', 'wordpress'],
          diagnostics: { severity: { P1006: 'warning' } }
        });
        atom.project.setPaths([directory]);

        let [settings] = await requestConfiguration();

        expect(settings.stubs).toEqual(['Core', 'wordpress']);
        expect(settings.diagnostics.severity).toEqual({ P1006: 'warning' });
      });

      it('accepts a file whose settings are wrapped in an `intelephense` key', async () => {
        let directory = makeProjectDirectory({
          intelephense: { environment: { phpVersion: '8.1.0' } }
        });
        atom.project.setPaths([directory]);

        let [settings] = await requestConfiguration();

        expect(settings.environment.phpVersion).toBe('8.1.0');
      });

      it('still renames the licence key', async () => {
        let directory = makeProjectDirectory({ licenceKey: 'FROM-FILE' });
        atom.project.setPaths([directory]);
        atom.config.set(
          'pulsar-ide-php.intelephense.licenseKey',
          'FROM-SETTINGS'
        );

        let [settings] = await requestConfiguration();

        expect(settings.licenceKey).toBe('FROM-FILE');
        expect('licenseKey' in settings).toBe(false);
      });
    });

    describe('when an item carries a scopeUri', () => {
      it('reads the config file belonging to that folder', async () => {
        let scoped = makeProjectDirectory({
          environment: { phpVersion: '8.1.0' }
        });
        let other = makeProjectDirectory({
          environment: { phpVersion: '7.4.0' }
        });
        atom.project.setPaths([other, scoped]);

        let [settings] = await requestConfiguration(fileUriForPath(scoped));

        expect(settings.environment.phpVersion).toBe('8.1.0');
      });

      it('uses the first project path when there is no scopeUri', async () => {
        let first = makeProjectDirectory({
          environment: { phpVersion: '7.4.0' }
        });
        let second = makeProjectDirectory({
          environment: { phpVersion: '8.1.0' }
        });
        atom.project.setPaths([first, second]);

        let [settings] = await requestConfiguration();

        expect(settings.environment.phpVersion).toBe('7.4.0');
      });

      it('resolves each item against its own folder', async () => {
        let first = makeProjectDirectory({
          environment: { phpVersion: '7.4.0' }
        });
        let second = makeProjectDirectory({
          environment: { phpVersion: '8.1.0' }
        });
        atom.project.setPaths([first, second]);

        let [one, two] = await client.getWorkspaceConfiguration({
          items: [
            { section: 'intelephense', scopeUri: fileUriForPath(first) },
            { section: 'intelephense', scopeUri: fileUriForPath(second) }
          ]
        });

        expect(one.environment.phpVersion).toBe('7.4.0');
        expect(two.environment.phpVersion).toBe('8.1.0');
      });
    });

    describe('when the config file cannot be used', () => {
      it('ignores a file that isn’t valid JSON, and warns', async () => {
        let directory = makeProjectDirectory('{ not json at all');
        atom.project.setPaths([directory]);
        atom.config.set('pulsar-ide-php.intelephense.environment', {
          phpVersion: '8.5.0'
        });

        let notifications = [];
        let subscription = atom.notifications.onDidAddNotification(
          (notification) => notifications.push(notification)
        );

        let [settings] = await requestConfiguration();
        subscription.dispose();

        expect(settings.environment.phpVersion).toBe('8.5.0');
        expect(notifications.length).toBe(1);
        expect(notifications[0].getType()).toBe('warning');
        expect(notifications[0].getMessage()).toContain(CONFIG_FILE_NAME);
      });

      it('ignores a file that doesn’t contain an object', async () => {
        let directory = makeProjectDirectory('["not", "an", "object"]');
        atom.project.setPaths([directory]);
        atom.config.set('pulsar-ide-php.intelephense.environment', {
          phpVersion: '8.5.0'
        });

        let [settings] = await requestConfiguration();

        expect(settings.environment.phpVersion).toBe('8.5.0');
      });

      it('copes with a project that has no path at all', async () => {
        atom.project.setPaths([]);

        let [settings] = await requestConfiguration();

        expect(settings).toBeDefined();
      });
    });
  });
});
