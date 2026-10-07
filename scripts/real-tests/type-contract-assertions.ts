import type { DeviceLabToolOutputMap } from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";
declare const lifecycle: DeviceLabToolOutputMap["start"];
lifecycle.device.deviceId;
// @ts-expect-error lifecycle responses expose device.deviceId, not a top-level deviceId.
lifecycle.deviceId;
// @ts-expect-error removed public operation is not a contract key.
type Removed = DeviceLabToolOutputMap["automation_status"];
// Every published action must be accepted by the typed response API.
const focused: DeviceLabToolOutputMap["focus_window"] = "ok";
void focused;
