# Typed Hyper-V guest boot diagnostic

When a Hyper-V Windows or Linux VM fails guest readiness during start or reboot, Device Lab records a host boot diagnostic before any required Windows containment stop. The read uses one typed `Get-VMDiagnostic` operation under the cleanup deadline. The request carries native VM ID plus exact expected name and opaque ownership Notes; the host verifies all three before inspecting optional devices.

The diagnostic preserves the existing `lastBootCheck.diagnostic` fields: VM state and uptime, generation, secure boot, heartbeat by native service ID, integration services, disk and DVD counts, bounded controller and boot entries, VHD metadata, completeness, and bounded error codes. Optional native reader failures keep the verified VM state and unaffected sections. Observed `Off` or `OffCritical` continues to suppress a redundant containment stop.

The response omits host file paths, guest credentials, native exception text and unbounded values. Invalid identity or malformed transport evidence does not prove a VM is off and cannot suppress containment. Native Windows syntax and live Hyper-V validation are required at the parent Goal gate.
