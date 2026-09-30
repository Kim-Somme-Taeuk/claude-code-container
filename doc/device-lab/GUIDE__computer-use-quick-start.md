# Device Lab MCP computer use

Public tool names describe actions without platform prefixes. Use `click` for
desktop clicks and mobile taps, `type` for text, and `key` for keys. Mobile
clicks support only the left button. `swipe` and `long_press` remain distinct
touch gestures. The current container display has deviceId `x11-current-display`.

Simple successful actions reply `ok`; queries return their data or image.
Warnings and errors remain visible. Screenshots keep any incarnationId needed
for subsequent input. Request `detail:true` only for troubleshooting.

Choose a device from `list_devices`, then include its `deviceId` in each operation.
There is no remembered device selection shared between agents. To perform several
known actions, put `deviceId` once on `run_flow` and finish with a screenshot;
start a new call when you need to inspect the result before deciding what to do.

## Browse and transfer files

Use `list_files({deviceId,path})` to see immediate directory entries, including
hidden files. Each entry has `name`, `type`, and file `size` when available.
An empty directory returns `entries:[]`; failures remain errors. Results default
to 100 entries (`limit` accepts 1–500) and have a fixed byte cap;
`truncated:true` means more entries exist. Listing does not recurse or read file
contents. POSIX directory globs expand before the bounded output loop, so a very
large directory may still hit the transport deadline.

Use `upload` and `download` to transfer files. On iOS Simulator, specify
`bundleId` and an app-relative `path`, such as `Documents`; `containerType`
defaults to `data`. Paths cannot escape that app container. Actual iPhones can
expose file-sharing-enabled app Documents, but Device Lab does not yet implement
that physical-iOS listing adapter. This is not unrestricted iPhone filesystem
access.

## Preparation tools that remain

`create` defines a device; `attach` and `wireless` connect physical devices;
`start` boots a device. `image_import`, `base_image_create` and `base_image_clone`
manage image inputs, while `workspace_sync` prepares working files. These are
intentional resource changes. `backends` and `inventory` are queries. Internal
disk, guest-agent and automation-session preparation runs through the operation
that needs it, without a separate prerequisite tool call.

## Choose inputs for the target platform

Use `status({deviceId})` for device state and automation diagnostics. For a running
container-QEMU VM it also refreshes configured SSH/guest-agent readiness; a stopped
VM is reported without a guest probe. Use `backends` for host prerequisites and
broker diagnosis. There are no separate broker, automation, target-list or
readiness tools to call first.

QEMU `start` prepares the writable disk and configured guest agent. A provisioning
command enables automatic preparation unless `guestAgentAutoProvision:false` was
explicitly configured. A failed preparation keeps the VM running and returns an
error; retry `start` to retry preparation without booting a second VM. `status`
never provisions anything. Commands and file transfers need no session-open call.
Image/workspace/artifact tools select their backend automatically; macOS base-image
create/clone also omit the redundant selector.

Creation uses typed top-level fields. Android AVD provisioning uses `createAvd`
and `systemImage`; iOS provisioning uses `createSimulator`, `deviceType` and
`runtime`. Without the provisioning flag, these backends record a definition.
Hyper-V uses image/profile fields, macOS uses `image` and `ssh*`, and container QEMU uses
`baseImageId` or `sourceImage` with `guest*` controls. Use the named fields directly; `options` wrappers are rejected. macOS
`create` uses `image` for image-specific SSH defaults; its separate
base-image create/clone tools use `sourceImage`.

File transfers use `localPath` for the project file and `remotePath` for the device path.
The host broker maps container project paths to the host project. On iOS Simulator,
provide `bundleId`; `remotePath` is relative to that app container (for example,
`Documents/report.txt`), and `containerType` defaults to `data`. App installation
uses `path` for the app package in the project.

