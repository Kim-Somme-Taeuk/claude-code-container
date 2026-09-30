# Device Lab MCP computer use

Choose a device from `device_list`, then include its `deviceId` in each operation.
There is no remembered device selection shared between agents. To perform several
known actions, put `deviceId` once on `device_run_flow` and finish with a screenshot;
start a new call when you need to inspect the result before deciding what to do.

## Choose inputs for the target platform

Container-QEMU image, target, readiness, session, workspace, artifact and guest-agent
tools select their backend automatically. For example, `device_target_list({})`
lists container-QEMU targets and `device_readiness_probe({deviceId:"my-vm"})`
checks one. They do not inspect Hyper-V guests. macOS base-image create/clone
also omit the redundant backend selector. Do not pass backend to these tools;
explicit selectors are rejected before provider execution.

Creation uses typed top-level fields. Android AVD provisioning uses `createAvd`
and `systemImage`; iOS provisioning uses `createSimulator`, `deviceType` and
`runtime`. Without the provisioning flag, these backends record a definition.
Hyper-V uses image/profile fields, macOS uses `image` and `ssh*`, and container QEMU uses
`baseImageId` or `sourceImage` with `guest*` controls. Use the named fields directly; `options` wrappers are rejected. macOS
`device_create` uses `image` for image-specific SSH defaults; its separate
base-image create/clone tools use `sourceImage`.

File transfers use `localPath` for the project file and `remotePath` for the device path.
The host broker maps container project paths to the host project. On iOS Simulator,
provide `bundleId`; `remotePath` is relative to that app container (for example,
`Documents/report.txt`), and `containerType` defaults to `data`. App installation
uses `path` for the app package in the project.

