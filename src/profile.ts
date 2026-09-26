// src/profile.ts - Profile management for ccc
// A profile is ~/.ccc/profiles/<name>/{claude/, claude.json, codex/}. The account
// used without CCC_PROFILE is the reserved profile "default"
// (doc/common/REQ__ccc-home-layout.md).

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { LAB_RUNNER_PROFILE_NAME } from "./utils.js";
import { DEFAULT_PROFILE_NAME, profilesDir } from "./home-layout.js";

// === Types ===

export interface ProfileSettings {
    env?: Record<string, string>;
    [key: string]: unknown;
}

export interface BuiltinProfile {
    description: string;
    settings?: ProfileSettings;
}

// === Built-in profiles ===

export const BUILTIN_PROFILES: Readonly<Record<string, BuiltinProfile>> = {
    "local-llm": {
        description: "Local LLM usage — disables Claude attribution header",
        settings: {
            env: {
                CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
            },
        },
    },
    [LAB_RUNNER_PROFILE_NAME]: {
        description: "Opt-in lab runner — enables bounded in-container VM runtime wiring when the host supports it",
    },
};

// === Validation ===

/**
 * Validate a profile name.
 * Must start with a lowercase letter or digit, followed by up to 63 lowercase
 * alphanumeric or [._-] characters (total max 64 chars).
 */
export function validateProfileName(name: string): boolean {
    return /^[a-z0-9][a-z0-9_.\-]{0,63}$/.test(name);
}

// === Queries ===

/**
 * List all profile names: "default" first, then the named profile directories.
 */
export function listProfiles(): string[] {
    const named = existsSync(profilesDir())
        ? readdirSync(profilesDir(), { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name !== DEFAULT_PROFILE_NAME)
            .map((d) => d.name)
        : [];
    return [DEFAULT_PROFILE_NAME, ...named];
}

/**
 * Check if a profile exists.
 */
export function profileExists(name: string): boolean {
    return name === DEFAULT_PROFILE_NAME || existsSync(join(profilesDir(), name));
}

/**
 * Check if a name is a built-in profile.
 */
export function isBuiltinProfile(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(BUILTIN_PROFILES, name);
}

// === Mutations ===

/**
 * Create a new profile — claude/, codex/ and an empty claude.json.
 * When settings are provided, also writes claude/settings.json.
 */
export function createProfile(name: string, settings?: ProfileSettings): void {
    if (name === DEFAULT_PROFILE_NAME) throw new Error(`Profile "${DEFAULT_PROFILE_NAME}" is reserved.`);
    const profileDir = join(profilesDir(), name);
    const claudeDir = join(profileDir, "claude");

    mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(profileDir, "codex"), { recursive: true, mode: 0o700 });
    writeFileSync(join(profileDir, "claude.json"), "{}", { mode: 0o600 });

    if (settings) {
        writeFileSync(
            join(claudeDir, "settings.json"),
            JSON.stringify(settings, null, 2),
            { mode: 0o600 },
        );
    }
}

/**
 * Ensure a profile exists. If it's a built-in and doesn't exist, auto-create it.
 * Returns true if a new profile was created, false if it already existed.
 * Throws for unknown non-builtin profiles.
 */
export function ensureProfile(name: string): boolean {
    if (profileExists(name)) return false;
    if (!isBuiltinProfile(name)) {
        throw new Error(`Profile "${name}" does not exist. Create it with: ccc profile add ${name}`);
    }
    createProfile(name, BUILTIN_PROFILES[name].settings);
    return true;
}

/**
 * Remove a profile directory recursively.
 */
export function removeProfile(name: string): void {
    if (name === DEFAULT_PROFILE_NAME) throw new Error(`Profile "${DEFAULT_PROFILE_NAME}" cannot be removed.`);
    const profileDir = join(profilesDir(), name);
    rmSync(profileDir, { recursive: true, force: true });
}
