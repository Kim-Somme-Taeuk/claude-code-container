# Typed Windows guest provisioning

Windows VM creation prepares an owner-private DPAPI credential and a three-file `CCC_UNATTEND` ISO. The answer file keeps the existing `oobeSystem` account and autologon element order. Its label-based first-logon launcher invokes the separate cleanup program; that program removes cached answer files and autologon secrets, then writes the current incarnation's completion marker as its last action.

Device Lab verifies the created VM, owner-private paths and absence of an already attached provisioning ISO before preparing the secret-bearing files. A typed Hyper-V operation then rechecks exact VM ID, name and Notes, requires an Off VM and one matching OS disk, attaches the ISO once, configures Gen2 Windows Secure Boot and the OS disk as first boot device or the Gen1 BIOS order, enables disabled integration services, and reads back the postconditions. The password travels in command stdin and is never returned in the public create result.

The broker keeps a single 180-second deadline across preflight, media creation and VM configuration, plus its credential-file check, exact result validation and owner-scoped create rollback. A failed, timed-out or malformed VM configuration cannot claim a device. An attached ISO remains until guest readiness proves both the first-logon scrub and media detachment. Fixed bounded diagnostic codes replace native exception text in public failures.

Native Windows PowerShell, IMAPI, DPAPI and live Hyper-V verification remain parent Goal gates on a Windows host.
