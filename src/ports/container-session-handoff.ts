import type { ExistingContainerIdentity } from "./container-existing-lifecycle.js";

export interface ContainerSessionHandoffPorts {
    assertProjectSources(): undefined;
    assertFilesystemSources(): undefined;
    identity(id: string): ExistingContainerIdentity | null;
}
