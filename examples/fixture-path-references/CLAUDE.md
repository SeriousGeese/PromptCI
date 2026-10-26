# Path References Fixture

Detector corpus for file-reference checks. Paths that live outside the checkout
are not broken references:

- Personal settings live in `~/.config/fixture/settings.json`.
- Machine-wide config: `$HOME/.config/fixture/defaults.json`.
- Windows users edit `%USERPROFILE%\.fixture\config.json`.

Repository files are checked: the contract is in `Docs/contract.md`, but the
older guide at `Docs/missing-guide.md` no longer exists.
