export { inspectHyperVVirtualMachine } from "./inspect.js";
export {
    executeHyperVHostNetworkAction,
    planHyperVHostNetworkCleanup,
    reconcileHyperVHostNetwork,
} from "./network-reconcile.js";
export { reconcileHyperVVirtualMachine } from "./reconcile.js";
export {
    confirmHyperVBootstrapContainment,
    discoverHyperVBootstrapAddresses,
    planHyperVBootstrapTeardown,
    selectHyperVBootstrapAddresses,
} from "./vm-network-reconcile.js";
export { retryHyperVLifecycle } from "./retry.js";
export type {
    HyperVAbsentOutcome,
    HyperVAttachmentConflictOutcome,
    HyperVAttachmentDrift,
    HyperVAttachmentExpectation,
    HyperVIdentityConflictOutcome,
    HyperVLifecycleRetryContext,
    HyperVLifecycleRetryOptions,
    HyperVLifecycleSleeper,
    HyperVPendingOutcome,
    HyperVSettledOutcome,
    HyperVUnexpectedAttachment,
    HyperVVirtualMachineExpectation,
    HyperVVirtualMachineInspection,
    HyperVVirtualMachineIntent,
    HyperVVirtualMachineReconciliationOutcome,
} from "./contracts.js";
export type {
    HyperVHostNetworkActionKind,
    HyperVHostNetworkCleanupObservation,
    HyperVHostNetworkCleanupProvenance,
    HyperVHostNetworkConflictOutcome,
    HyperVHostNetworkConflictReason,
    HyperVHostNetworkEnsureProvenance,
    HyperVHostNetworkIndeterminateOutcome,
    HyperVHostNetworkManagedResource,
    HyperVHostNetworkNatEvidence,
    HyperVHostNetworkNeedsAdministratorOutcome,
    HyperVHostNetworkObservation,
    HyperVHostNetworkPrivilege,
    HyperVHostNetworkSettledIdentity,
    HyperVHostNetworkSettledOutcome,
} from "./network-contracts.js";
export type {
    HyperVHostNetworkExecuteOutcome,
    HyperVHostNetworkExecutionResult,
    HyperVHostNetworkReconciliationOutcome,
} from "./network-reconcile.js";
export type {
    HyperVBootstrapAdapterExpectation,
    HyperVBootstrapContainmentOutcome,
    HyperVBootstrapDiscoveryDiagnostic,
    HyperVBootstrapDiscoveryOutcome,
    HyperVBootstrapHostObservation,
    HyperVBootstrapTeardownDecision,
} from "./vm-network-contracts.js";
export {
    // Exported because an executor needs it, not for symmetry. It is what makes "a step cannot
    // be added without saying how to undo it" true; a consumer that cannot reach it hand-rolls
    // the step-to-effect mapping, which is the duplication the function exists to prevent.
    effectKindOfStep,
    planHyperVVirtualMachineCreation,
    planHyperVVirtualMachineCreationCompensation,
} from "./vm-create-reconcile.js";
export type {
    HyperVCreateCompensation,
    HyperVCreateEffect,
    HyperVCreateNetworkIntent,
    HyperVCreateStep,
    HyperVCreateVirtualMachineRequest,
} from "./vm-create-contracts.js";
