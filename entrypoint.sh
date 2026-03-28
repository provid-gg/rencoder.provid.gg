#!/bin/sh
set -e
node scripts/inject-domain.mjs
exec node dist/server.js
