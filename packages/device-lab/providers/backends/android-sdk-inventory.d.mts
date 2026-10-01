export interface AndroidCreationChoices {
    systemImages: string[];
    deviceProfiles: string[];
    creationDiscovery?: { diagnostics?: string[]; truncated?: true };
}

export function androidCreationChoices(
    discovery: { avdmanager?: string | null; emulator?: string | null; adb?: string | null },
    sdkCandidates: string[],
    runCommand?: (executable: string, args: string[], options: { timeout: number; maxBuffer: number }) => {
        status?: number | null;
        stdout?: string;
        error?: unknown;
        signal?: unknown;
    },
): AndroidCreationChoices;
