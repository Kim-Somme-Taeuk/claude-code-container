export type DeviceBackend = "android-emulator" | "android-device" | "ios-simulator" | "ios-device" | "windows-sandbox" | "windows-vm" | "macos-vm" | "linux-vm";
export type ObjectOutput = Record<string, unknown>;
export type ActionOutput = "ok" | ObjectOutput;
export interface DeviceRecord {
    id: string;
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

export interface DeviceLabToolOutputMap {
    snapshot: ObjectOutput;
    record_video: ObjectOutput;
    permission: ObjectOutput;
    clipboard: ActionOutput;
    ui: ObjectOutput;
    backends: ObjectOutput;
    list_devices: DeviceListOutput | DeviceRecord[];
    inventory: ObjectOutput;
    wireless: ObjectOutput;
    image_list: ObjectOutput;
    image_import: ObjectOutput;
    reboot: ObjectOutput;
    workspace_sync: ObjectOutput;
    artifacts_export: ObjectOutput;
    create: LifecycleOutput;
    attach: LifecycleOutput;
    detach: ObjectOutput;
    delete: DeleteOutput;
    start: LifecycleOutput;
    stop: LifecycleOutput;
    status: LifecycleOutput | DeviceRecord;
    exec: ObjectOutput;
    screenshot: ImageToolResult;
    click: ActionOutput;
    double_click: ActionOutput;
    key: ActionOutput;
    type: ActionOutput;
    scroll: ActionOutput;
    cursor_position: ObjectOutput;
    window_list: ObjectOutput;
    base_image_create: LifecycleOutput;
    base_image_clone: LifecycleOutput;
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
    toggle_airplane_mode: ActionOutput;
    wait_for_text: ObjectOutput;
    wait_for_app: ObjectOutput;
    run_flow: FlowOutput;
    move: ActionOutput;
}

export const DEVICE_LAB_OUTPUT_CONTRACTS: Readonly<Record<keyof DeviceLabToolOutputMap, string>>;
export function validateDeviceLabToolOutput<K extends keyof DeviceLabToolOutputMap>(tool: K, payload: unknown, args?: Record<string, unknown>): DeviceLabToolOutputMap[K];
export function hasDeviceLabOutputContract(tool: string): tool is keyof DeviceLabToolOutputMap;