Android apps use `packageName` or a launch `component`; iOS apps use `bundleId`.
`permission` uses `action:"grant"` or `action:"revoke"` and pairs Android `packageName` with `permission`, or iOS Simulator
`bundleId` with privacy `service`. Mobile keys are ADB key names/codes on Android
and Appium key values on iOS; use `home` for the Home button.
Battery `charging` controls simulated AC connection separately from `status`:
1 unknown, 2 charging, 3 discharging, 4 not charging, 5 full, following
[Android BatteryManager constants](https://developer.android.com/reference/android/os/BatteryManager#BATTERY_STATUS_CHARGING).

Use the same action tools for mobile and desktop devices. Use `list_devices` to find an existing owned device and its current `incarnationId`. Check `backends` when prerequisites are unclear; `inventory` with an explicit backend finds host candidates. `windows-vm` and `linux-vm` mean Hyper-V only when `provider` is `hyper-v`; the container QEMU `linux-vm` provider has a different capability set.

## Screenshot → input → screenshot

1. Create and start the VM with `create` and `start`. Reuse the returned device ID and current `incarnationId`; request `status` only if they are missing or stale. On the first start of a default Hyper-V `linux-vm` guest, `start` installs Xfce and starts a graphical desktop automatically. This can add about 15 minutes; the response reports GUI readiness or the failed stage. The persistent console auto-login uses a dedicated unprivileged `ccc-desktop` guest account, separate from the sudo SSH account. Later starts and reboots check readiness and repair the desktop if needed.
2. Call `screenshot` with `{ "deviceId": "dev-windows", "incarnationId": "<current incarnationId>" }`. The result is a PNG plus its width and height. The top-left pixel is `(0,0)`; the bottom-right pixel is `(width-1,height-1)`.
3. Call `click` with that device, incarnation, and `x,y` measured on the returned image. `button` defaults to `left`; `right` is available. Use `double_click` for two clicks.
4. Use `key` for one key or combination, such as `Enter`, `Ctrl+A`, or `Alt+Tab`. Hyper-V key names are case insensitive. `type` sends text to the focused control; on Hyper-V `windows-vm` only ASCII text is verified. Use `scroll` with `direction: "up"` or `"down"`, `x,y`, and optional `amount`. `cursor_position` reads the cursor; `move` moves it using required x,y screenshot coordinates.
5. Capture another screenshot and inspect the visible result before the next input. Keep the same `incarnationId`; if the VM was recreated, discover the new incarnation and capture again.

Hyper-V mouse coordinates are pixels of the latest returned PNG and expire after two minutes. Capture again after a VM reboot, restore, or display-size change. Hyper-V horizontal scrolling is unavailable; `left` and `right` are accepted by the generic tool schema for other providers. The Hyper-V key set includes letters, digits, F1–F12, navigation/editing keys, and Ctrl/Alt/Shift/Win combinations. Unsupported keys and missing console devices return errors.

## Capability map

| Provider | Screenshot | Mouse and keyboard | Guest command, files, builds |
| --- | --- | --- | --- |
| Hyper-V `windows-vm` | Real host screenshot proof passed on 2026-09-24 and 2026-09-25 | Real host keyboard, pointer and visible scroll proof passed on 2026-09-24 and 2026-09-25; only ASCII typing is verified | Windows Level 3 host test passed |
| Hyper-V `linux-vm` | Real host screenshot proof passed on 2026-09-26 | Real host keyboard, pointer and visible scroll proof passed on 2026-09-26; text and wheel go through the guest X11 session; `start` prepares the default image automatically | Linux Level 3 host test passed |
| Container QEMU `linux-vm` | Check `backends`; GUI tools are not advertised | Check `backends`; GUI tools are not advertised | Provider-specific guest tools |
| `windows-sandbox`, `macos-vm`, `x11-current-display` | Existing desktop tools, when available | Existing desktop tools, when available | Varies by provider |
| Android/iOS | Screenshot and mobile interaction tools vary by backend | Use click, type and key; use swipe and long_press for touch gestures | Varies by provider |

The latest Windows (2026-09-25) and Linux (2026-09-26) Level 3 GUI runs have passed on the Windows Hyper-V host. A successful screenshot or native input call by itself does not prove that a guest UI changed. Capture a second screenshot to check the result.

To check both guests on a Windows Hyper-V host, run `npm run test:level3:hyper-v`. For one guest, use `npm run test:level3:hyper-v:windows` or `npm run test:level3:hyper-v:linux`. These default tests verify screenshot, pointer, keyboard and visible scroll through packaged MCP, and check a nonce file created inside the guest by GUI typing (the console on Windows, the X11 session on Linux). The Linux run prepares Xfce automatically during `start`. These host runs cannot be executed from inside a development container; run them on the Windows host.

## When the display is unavailable

- `hyper-v-display-unavailable`: start the VM and wait for its graphical session. For the default `ubuntu-lts` server image, wait for `start` to finish; its first run can take about 15 extra minutes and reports the failed setup stage if the desktop cannot be prepared. SSH readiness alone does not mean the desktop is ready.
- Windows evaluation VM at the sign-in screen: the unattended bootstrap uses a one-time auto-login; after reboot, interactive sign-in may be needed before GUI automation can reach the desktop. The default Windows Level 3 GUI proof runs during that first desktop session.
- Identity conflict or stale incarnation: call `status` for that device, use the current `incarnationId`, then capture a new screenshot before input.
- `device-cursor-move-backend-unsupported`: `move` supports the current X11 display and Hyper-V `windows-vm`/`linux-vm`. Other providers report unsupported; `cursor_position` never moves it.
- Native console device or permission error: check Hyper-V host support and permissions for the exact VM. These tools do not redirect input to the host desktop or another VM.

## Multiple actions on one device

Use `run_flow` for supported desktop or mobile steps. Its step-tool enum
lists the accepted canonical actions. For example, install and launch an Android
app, then wait until its UI is ready:

```json
{
  "deviceId": "android-my-app",
  "steps": [
    { "tool": "install_app", "arguments": { "path": "/project/app.apk" } },
    { "tool": "launch_app", "arguments": { "packageName": "com.example.app" } },
    { "tool": "wait_for_text", "arguments": { "text": "Welcome" } }
  ]
}
```

Steps stop on failure by default. Add `screenshot` as the last step to
inspect the result in the same response. Images appear after the JSON summary;
each producing step identifies its image/content range with `contentIndex` and
`contentCount` (zero-based in the outer content array). Arguments
are literal, with no result interpolation. Set `incarnationId` at the flow level
when the target requires it; only step tools accepting that field inherit it. A step changing `deviceId` must supply
its complete new target: none of the old target fields are inherited. Each
destructive step requires its own `confirmDestructive:true`; routing controls
and confirmations are never inherited from the flow.

Use `install_app`, `launch_app`, `screenshot` and
`set_orientation` for all calls. Old prefixed names are removed; use `run_flow` for ordered actions.

## Waiting for a mobile condition

Use one `wait_for_text` or `wait_for_app` call instead of repeated
status/UI calls. `timeoutMs` is the observation allowance after initial device
discovery and Appium setup; the default is 10000 ms. Observation commands,
requests and pauses share that allowance. Process inspection, filesystem work,
termination and timer scheduling can add overhead. A completed non-match is
different from an observation error; flows stop on an unmet wait by default.
Update client and host broker together for host-side cancellation support.

Existing-device calls use `deviceId` only to choose the device. Do not supply `backend` to actions, status, lifecycle operations or `run_flow`; ownership records select the provider.

## Focused management tools

All these calls use an explicit `deviceId`:

| Tool | Operation |
| --- | --- |
| `ui` | Read the mobile hierarchy or desktop accessibility tree automatically. |
| `snapshot` | `action`: `list`, `create`, `restore`, `delete`. |
| `record_video` | `action`: `start`, `stop`, `status`; stop retains saved artifacts. |
| `clipboard` | Omit `text` to read; provide `text` to write, including an empty string. |
| `permission` | `action`: `grant` or `revoke`, with the app and permission/service. |

Each operation keeps its required fields and destructive confirmation. Flow
support is checked for the chosen operation, not granted to an entire group.
Old separate tool names are rejected.
