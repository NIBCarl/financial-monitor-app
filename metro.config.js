const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// expo-sqlite's web implementation loads a WebAssembly build of SQLite
// (`expo-sqlite/web/wa-sqlite/wa-sqlite.wasm`). Metro only resolves files whose
// extension is registered as an asset, and `wasm` is not in the default list — without
// this, `npx expo start --web` fails with "Unable to resolve module ./wa-sqlite/wa-sqlite.wasm".
// No effect on Android/iOS bundling.
if (!config.resolver.assetExts.includes('wasm')) {
  config.resolver.assetExts.push('wasm');
}

module.exports = config;
