#!/usr/bin/env node
import { startDeviceBrokerServe } from "./device-lab-broker.js";

const args = process.argv.slice(2);
if (args[0] === "devices" && args[1] === "broker" && args[2] === "serve") {
    process.exitCode = startDeviceBrokerServe(args.slice(3));
} else {
    console.error("Usage: ccc-device-broker devices broker serve [--host <host>] [--port <port>]");
    process.exitCode = 1;
}