Android apps use `packageName` or a launch `component`; iOS apps use `bundleId`.
Permission tools pair Android `packageName` with `permission`, or iOS Simulator
`bundleId` with privacy `service`. Mobile keys are ADB key names/codes on Android
and Appium key values on iOS; use `mobile_home` for the Home button.
Battery `charging` controls simulated AC connection separately from `status`:
1 unknown, 2 charging, 3 discharging, 4 not charging, 5 full, following
[Android BatteryManager constants](https://developer.android.com/reference/android/os/BatteryManager#BATTERY_STATUS_CHARGING).

Use the same seven `device_*` tools for a supported desktop display. Use `device_list` to find an existing owned device and its current `incarnationId`. Check `device_backends` when prerequisites are unclear; `device_inventory` with an explicit backend finds host candidates. `windows-vm` and `linux-vm` mean Hyper-V only when `provider` is `hyper-v`; the container QEMU `linux-vm` provider has a different capability set.

## Screenshot → input → screenshot

1. Create and start the VM with `device_create` and `device_start`. Reuse the returned device ID and current `incarnationId`; request `device_status` only if they are missing or stale. On the first start of a default Hyper-V `linux-vm` guest, `device_start` installs Xfce and starts a graphical desktop automatically. This can add about 15 minutes; the response reports GUI readiness or the failed stage. The persistent console auto-login uses a dedicated unprivileged `ccc-desktop` guest account, separate from the sudo SSH account. Later starts and reboots check readiness and repair the desktop if needed.
2. Call `device_screenshot` with `{ "backend": "windows-vm", "deviceId": "dev-windows", "incarnationId": "<current incarnationId>" }` (or use `linux-vm`). The result is a PNG plus its width and height. The top-left pixel is `(0,0)`; the bottom-right pixel is `(width-1,height-1)`.
3. Call `device_click` with that device, incarnation, and `x,y` measured on the returned image. `button` defaults to `left`; `right` is available. Use `device_double_click` for two clicks.
4. Use `device_key` for one key or combination, such as `Enter`, `Ctrl+A`, or `Alt+Tab`. Hyper-V key names are case insensitive. `device_type` sends text to the focused control; on Hyper-V `windows-vm` only ASCII text is verified. Use `device_scroll` with `direction: "up"` or `"down"`, `x,y`, and optional `amount`. On Hyper-V, `device_cursor_position` reads the current cursor when `x,y` are omitted, or moves it when both screenshot pixel coordinates are supplied.
5. Capture another screenshot and inspect the visible result before the next input. Keep the same `incarnationId`; if the VM was recreated, discover the new incarnation and capture again.

Hyper-V mouse coordinates are pixels of the latest returned PNG and expire after two minutes. Capture again after a VM reboot, restore, or display-size change. Hyper-V horizontal scrolling is unavailable; `left` and `right` are accepted by the generic tool schema for other providers. The Hyper-V key set includes letters, digits, F1–F12, navigation/editing keys, and Ctrl/Alt/Shift/Win combinations. Unsupported keys and missing console devices return errors.

## Capability map

| Provider | Screenshot | Mouse and keyboard | Guest command, files, builds |
| --- | --- | --- | --- |
| Hyper-V `windows-vm` | Real host screenshot proof passed on 2026-09-24 and 2026-09-25 | Real host keyboard, pointer and visible scroll proof passed on 2026-09-24 and 2026-09-25; only ASCII typing is verified | Windows Level 3 host test passed |
| Hyper-V `linux-vm` | Real host screenshot proof passed on 2026-09-26 | Real host keyboard, pointer and visible scroll proof passed on 2026-09-26; text and wheel go through the guest X11 session; `device_start` prepares the default image automatically | Linux Level 3 host test passed |
| Container QEMU `linux-vm` | Check `device_backends`; GUI tools are not advertised | Check `device_backends`; GUI tools are not advertised | Provider-specific guest tools |
| `windows-sandbox`, `macos-vm`, `x11-current-display` | Existing desktop tools, when available | Existing desktop tools, when available | Varies by provider |
| Android/iOS | Screenshot and mobile interaction tools vary by backend | Use `mobile_*` tools for touch and mobile keys | Varies by provider |

The latest Windows (2026-09-25) and Linux (2026-09-26) Level 3 GUI runs have passed on the Windows Hyper-V host. A successful screenshot or native input call by itself does not prove that a guest UI changed. Capture a second screenshot to check the result.

To check both guests on a Windows Hyper-V host, run `npm run test:level3:hyper-v`. For one guest, use `npm run test:level3:hyper-v:windows` or `npm run test:level3:hyper-v:linux`. These default tests verify screenshot, pointer, keyboard and visible scroll through packaged MCP, and check a nonce file created inside the guest by GUI typing (the console on Windows, the X11 session on Linux). The Linux run prepares Xfce automatically during `device_start`. These host runs cannot be executed from inside a development container; run them on the Windows host.

## When the display is unavailable

- `hyper-v-display-unavailable`: start the VM and wait for its graphical session. For the default `ubuntu-lts` server image, wait for `device_start` to finish; its first run can take about 15 extra minutes and reports the failed setup stage if the desktop cannot be prepared. SSH readiness alone does not mean the desktop is ready.
- Windows evaluation VM at the sign-in screen: the unattended bootstrap uses a one-time auto-login; after reboot, interactive sign-in may be needed before GUI automation can reach the desktop. The default Windows Level 3 GUI proof runs during that first desktop session.
- Identity conflict or stale incarnation: call `device_status` for that device, use the current `incarnationId`, then capture a new screenshot before input.
- `device-cursor-move-backend-unsupported`: only Hyper-V `windows-vm` and `linux-vm` move the cursor. Other providers only read it, so omit `x,y` there, or move the pointer with `device_click` where that is acceptable.
- Native console device or permission error: check Hyper-V host support and permissions for the exact VM. These tools do not redirect input to the host desktop or another VM.

## Multiple actions on one device

Use `device_run_flow` for supported desktop or mobile steps. Its step-tool enum
lists the accepted canonical actions. For example, install and launch an Android
app, then wait until its UI is ready:

```json
{
  "deviceId": "android-my-app",
  "backend": "android-emulator",
  "steps": [
    { "tool": "device_install_app", "arguments": { "path": "/project/app.apk" } },
    { "tool": "device_launch_app", "arguments": { "packageName": "com.example.app" } },
    { "tool": "mobile_wait_for_text", "arguments": { "text": "Welcome" } }
  ]
}
```

Steps stop on failure by default. Add `device_screenshot` as the last step to
inspect the result in the same response. Images appear after the JSON summary;
each producing step identifies its image/content range with `contentIndex` and
`contentCount` (zero-based in the outer content array). Arguments
are literal, with no result interpolation. Set `incarnationId` at the flow level
when the target requires it; only step tools accepting that field inherit it. A step changing `deviceId` or `backend` must supply
its complete new target: none of the old target fields are inherited. Each
destructive step requires its own `confirmDestructive:true`; routing controls
and confirmations are never inherited from the flow.

Use `device_install_app`, `device_launch_app`, `device_screenshot` and
`mobile_set_orientation` for all calls. Old mobile aliases and `mobile_run_flow`
are removed; use `device_run_flow` for ordered actions.

## Waiting for a mobile condition

Use one `mobile_wait_for_text` or `mobile_wait_for_app` call instead of repeated
status/UI calls. `timeoutMs` is the observation allowance after initial device
discovery and Appium setup; the default is 10000 ms. Observation commands,
requests and pauses share that allowance. Process inspection, filesystem work,
termination and timer scheduling can add overhead. A completed non-match is
different from an observation error; flows stop on an unmet wait by default.
Update client and host broker together for host-side cancellation support.
