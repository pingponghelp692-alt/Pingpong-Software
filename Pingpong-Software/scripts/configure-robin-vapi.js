#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, ".env");
const publicKey = "f3ac552d-b25f-4afc-98a0-b64eeab0fc16";
const assistantId = "3ec88d92-7146-4531-a26d-b790edf51f70";

function upsert(text, key, value) {
  const re = new RegExp("^\\s*" + key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&") + "\\s*=.*$", "m");
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  return text.replace(/\\s*$/, "") + `\\n${key}=${value}\\n`;
}

let text = "";
if (fs.existsSync(envPath)) text = fs.readFileSync(envPath, "utf8");
else text = "# PingPong production environment\n";

text = upsert(text, "VAPI_PUBLIC_KEY", publicKey);
text = upsert(text, "VAPI_ASSISTANT_ID", assistantId);

fs.writeFileSync(envPath, text, "utf8");
console.log("Robin Vapi configuration applied to .env.");
console.log("VAPI_PUBLIC_KEY: SET");
console.log("VAPI_ASSISTANT_ID: " + assistantId);
console.log("No Firebase or private Vapi credentials were modified.");
