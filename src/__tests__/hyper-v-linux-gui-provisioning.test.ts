import { describe, expect, it } from "vitest";

import { hyperVLinuxGuiPrepareCommand, hyperVLinuxGuiReadyCommand, hyperVLinuxGuiTypeGuestCommand, hyperVLinuxGuiScrollGuestCommand } from "../host-control/hyper-v/index.js";

const ssh = {
    executable: "ssh.exe",
    deviceRoot: "/state/owner/device",
    privateRoot: "/state/owner/private",
    sshPrivateKeyPath: "/state/owner/private/id_ed25519",
    knownHostsPath: "/state/owner/private/known_hosts",
    guestUsername: "ccc01234567",
    networkAddress: "172.29.0.10",
};

function guestScript(command: ReturnType<typeof hyperVLinuxGuiPrepareCommand>): string {
    const remoteCommand = command.args.at(-1) || "";
    const encoded = remoteCommand.match(/^printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash$/)?.[1];
    expect(encoded).toBeTruthy();
    return Buffer.from(encoded || "", "base64").toString("utf8");
}

describe("Hyper-V Linux graphical session preparation", () => {
    it("keeps first-start installation bounded, noninteractive, and observable", () => {
        const command = hyperVLinuxGuiPrepareCommand(ssh);
        const script = guestScript(command);
        expect(command).toMatchObject({ mode: "exec", provider: "hyper-v-ssh" });
        expect(command.args).toContain("StrictHostKeyChecking=yes");
        expect(script.indexOf("if systemctl is-active --quiet lightdm")).toBeLessThan(script.indexOf("sudo -n true"));
        expect(script).toContain("sudo -n true");
        expect(script).toContain("120s env DEBIAN_FRONTEND=noninteractive apt-get");
        expect(script).toContain("720s env DEBIAN_FRONTEND=noninteractive apt-get");
        expect(script).toContain("--no-install-recommends xorg xserver-xorg-video-fbdev lightdm lightdm-gtk-greeter xfce4 xfce4-terminal dbus-x11 xdotool");
        expect(script).toContain("useradd -m -s /bin/bash -U ccc-desktop");
        expect(script).toContain("autologin-user=ccc-desktop");
        expect(script).not.toContain("autologin-user=ccc01234567");
        expect(script).toContain("systemctl set-default graphical.target");
        expect(script).toContain("systemctl restart lightdm");
        expect(script).toContain("pgrep -x Xorg");
        expect(script).toContain("pgrep -u ccc-desktop -x xfce4-session");
        expect(script).toContain("command -v xdotool >/dev/null");
        expect(script).toContain("CCC_HYPER_V_GUI_READY");
        expect(script).toContain("hyper-v-linux-gui-ready-failed");
    });

    it("checks the running session without mutating the guest", () => {
        const script = guestScript(hyperVLinuxGuiReadyCommand(ssh));
        expect(script).toContain("systemctl is-active --quiet lightdm");
        expect(script).toContain("pgrep -x Xorg");
        expect(script).toContain("pgrep -u ccc-desktop -x xfce4-session");
        expect(script).toContain("command -v xdotool >/dev/null");
        expect(script).toContain("CCC_HYPER_V_GUI_READY");
        expect(script).not.toMatch(/apt-get|sudo|systemctl start/);
    });

    it("rejects guest usernames that could change shell command structure", () => {
        expect(() => hyperVLinuxGuiPrepareCommand({ ...ssh, guestUsername: "user; reboot" })).toThrow("hyper-v-linux-guest-username-invalid");
        expect(() => hyperVLinuxGuiReadyCommand({ ...ssh, guestUsername: "user$(id)" })).toThrow("hyper-v-linux-guest-username-invalid");
    });

    it("types text through the desktop X11 session without shell interpolation", () => {
        const secret = "hello ' $(touch /tmp/wrong) 한글";
        const script = hyperVLinuxGuiTypeGuestCommand(secret);
        expect(script).not.toContain(secret);
        expect(script).toContain(Buffer.from(secret, "utf8").toString("base64"));
        expect(script).toContain("sudo -n -u ccc-desktop env DISPLAY=:0 XAUTHORITY=/home/ccc-desktop/.Xauthority xdotool type --clearmodifiers --delay 10 --file -");
        expect(() => hyperVLinuxGuiTypeGuestCommand("a\0b")).toThrow("hyper-v-console-text-invalid");
    });

    it("scrolls with X11 wheel buttons at the current pointer and bounds the amount", () => {
        expect(hyperVLinuxGuiScrollGuestCommand("up", 10)).toContain("xdotool click --repeat 10 --delay 40 4");
        expect(hyperVLinuxGuiScrollGuestCommand("down", 1)).toContain("xdotool click --repeat 1 --delay 40 5");
        expect(hyperVLinuxGuiScrollGuestCommand("up", 1)).not.toContain("mousemove");
        expect(() => hyperVLinuxGuiScrollGuestCommand("up", 11)).toThrow("hyper-v-console-scroll-amount-invalid");
        expect(() => hyperVLinuxGuiScrollGuestCommand("left" as "up", 1)).toThrow("hyper-v-console-scroll-direction-invalid");
    });
});
