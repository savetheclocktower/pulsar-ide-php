# pulsar-ide-php

An IDE provider package for PHP that uses the [Intelephense](https://www.npmjs.com/package/intelephense) language server.

Provides autocompletion, go-to-definition, and other useful features out of the box; consider installing some IDE consumer packages to enjoy more features.

Uses its own copy of Intelephense; **you do not need to install your own**. It runs on Pulsar’s own embedded Node, so there’s nothing else to install and nothing to configure before it will start.

## What does this package do?

An “IDE provider package” is a package that knows how to talk to a _language server_. A language server is a program that can analyze a project written in a specific programming language and act as a “brain” for a bunch of features that would be useful for a code editor.

The Pulsar documentation has [more information about language servers](https://docs.pulsar-edit.dev/ide-features/getting-started/#what-are-language-servers%253F) if you’re curious.

This package knows how to talk to [Intelephense](https://intelephense.com), a PHP language server with a fast indexer and a thorough static analysis engine.

## Licence keys and premium features

Intelephense is free to use, but some of its features require a paid licence key. The free feature set is generous — completion, signature help, go-to-definition, find-all-references, symbol search, diagnostics, formatting, and hover are all included, and always will be.

A licence unlocks the rest: renaming symbols across a project, code actions (importing symbols, adding PHPDoc, implementing abstract methods), finding implementations of interfaces and abstract classes, go-to-type-definition, and a few others. You can [buy one here](https://intelephense.com).

If you have a key, paste it into the **License Key** setting under **Intelephense**. The server will restart automatically to apply it, and will tell you whether the key was accepted.

A few of Intelephense’s premium features — code lens, inlay hints, and document links — have no equivalent in Pulsar yet, so a licence won’t light those up here.

## Configuring Intelephense

Most of Intelephense’s own settings live under the **Intelephense** section of this package’s settings menu, and are grouped roughly the way they are in Intelephense’s documentation: **Environment**, **Files**, **Completion**, **Diagnostics**, and so on.

Two of these behave slightly differently than they do in other editors:

* **Additional Excluded Paths** (`files.exclude`) _adds to_ Pulsar’s own **Ignored Names** setting (`core.ignoredNames`) rather than replacing it. There’s no need to list `.git` or `.DS_Store` here; the default value only mentions the things that are specific to PHP projects, like `vendor` and `node_modules`.
* **License Key** is spelled the American way in the settings menu, but is sent to the server as `licenceKey`. If you’re following Intelephense’s own documentation, they’re the same setting.

### Per-project configuration

If a project contains an `intelephense.config.json` file in its root directory, the settings in that file **win** over the ones in the settings menu. This is the same file that Intelephense reads in other editors, so a file that’s already checked into a repository will work here without modification.

Its contents may be either a bare settings object or one wrapped in an `intelephense` key:

```json
{
  "environment": {
    "phpVersion": "8.1.0"
  },
  "diagnostics": {
    "strictTypes": true
  }
}
```

Settings are merged one key at a time, so a file like the one above changes only those two values and leaves everything else in the settings menu alone. Lists — like `stubs` or `files.exclude` — are replaced rather than combined, on the theory that a project asking for particular stubs means _those_ stubs.

This is also how you reach the handful of settings that aren’t in the settings menu, because they don’t fit well into it: `stubs`, `diagnostics.severity`, `diagnostics.exclude`, and the `phpdoc` templates.

Edits to this file take effect right away! There’s no need to restart the language server.

## What other packages should I install?

This package provides only the “brain” for a bunch of PHP-related features. The actual implementations of those features come from packages — some of which are built into Pulsar and some of which need installation.

Start with these packages; they’re all builtin, actively maintained, and/or built exclusively for Pulsar:

* [autocomplete-plus](https://web.pulsar-edit.dev/packages/autocomplete-plus) (builtin)
  * See autocompletion options as you type
* [symbols-view](https://web.pulsar-edit.dev/packages/symbols-view) (builtin)
  * View and filter a list of symbols in the current file
  * View and filter a list of symbols across all files in the project
  * Jump to the definition of the symbol under the cursor
* [linter](https://web.pulsar-edit.dev/packages/linter) and [linter-ui-default](https://web.pulsar-edit.dev/packages/linter-ui-default)
  * View diagnostic messages as you type
* [intentions](https://web.pulsar-edit.dev/packages/intentions)
  * Open a menu to view possible code actions for a diagnostic message (map `intentions:show` to a keybinding of your choice)
  * Open a menu to view possible code actions for the file at large
* [pulsar-find-references](https://web.pulsar-edit.dev/packages/pulsar-find-references)
  * Place the cursor inside of a token to highlight other usages of that token
  * Place the cursor inside of a token, then view a `find-and-replace`-style “results” panel containing all usages of that token across your project
* [pulsar-outline-view](https://web.pulsar-edit.dev/packages/pulsar-outline-view)
  * View a hierarchical list of the file’s symbols
* [pulsar-refactor](https://web.pulsar-edit.dev/packages/pulsar-refactor)
  * Perform project-wide renaming of variables, methods, and classes
* [pulsar-code-format](https://packages.pulsar-edit.dev/packages/pulsar-code-format)
  * Format code automatically on save
  * Format the selected range of a buffer
  * Format the entire buffer
* [pulsar-hover](https://packages.pulsar-edit.dev/packages/pulsar-hover)
  * Hover over a symbol to see a tooltip documenting it (or disable this behavior and use a key binding to show the tooltip)
  * Receive “signature help” when specifying the arguments to a function

Older packages (mainly beginning with `atom-ide-`) can deliver similar features, but the packages above were largely built specifically for Pulsar.
