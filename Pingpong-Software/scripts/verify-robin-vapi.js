#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const pub = String(process.env.VAPI_PUBLIC_KEY || "").trim();
const assistant = String(process.env.VAPI_ASSISTANT_ID || "").trim();
const report = {
  publicKey: pub ? "LOADED" : "MISSING",
  assistantId: assistant || "MISSING",
  expectedAssistantId: "3ec88d92-7146-4531-a26d-b790edf51f70",
  security: {
    publicKeyOnly: true,
    privateVapiKeyNotRequiredForBrowserStart: true
  },
  files: {
    vapiSupport: fs.existsSync(path.join(__dirname, "..", "public", "vapi-support.js")),
    securityHeaders: fs.existsSync(path.join(__dirname, "..", "security", "headers.js")),
    adminPanel: fs.existsSync(path.join(__dirname, "..", "admin", "index.html"))
  }
};
report.assistantMatchesExpected = assistant === report.expectedAssistantId;
report.ok = report.publicKey === "LOADED" && report.assistantMatchesExpected &&
  report.files.vapiSupport && report.files.securityHeaders && report.files.adminPanel;
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
