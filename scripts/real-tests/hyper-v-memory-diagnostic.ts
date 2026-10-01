import { publicHyperVMemoryCapacity } from "#device-lab/device-lab/broker/hyper-v/public-response.js";

/** Match the broker's bounded memory refusal, without echoing its transport envelope. */
export function hyperVMemoryFailureReason(value: any): string | undefined {
    const code = "hyper-v-host-memory-capacity-exceeded";
    const envelopes = [value, value?.body, value?.selected?.body];
    const commands = envelopes.map((item) => item?.result?.execution?.command);
    if (!envelopes.some((item) => item?.detail === code || item?.error === code)
        && !commands.some((item) => item?.diagnosticCode === code)) return undefined;
    const capacity = commands.map((item) => publicHyperVMemoryCapacity(item?.capacity)).find(Boolean);
    const metrics = capacity
        ? ` Requested ${capacity.requestedMb} MiB; available ${capacity.availableMb} MiB; host reserve ${capacity.reserveMb} MiB; shortfall ${capacity.shortfallMb} MiB.`
        : ".";
    return `${code}${metrics} Free host RAM by closing unused VMs or applications, then retry.`;
}
