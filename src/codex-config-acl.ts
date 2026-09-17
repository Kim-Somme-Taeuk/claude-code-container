// Linux file ACLs are applied directly: setfacl can fall back to chmod on
// filesystems without ACL support, even when it ultimately reports failure.
export const CODEX_CONFIG_FILE_ACL = String.raw`
import errno, os, stat, struct, sys

USER_OBJ, USER, GROUP_OBJ, GROUP, MASK, OTHER = 1, 2, 4, 8, 16, 32
UNDEFINED = 0xffffffff
container_uid = int(sys.argv[1])
if not 0 <= container_uid < UNDEFINED:
    raise RuntimeError("invalid container user identity")

directory = os.open("/home/ccc/.codex", os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    host_uid = os.fstat(directory).st_uid
    file = os.open("config.toml", os.O_PATH | os.O_NOFOLLOW, dir_fd=directory)
    try:
        metadata = os.fstat(file)
        if not stat.S_ISREG(metadata.st_mode):
            raise RuntimeError("config must be a regular non-symlink file")
        # O_PATH pins even an unreadable file. xattr calls through its procfs
        # descriptor link operate on that inode, including after a rename.
        target = "/proc/self/fd/" + str(file)
        attribute = "system.posix_acl_access"
        try:
            data = os.getxattr(target, attribute)
        except OSError as error:
            if error.errno != errno.ENODATA:
                raise
            data = None
        if data is None:
            entries = [(USER_OBJ, (metadata.st_mode >> 6) & 7, UNDEFINED),
                       (GROUP_OBJ, (metadata.st_mode >> 3) & 7, UNDEFINED),
                       (OTHER, metadata.st_mode & 7, UNDEFINED)]
        else:
            if len(data) < 4 or len(data) % 8 != 4 or struct.unpack("<I", data[:4])[0] != 2:
                raise RuntimeError("malformed config ACL")
            entries = list(struct.iter_unpack("<HHI", data[4:]))
        acl = {}
        for tag, permissions, uid in entries:
            if (tag not in (USER_OBJ, USER, GROUP_OBJ, GROUP, MASK, OTHER)
                    or permissions > 7 or (tag, uid) in acl
                    or ((tag in (USER, GROUP)) == (uid == UNDEFINED))):
                raise RuntimeError("malformed config ACL")
            acl[tag, uid] = permissions
        if (any((tag, UNDEFINED) not in acl for tag in (USER_OBJ, GROUP_OBJ, OTHER))
                or list(acl) != sorted(acl)
                or (any(tag in (USER, GROUP) for tag, _ in acl) and (MASK, UNDEFINED) not in acl)):
            raise RuntimeError("malformed config ACL")

        principals = {host_uid, container_uid}
        old_mask = acl.get((MASK, UNDEFINED), acl[GROUP_OBJ, UNDEFINED])
        new_mask = old_mask | 6 if principals - {metadata.st_uid} else old_mask
        for (tag, uid), permissions in acl.items():
            if tag in (GROUP_OBJ, GROUP) or (tag == USER and uid not in principals):
                if permissions & (new_mask & ~old_mask):
                    raise RuntimeError("config ACL mask expansion would grant unrelated access; inspect ACL manually")
        for uid in principals:
            key = (USER_OBJ, UNDEFINED) if uid == metadata.st_uid else (USER, uid)
            acl[key] = acl.get(key, 0) | 6
        if principals - {metadata.st_uid} or (MASK, UNDEFINED) in acl:
            acl[MASK, UNDEFINED] = new_mask
        encoded = struct.pack("<I", 2) + b"".join(
            struct.pack("<HHI", tag, acl[tag, uid], uid) for tag, uid in sorted(acl))
        os.setxattr(target, attribute, encoded)
    finally:
        os.close(file)
finally:
    os.close(directory)
`;

export function codexConfigFileAclScript(containerUid: string): string {
    if (!/^\d+$/.test(containerUid) || Number(containerUid) >= 0xffffffff) {
        throw new Error("Unable to prepare Codex credentials: invalid container user identity");
    }
    return `python3 - ${containerUid} <<'CCC_CODEX_FILE_ACL'\n${CODEX_CONFIG_FILE_ACL}\nCCC_CODEX_FILE_ACL`;
}
