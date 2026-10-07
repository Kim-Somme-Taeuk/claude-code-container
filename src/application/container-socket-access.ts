import type { ContainerSocketAccessPorts } from "../ports/container-socket-access.js";

export function createContainerSocketAccess(ports: ContainerSocketAccessPorts) {
    for (const name of ["probe", "grant", "warn"] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container socket access requires a callable ${name} port.`);
        }
    }

    let warned = false;

    function warn(): undefined {
        if (warned) return;
        warned = true;
        ports.warn();
    }

    function run(target: string): undefined {
        const probe = ports.probe(target);
        if (probe.status === 0) return;
        const [user, gid] = String(probe.stdout ?? "").trim().split(/\s+/);
        if (probe.status !== 10
            || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user ?? "")
            || !/^\d{1,10}$/.test(gid ?? "")) {
            warn();
            return;
        }
        const grant = ports.grant(target, user, gid);
        if (grant.status !== 0) warn();
    }

    function resetWarning(): undefined {
        warned = false;
    }

    return { run, resetWarning };
}
