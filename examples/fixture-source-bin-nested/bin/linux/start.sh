#!/bin/sh
exec java -jar "$(dirname "$0")/../../target/app.jar" "$@"
