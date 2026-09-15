// Creates the Ed25519 keypair the licence system signs and verifies with.
//
//   node tools/make-license-keypair.mjs
//
// The PUBLIC key is printed: paste it into pokemon_champions_tool/licensing.py
// (LICENSE_PUBLIC_KEY). It is safe in the binary -- it can only verify.
//
// The PRIVATE key is written to .license-private-key.txt and never printed, so
// it does not end up in a terminal scrollback or a transcript. It is written
// one level ABOVE this site directory, and deliberately so: `wrangler.jsonc`
// sets `pages_build_output_dir: "."`, which means every file in this folder --
// dotfiles included, as the .claude exclusion in tools/deploy.mjs shows -- is a
// candidate for public upload. A signing key must not live inside a directory
// whose job is to be published.
//
// Load it into Cloudflare and then delete the file:
//
//   npx wrangler pages secret put LICENSE_PRIVATE_KEY --project-name pokemonbattledata
//
// Run this ONCE. Regenerating invalidates every token already issued (keys
// themselves survive -- the app just has to re-activate).

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, not the working directory, so running it from
// anywhere still puts the key in the same safe place.
const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(resolve(siteRoot, ".."), ".license-private-key.txt");
if (existsSync(OUT)) {
  console.error(`${OUT} already exists. Refusing to overwrite an existing private key.`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
// An Ed25519 SPKI DER is a 12-byte header followed by the 32 raw key bytes.
const raw = publicKey.export({ type: "spki", format: "der" }).subarray(12);

writeFileSync(OUT, pkcs8 + "\n", { mode: 0o600 });

console.log("public key (base64, 32 bytes) -- paste into licensing.py:\n");
console.log("  " + raw.toString("base64") + "\n");
console.log(`private key written to ${OUT} (not printed).`);
console.log("Load it with:\n");
console.log("  npx wrangler pages secret put LICENSE_PRIVATE_KEY --project-name pokemonbattledata\n");
console.log(`then delete ${OUT}.`);
