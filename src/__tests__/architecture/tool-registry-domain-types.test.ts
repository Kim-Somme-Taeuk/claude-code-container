import { describe, expect, it } from "vitest";
import {
    createDefaultToolCatalog, findToolByName, findDefaultTool,
    getAllCredentialMounts, getNpmTools,
    type ToolDefinition as DomainTool, type CredentialMount as DomainMount,
} from "../../domain/tool-registry.js";
import {
    getToolByName, getDefaultTool, getAllTools,
    getAllCredentialMounts as publicMounts, getNpmTools as publicNpm,
    type ToolDefinition as PublicTool, type CredentialMount as PublicMount,
} from "../../tool-registry.js";

// The same optional old-path augmentation passed the actual baseline and candidate
// emitted declaration consumers. Re-exports preserve nested and direct mount types.
declare module "../../tool-registry.js" {
    interface ToolDefinition { fixtureOptionalTool?: string; }
    interface CredentialMount { fixtureOptionalMount?: string; }
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2) ? true : false;

// Compile this body, but do not execute its intentionally invalid contracts.
function compileContracts(publicTool: PublicTool, domainTool: DomainTool,
    publicMount: PublicMount, domainMount: DomainMount): void {
    const inwardTool: DomainTool = publicTool;
    const outwardTool: PublicTool = domainTool;
    const inwardMount: DomainMount = publicMount;
    const outwardMount: PublicMount = domainMount;
    const catalog: DomainTool[] = [inwardTool, outwardTool];
    const publicCatalog: PublicTool[] = catalog;
    const minimal: DomainTool = { name: "custom", displayName: "Custom", binary: "custom",
        defaultFlags: [], credentialMounts: [], needsNodeRuntime: false,
        updateCommand: [], installCommand: "custom installer" };
    const optionalSubcommands: string[] | undefined = minimal.subcommands;
    const optionalFlags: string[] | undefined = minimal.subcommandsAcceptingDefaultFlags;
    publicTool.defaultFlags.push("flag");
    publicTool.updateCommand.push("update");
    publicTool.credentialMounts.push(domainMount);
    publicTool.credentialMounts[0].hostDir = "mutable";
    domainTool.credentialMounts[0].containerDir = "/mutable";
    domainTool.subcommands = ["command"];
    domainTool.subcommandsAcceptingDefaultFlags = ["command"];
    catalog.push(minimal);

    const legacyDefault: PublicTool = getDefaultTool();
    const nullableDefault: DomainTool | undefined = findDefaultTool(catalog);
    const nullableNamed: DomainTool | undefined = findToolByName(catalog, "custom");
    const nullablePublicNamed: PublicTool | undefined = getToolByName("custom");
    const exact: [
        Equal<ReturnType<typeof createDefaultToolCatalog>, DomainTool[]>,
        Equal<ReturnType<typeof findToolByName>, DomainTool | undefined>,
        Equal<ReturnType<typeof findDefaultTool>, DomainTool | undefined>,
        Equal<ReturnType<typeof getAllCredentialMounts>, DomainMount[]>,
        Equal<ReturnType<typeof getNpmTools>, Array<{ cmd: string; pkg: string }>>,
        Equal<ReturnType<typeof getDefaultTool>, PublicTool>,
        Equal<ReturnType<typeof getToolByName>, PublicTool | undefined>,
        Equal<ReturnType<typeof getAllTools>, PublicTool[]>,
        Equal<ReturnType<typeof publicMounts>, PublicMount[]>,
        Equal<ReturnType<typeof publicNpm>, Array<{ cmd: string; pkg: string }>>,
    ] = [true, true, true, true, true, true, true, true, true, true];

    const toolField: string | undefined = legacyDefault.fixtureOptionalTool;
    const nestedMountField: string | undefined = legacyDefault.credentialMounts[0].fixtureOptionalMount;
    const mount: PublicMount = publicMounts()[0];
    const mountField: string | undefined = mount.fixtureOptionalMount;

    // @ts-expect-error Explicit catalog input is required for name selection.
    findToolByName();
    // @ts-expect-error The query remains required after the catalog.
    findToolByName(catalog);
    // @ts-expect-error Query strings cannot become numbers.
    findToolByName(catalog, 1);
    // @ts-expect-error A catalog is an array, not a name.
    findToolByName("claude", "claude");
    // @ts-expect-error Default selection requires an explicit catalog.
    findDefaultTool();
    // @ts-expect-error Mount projection requires an explicit catalog.
    getAllCredentialMounts();
    // @ts-expect-error Npm projection requires an explicit catalog.
    getNpmTools();
    // @ts-expect-error A factory does not accept an implicit replacement catalog.
    createDefaultToolCatalog(catalog);
    // @ts-expect-error Domain default selection can be missing.
    const requiredDefault: DomainTool = findDefaultTool(catalog);
    // @ts-expect-error Name selection can be missing.
    const requiredNamed: PublicTool = getToolByName("custom");
    // @ts-expect-error The existing public default remains statically nonnull.
    const absentDefault: undefined = getDefaultTool();
    // @ts-expect-error Selectors remain synchronous.
    const asyncCatalog: Promise<DomainTool[]> = createDefaultToolCatalog();
    // @ts-expect-error Mounts retain their own shape.
    const toolsFromMounts: DomainTool[] = getAllCredentialMounts(catalog);
    // @ts-expect-error Npm projection fields remain strings.
    const numericPackages: Array<{ cmd: string; pkg: number }> = getNpmTools(catalog);
    // @ts-expect-error Subcommands remain arrays of strings.
    domainTool.subcommands = [1];
    // @ts-expect-error Mount directories remain strings.
    domainMount.hostDir = 1;
    // @ts-expect-error Required metadata fields remain required.
    const incomplete: PublicTool = { name: "custom" };
    void [inwardMount, outwardMount, publicCatalog, optionalSubcommands, optionalFlags,
        nullableDefault, nullableNamed, nullablePublicNamed, exact, toolField, nestedMountField,
        mountField, requiredDefault, requiredNamed, absentDefault, asyncCatalog, toolsFromMounts,
        numericPackages, incomplete];
}
void compileContracts;

describe("tool catalog source type compatibility", () => {
    it("accepts mutable public metadata as explicit domain input without mutating the public catalog", () => {
        const local: PublicTool[] = createDefaultToolCatalog();
        const mount: PublicMount = { hostDir: "local", containerDir: "/local", fixtureOptionalMount: "mount" };
        local[0].credentialMounts.push(mount);
        local[0].fixtureOptionalTool = "tool";
        local[0].name = "custom";
        expect(findToolByName(local, "custom")).toBe(local[0]);
        expect(getAllCredentialMounts(local)).toContain(mount);
        expect(findDefaultTool(local)).toBeUndefined();
        expect(getDefaultTool().name).toBe("claude");
        expect(publicMounts()).not.toContain(mount);
    });
});
