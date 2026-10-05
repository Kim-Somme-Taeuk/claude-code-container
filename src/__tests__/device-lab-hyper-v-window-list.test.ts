import { describe, expect, it } from "vitest";
import { linuxWindowListCommand, windowsWindowListCommand, parseGuestWindowList } from "@ccc/device-lab/device-lab/broker/hyper-v/window-list.js";
import { X11_WINDOW_LIST_COMMAND } from "@ccc/device-lab/providers/display/window-list.mjs";

describe("Hyper-V window observation", () => {
    it("uses the existing managed Linux GUI account and exact shared collector", () => {
        const command = linuxWindowListCommand();
        expect(command).toContain("sudo -n -u ccc-desktop env DISPLAY=:0 XAUTHORITY=/home/ccc-desktop/.Xauthority bash");
        const encoded = command.match(/printf %s ([A-Za-z0-9+/=]+)/)![1];
        expect(Buffer.from(encoded, "base64").toString()).toBe(X11_WINDOW_LIST_COMMAND);
    });
    it("fits the guest exec bound and enforces console-user/session fencing, atomic result and cleanup", () => {
        const command = windowsWindowListCommand();
        expect(command.length).toBeLessThanOrEqual(4096);
        expect(command).toContain(".UserName -ne $user");
        expect(command).toContain("-LogonType Interactive -RunLevel Limited");
        expect(command).toContain(".SessionId -ne [int]$Expected");
        expect(command).toContain("WTSGetActiveConsoleSessionId() -ne $sid");
        expect(command).toContain("SetAccessRuleProtection($true,$false)");
        expect(command).toContain("[IO.File]::Move(($out+'.tmp'),$out)");
        expect(command).toContain("-ExecutionTimeLimit (New-TimeSpan -Seconds 20)");
        expect(command).toContain("Stop-ScheduledTask -TaskName $name");
        expect(command).toContain("Unregister-ScheduledTask -TaskName $name");
        expect(command).toContain("Remove-Item -LiteralPath $dir -Recurse -Force");
        expect(command).toContain("while($json.Length -gt 8000)");
        expect(command).toContain("$result.truncated=$true");
    });
    it("retains only actionable Windows data with explicit truncation", () => {
        expect(parseGuestWindowList("windows-vm", JSON.stringify({windows:[{handle:"42",title:"한글\napp",processId:123,noise:"discard"}],truncated:true})))
            .toEqual({windows:[{handle:"42",title:"한글\napp",processId:123}],truncated:true});
        expect(parseGuestWindowList("windows-vm", '{"windows":[],"truncated":false}')).toEqual({windows:[]});
    });
    it.each(["{}", "null", "not-json", '{"windows":[{}]}', JSON.stringify({windows:Array(129).fill({})}), "x".repeat(1048577)])("refuses invalid success %#", stdout => {
        expect(() => parseGuestWindowList("windows-vm", stdout)).toThrow("window-list-invalid-result");
    });
    it("preserves worker failures instead of returning an empty success", () => {
        expect(() => parseGuestWindowList("windows-vm", '{"error":"window-list-session-changed"}')).toThrow("window-list-session-changed");
    });
});
