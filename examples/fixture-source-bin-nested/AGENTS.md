# Fixture: source bin directory with nested scripts

Detector corpus for #206. A Maven project whose tracked `bin/` holds a launcher
in a subdirectory (`bin/linux/start.sh`) and a Groovy script (`bin/tool.groovy`).
Neither is compiler output, so `bin/` is source: it must not be reported as an
unignored build directory, and nothing may propose adding `bin/` to .gitignore.

## Build

```bash
mvn -q verify
```
