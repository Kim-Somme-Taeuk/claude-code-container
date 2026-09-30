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
    backends: ObjectOutput;
    broker_status: ObjectOutput;
    list_devices: DeviceListOutput | DeviceRecord[];
    inventory: ObjectOutput;
    wireless: ObjectOutput;
    image_list: ObjectOutput;
    image_import: ObjectOutput;
    disk_materialize: ObjectOutput;
    reboot: ObjectOutput;
    target_list: ObjectOutput;
    readiness_probe: ObjectOutput;
    session_open: ObjectOutput;
    workspace_sync: ObjectOutput;
    artifacts_export: ObjectOutput;
    guest_agent_status: ObjectOutput;
    guest_agent_provision: ObjectOutput;
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
    accessibility_snapshot: ObjectOutput;
    base_image_create: LifecycleOutput;
    base_image_clone: LifecycleOutput;
    snapshot_list: ObjectOutput;
    snapshot_create: ObjectOutput;
    snapshot_restore: LifecycleOutput;
    snapshot_delete: DeleteOutput;
    record_video_start: ObjectOutput;
    record_video_stop: ObjectOutput;
    record_video_status: ObjectOutput;
    upload: ObjectOutput;
    download: ObjectOutput;
    reset: ObjectOutput;
    install_app: ObjectOutput;
    launch_app: ObjectOutput;
    automation_status: MobileSessionStatusOutput;
    dump_ui: ObjectOutput;
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
    grant_permission: ObjectOutput;
    revoke_permission: ObjectOutput;
    set_location: ActionOutput;
    set_battery: ActionOutput;
    set_network: ActionOutput;
    toggle_airplane_mode: ActionOutput;
    set_clipboard: ActionOutput;
    get_clipboard: ObjectOutput;
    wait_for_text: ObjectOutput;
    wait_for_app: ObjectOutput;
    run_flow: FlowOutput;
    move: ActionOutput;
}

export const DEVICE_LAB_OUTPUT_CONTRACTS: Readonly<Record<keyof DeviceLabToolOutputMap, string>>;
export function validateDeviceLabToolOutput<K extends keyof DeviceLabToolOutputMap>(tool: K, payload: unknown): DeviceLabToolOutputMap[K];
export function hasDeviceLabOutputContract(tool: string): tool is keyof DeviceLabToolOutputMap;
