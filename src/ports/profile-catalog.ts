export interface ProfileSettings {
    env?: Record<string, string>;
    [key: string]: unknown;
}

export interface BuiltinProfile {
    description: string;
    settings?: ProfileSettings;
}

export interface ProfileCatalogPorts {
    listProfileDirectoryNames(): string[];
    profileEntryExists(name: string): boolean;
    writeProfile(name: string, settings?: ProfileSettings): void;
    removeProfileDirectory(name: string): void;
    hasBuiltinProfile(name: string): boolean;
    readBuiltinSettings(name: string): ProfileSettings | undefined;
}
