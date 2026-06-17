#!/bin/bash
# Script di avvio per lo Stremio Add-on StreamingCommunity

PORT=${1:-7000}

echo "Avvio StreamingCommunity Stremio Add-on sulla porta $PORT..."
cd "$(dirname "$0")"
PORT=$PORT node server.js
