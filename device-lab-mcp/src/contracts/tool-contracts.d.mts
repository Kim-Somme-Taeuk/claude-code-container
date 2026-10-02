export type DeviceBackend = "android-emulator" | "android-device" | "ios-simulator" | "ios-device" | "windows-sandbox" | "windows-vm" | "macos-vm" | "linux-vm";
export type ObjectOutput = Record<string, unknown>;
export type ActionOutput = "ok" | ObjectOutput;
export interface DeviceRecord {
    deviceId: string;
    backend?: DeviceBackend;
    status?: string;
    provider?: string;
    providerInstance?: string;
    udid?: string;
    runtime?: ObjectOutput;
    helper?: { ssh?: { host?: string; user?: string; [key: string]: unknown }; [key: string]: unknown };
    [key: string]: unknown;
}
export interface LifecycleOutput {
    device: DeviceRecord;
    routedBy?: string;
    boot?: { ready?: boolean; ip?: string; error?: string; stderr?: string; [key: string]: unknown };
    helper?: { status?: string; [key: string]: unknown };
    alreadyAttached?: boolean;
    physicalDevicePoweredOff?: boolean;
    hostDevice?: unknown;
}
export interface DeleteOutput { deleted: string; routedBy?: string; providerDeleted?: string[] }
export interface MobileSessionStatusOutput {
    deviceId: string;
    backend?: DeviceBackend;
    session?: unknown;
    routedBy?: string;
    provider?: string;
    automationName?: string;
    lazy?: boolean;
    appium?: unknown;
}
export interface DeviceListOutput { devices: DeviceRecord[] }
export interface FlowOutput { results: ObjectOutput[] }
export interface ImageToolResult { content: Array<{ type: string; data?: string; mimeType?: string; [key: string]: unknown }>; isError?: boolean }
export interface WaitOutput extends ObjectOutput {
    matched: boolean;
    appId?: string;
    found?: boolean;
    running?: boolean;
    reason?: "wait-condition-not-met";
}

export interface DeviceLabToolOutputMap {
    snapshot: ObjectOutput;
    record_video: ObjectOutput;
    permission: ObjectOutput;
    clipboard: ActionOutput;
    ui: ObjectOutput;
    list_files: { entries: Array<{ name: string; type: "file" | "directory" | "symlink" | "other"; size?: number }>; truncated?: true };
    devices: DeviceListOutput | DeviceRecord[] | ObjectOutput;
    wireless: ObjectOutput;
    list_images: ObjectOutput;
    import_image: ObjectOutput;
    reboot: ObjectOutput;
    workspace_sync: ObjectOutput;
    artifacts_export: ObjectOutput;
    create_android_emulator: LifecycleOutput;
    create_ios_simulator: LifecycleOutput;
    create_windows_vm: LifecycleOutput;
    create_windows_sandbox: LifecycleOutput;
    create_linux_vm: LifecycleOutput;
    create_macos_vm: LifecycleOutput;
    attach: LifecycleOutput;
    detach: ObjectOutput;
    delete: DeleteOutput;
    start: LifecycleOutput;
    stop: LifecycleOutput;
    status: LifecycleOutput | DeviceRecord;
    exec: ObjectOutput;
    screenshot: ImageToolResult;
    click: ActionOutput;
    key: ActionOutput;
    type: ActionOutput;
    scroll: ActionOutput;
    cursor_position: ObjectOutput & ({ x: number; y: number } | { cursor: { x: number; y: number } });
    window_list: ObjectOutput;
    upload: ObjectOutput;
    download: ObjectOutput;
    reset: ObjectOutput;
    install_app: ObjectOutput;
    launch_app: ObjectOutput;
    long_press: ActionOutput;
    swipe: ActionOutput;
    drag: ActionOutput;
    home: ActionOutput;
    back: ActionOutput;
    forward: ActionOutput;
    recents: ActionOutput;
    power: ActionOutput;
    lock: ActionOutput;
    unlock: ActionOutput;
    set_orientation: ActionOutput;
    open_url: ActionOutput;
    uninstall_app: ObjectOutput;
    stop_app: ObjectOutput;
    clear_app_data: ObjectOutput;
    set_location: ActionOutput;
    set_battery: ActionOutput;
    set_network: ActionOutput;
    wait_for_text: WaitOutput;
    wait_for_app: WaitOutput;
    run_flow: FlowOutput;
    move: ActionOutput;
    focus_window: ActionOutput;
}

export const DEVICE_LAB_OUTPUT_CONTRACTS: Readonly<Record<keyof DeviceLabToolOutputMap, string>>;
export function validateDeviceLabToolOutput<K extends keyof DeviceLabToolOutputMap>(tool: K, payload: unknown, args?: Record<string, unknown>): DeviceLabToolOutputMap[K];
export function hasDeviceLabOutputContract(tool: string): tool is keyof DeviceLabToolOutputMap;
