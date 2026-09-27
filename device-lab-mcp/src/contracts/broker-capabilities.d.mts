export interface ParsedBrokerCapability {
    family: string;
    version: number | null;
}

export function parseBrokerCapability(capability: unknown): ParsedBrokerCapability;
export function brokerCapabilitySatisfied(required: unknown, implemented: readonly unknown[] | null | undefined): boolean;
export function missingBrokerCapabilities(
    required: readonly unknown[] | null | undefined,
    implemented: readonly unknown[] | null | undefined,
): string[];
