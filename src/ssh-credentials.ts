// Root only reads the host mount and its own private archive. Every write to
// the managed destination runs as ccc, including cleanup and rollback.
export const SSH_COPY_INSTALL_SCRIPT = String.raw`
set -euo pipefail
umask 077
target=$1
exec 9>>"$target.lock"
flock -w 15 9
test ! -L "$target"
test ! -e "$target" || test -d "$target"
work=$(mktemp -d "$(dirname "$target")/.ccc-ssh-copy.XXXXXX")
cleanup() {
    status=$?
    if test -d "$work/previous" && ! test -e "$target" && ! test -L "$target"; then
        mv -T -- "$work/previous" "$target" || exit 1
    fi
    rm -rf -- "$work"
    exit "$status"
}
trap cleanup EXIT
mkdir "$work/next"
tar --extract --file=- --directory="$work/next" --no-same-owner --no-same-permissions --delay-directory-restore
# Never chmod or read through links from the source archive.
test -z "$(find "$work/next" ! -type d ! -type f -print -quit)"
find "$work/next" -type d -exec chmod 700 {} \;
find "$work/next" -type f -exec chmod 600 {} +
if test -f "$target/known_hosts" && test ! -L "$target/known_hosts"; then
    if test -e "$work/next/known_hosts"; then
        test -f "$work/next/known_hosts"
        sort -u -- "$target/known_hosts" "$work/next/known_hosts" > "$work/known_hosts"
        mv -- "$work/known_hosts" "$work/next/known_hosts"
    else
        cp -- "$target/known_hosts" "$work/next/known_hosts"
        chmod 600 "$work/next/known_hosts"
    fi
fi
if test -e "$target"; then
    mv -T -- "$target" "$work/previous"
fi
mv -T -- "$work/next" "$target"
`;

const quoteShell = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

export const SSH_COPY_SCRIPT = String.raw`
set -euo pipefail
umask 077
archive=$(mktemp /tmp/ccc-ssh-archive.XXXXXX)
trap 'rm -f -- "$archive"' EXIT
# No dereference: a symlink cannot make root read outside the mounted tree.
unsupported=$(find /home/ccc/.ssh ! -type d ! -type f -print -quit)
test -z "$unsupported"
tar --create --file="$archive" --directory=/home/ccc/.ssh .
runuser -u ccc -- /bin/bash -c ${quoteShell(SSH_COPY_INSTALL_SCRIPT)} ccc-ssh-copy /tmp/.ssh-copy < "$archive"
`;
