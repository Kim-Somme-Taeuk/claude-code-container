import { describe, expect, expectTypeOf, it } from "vitest";
import { createProfileCatalog, validateProfileName } from "../../application/profile-catalog.js";
import type { ProfileCatalogPorts, ProfileSettings, BuiltinProfile } from "../../ports/profile-catalog.js";
import type * as facade from "../../profile.js";

// Native facade imports are type-only; this function is deliberately never called.
function contracts(ports: ProfileCatalogPorts, publicApi: typeof facade, settings: ProfileSettings) {
    const app = createProfileCatalog(ports, "explicit-default");
    expectTypeOf<Parameters<typeof createProfileCatalog>>().toEqualTypeOf<[ProfileCatalogPorts, string]>();
    expectTypeOf<keyof ProfileCatalogPorts>().toEqualTypeOf<"listProfileDirectoryNames" | "profileEntryExists" | "writeProfile" | "removeProfileDirectory" | "hasBuiltinProfile" | "readBuiltinSettings">();
    expectTypeOf<Parameters<typeof ports.listProfileDirectoryNames>>().toEqualTypeOf<[]>();
    expectTypeOf<ReturnType<typeof ports.listProfileDirectoryNames>>().toEqualTypeOf<string[]>();
    expectTypeOf<Parameters<typeof ports.profileEntryExists>>().toEqualTypeOf<[string]>();
    expectTypeOf<ReturnType<typeof ports.profileEntryExists>>().toEqualTypeOf<boolean>();
    expectTypeOf<Parameters<typeof ports.hasBuiltinProfile>>().toEqualTypeOf<[string]>();
    expectTypeOf<ReturnType<typeof ports.hasBuiltinProfile>>().toEqualTypeOf<boolean>();
    expectTypeOf<Parameters<typeof ports.readBuiltinSettings>>().toEqualTypeOf<[string]>();
    expectTypeOf<ReturnType<typeof ports.readBuiltinSettings>>().toEqualTypeOf<ProfileSettings | undefined>();
    expectTypeOf<Parameters<typeof ports.writeProfile>>().toEqualTypeOf<[string, ProfileSettings?]>();
    expectTypeOf<ReturnType<typeof ports.writeProfile>>().toEqualTypeOf<void>();
    expectTypeOf<Parameters<typeof ports.removeProfileDirectory>>().toEqualTypeOf<[string]>();
    expectTypeOf<ReturnType<typeof ports.removeProfileDirectory>>().toEqualTypeOf<void>();
    expectTypeOf<typeof publicApi.validateProfileName>().toEqualTypeOf<(name: string) => boolean>();
    expectTypeOf<typeof publicApi.listProfiles>().toEqualTypeOf<() => string[]>();
    expectTypeOf<typeof publicApi.profileExists>().toEqualTypeOf<(name: string) => boolean>();
    expectTypeOf<typeof publicApi.isBuiltinProfile>().toEqualTypeOf<(name: string) => boolean>();
    expectTypeOf<typeof publicApi.createProfile>().toEqualTypeOf<(name: string, settings?: ProfileSettings) => void>();
    expectTypeOf<typeof publicApi.ensureProfile>().toEqualTypeOf<(name: string) => boolean>();
    expectTypeOf<typeof publicApi.removeProfile>().toEqualTypeOf<(name: string) => void>();
    expectTypeOf<facade.ProfileSettings>().toEqualTypeOf<ProfileSettings>();
    expectTypeOf<facade.BuiltinProfile>().toEqualTypeOf<BuiltinProfile>();
    expectTypeOf<typeof publicApi.BUILTIN_PROFILES>().toEqualTypeOf<Readonly<Record<string, BuiltinProfile>>>();
    expectTypeOf<ReturnType<typeof app.list>>().toEqualTypeOf<string[]>();
    expectTypeOf<ReturnType<typeof app.ensure>>().toEqualTypeOf<boolean>();
    expectTypeOf<ReturnType<typeof app.exists>>().toEqualTypeOf<boolean>();
    expectTypeOf<ReturnType<typeof app.isBuiltin>>().toEqualTypeOf<boolean>();
    expectTypeOf<ReturnType<typeof app.validate>>().toEqualTypeOf<boolean>();
    expectTypeOf<Parameters<typeof app.validate>>().toEqualTypeOf<[string]>();
    expectTypeOf<Parameters<typeof app.exists>>().toEqualTypeOf<[string]>();
    expectTypeOf<Parameters<typeof app.ensure>>().toEqualTypeOf<[string]>();
    expectTypeOf<Parameters<typeof app.isBuiltin>>().toEqualTypeOf<[string]>();
    expectTypeOf<Parameters<typeof app.create>>().toEqualTypeOf<[string, ProfileSettings?]>();
    expectTypeOf<ReturnType<typeof app.create>>().toEqualTypeOf<void>();
    expectTypeOf<Parameters<typeof app.remove>>().toEqualTypeOf<[string]>();
    expectTypeOf<ReturnType<typeof app.remove>>().toEqualTypeOf<void>();
    app.create("name", settings);
    app.remove("name");
    validateProfileName("name");
    // TypeScript permits async implementations of void effects. Trusted native composition
    // provides synchronous writers/removers; the type contract does not enforce that fact.
    createProfileCatalog({ ...ports, writeProfile: async () => undefined, removeProfileDirectory: async () => undefined }, "explicit-default");
    // @ts-expect-error Both ports and the explicit default must be supplied.
    createProfileCatalog();
    // @ts-expect-error The default is not duplicated inside the core.
    createProfileCatalog(ports);
    // @ts-expect-error The default must be a string.
    createProfileCatalog(ports, undefined);
    // @ts-expect-error All six ports are required.
    createProfileCatalog({ ...ports, readBuiltinSettings: undefined }, "default");
    // @ts-expect-error Directory listing is required.
    createProfileCatalog({ ...ports, listProfileDirectoryNames: undefined }, "default");
    // @ts-expect-error Native entry existence is required.
    createProfileCatalog({ ...ports, profileEntryExists: undefined }, "default");
    // @ts-expect-error Native profile writing is required.
    createProfileCatalog({ ...ports, writeProfile: undefined }, "default");
    // @ts-expect-error Native removal is required.
    createProfileCatalog({ ...ports, removeProfileDirectory: undefined }, "default");
    // @ts-expect-error Own membership is required separately from settings.
    createProfileCatalog({ ...ports, hasBuiltinProfile: undefined }, "default");
    // @ts-expect-error Membership must be callable.
    createProfileCatalog({ ...ports, hasBuiltinProfile: true }, "default");
    // @ts-expect-error Listing is a synchronous observation.
    createProfileCatalog({ ...ports, listProfileDirectoryNames: async () => [] }, "default");
    // @ts-expect-error Existence is a synchronous observation.
    createProfileCatalog({ ...ports, profileEntryExists: async () => false }, "default");
    // @ts-expect-error Membership is a synchronous observation.
    createProfileCatalog({ ...ports, hasBuiltinProfile: async () => false }, "default");
    // @ts-expect-error Settings are a synchronous observation.
    createProfileCatalog({ ...ports, readBuiltinSettings: async () => settings }, "default");
    // @ts-expect-error A profile name is required.
    app.ensure();
    // @ts-expect-error Settings retain string env values.
    app.create("name", { env: { BAD: 1 } });
    // @ts-expect-error Policy returns a boolean, not an async result.
    const result: Promise<boolean> = app.ensure("name");
    void result;
}
void contracts;

describe("profile catalog declaration contracts", () => {
    it("operates synchronously with an explicit injected default", () => {
        const app = createProfileCatalog({ listProfileDirectoryNames: () => [], profileEntryExists: () => false,
            writeProfile: () => undefined, removeProfileDirectory: () => undefined,
            hasBuiltinProfile: () => false, readBuiltinSettings: () => undefined }, "fixture-default");
        expect(app.list()).toEqual(["fixture-default"]);
        expect(app.ensure("fixture-default")).toBe(false);
    });
});
