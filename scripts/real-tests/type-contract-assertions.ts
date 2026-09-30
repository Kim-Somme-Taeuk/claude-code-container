import type { DeviceLabToolOutputMap } from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";
declare const lifecycle: DeviceLabToolOutputMap["start"];
lifecycle.device.id;
// @ts-expect-error lifecycle responses expose device.id, not a top-level deviceId.
lifecycle.deviceId;
// @ts-expect-error removed public operation is not a contract key.
type Removed = DeviceLabToolOutputMap["automation_status"];
