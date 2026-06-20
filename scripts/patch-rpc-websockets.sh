#!/bin/bash
# Shim rpc-websockets v9 to provide the ./dist/lib/client subpath
# that @solana/web3.js <1.90 expects (pulled in transitively via jito-ts).

PKG="node_modules/rpc-websockets"

if [ ! -d "$PKG" ]; then
  exit 0
fi

mkdir -p "$PKG/dist/lib/client"

cat > "$PKG/dist/lib/client.js" << 'EOF'
const { CommonClient } = require('../../dist/index.cjs');
module.exports = CommonClient;
module.exports.default = CommonClient;
EOF

cat > "$PKG/dist/lib/client/websocket.js" << 'EOF'
const { WebSocket } = require('../../../dist/index.cjs');
module.exports = WebSocket;
module.exports.default = WebSocket;
EOF

# Patch exports map in package.json to allow subpath resolution
node -e "
const fs = require('fs');
const p = '$PKG/package.json';
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!pkg.exports['.']) {
  const orig = { ...pkg.exports };
  pkg.exports = { '.': orig };
}
pkg.exports['./dist/lib/client'] = './dist/lib/client.js';
pkg.exports['./dist/lib/client/websocket'] = './dist/lib/client/websocket.js';
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
"
