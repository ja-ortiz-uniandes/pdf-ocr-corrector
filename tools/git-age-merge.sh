#!/usr/bin/env bash
#
# Merge driver for git-age-encrypted files.
#
# Git's 3-way merge works on *blob* content, and git-age's clean/smudge filters
# run on `git add` and checkout, not during a merge. So without this, merging a
# tracked file means merging two ciphertexts: git cannot line up encrypted bytes,
# `-text` marks the file binary, and you get a binary conflict with one side left
# in the working tree. Resolving that by picking a side silently drops everything
# the other machine wrote.
#
# This decrypts all three inputs, merges the plaintext normally, and re-encrypts
# the result, so conflicts come back as ordinary conflict markers in readable text.
#
# Registered per clone (the script ships with the repo, so the path is repo-relative):
#
#   git config merge.age.driver 'bash tools/git-age-merge.sh %O %A %B %L %P'
#
# Called by git as: %O = common ancestor, %A = ours (also the output file),
# %B = theirs, %L = conflict marker size, %P = the real pathname.
# Exit 0 means merged cleanly, 1 means conflicts were written to %A.

set -u

base=$1
ours=$2
theirs=$3
marker_size=${4:-7}
path=${5:-file}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# An input is only decrypted if it actually is an age file. Git hands over an
# empty file when a side does not exist (added on one branch only), and a repo
# can also hold a version committed before encryption was switched on.
#
# CRLF is stripped afterwards. `-text` in .gitattributes (needed so git does not
# treat the ciphertext as text) also opts the file out of the repo's `eol=lf`
# normalisation, so a Windows editor can commit CRLF verbatim. Merging that
# against an LF side makes *every* line differ and turns a one-line change into
# a whole-file conflict, which is exactly what it looks like when this driver is
# broken.
decrypt() {
  local src=$1 dst=$2
  if [ -s "$src" ] && head -c 21 "$src" | grep -q '^age-encryption\.org'; then
    if ! git-age smudge -- "$path" < "$src" > "$dst.raw"; then
      echo "git-age-merge: cannot decrypt $src for $path" >&2
      return 1
    fi
  else
    cp "$src" "$dst.raw"
  fi
  tr -d '\r' < "$dst.raw" > "$dst"
}

decrypt "$base" "$tmp/base" || exit 2
decrypt "$ours" "$tmp/ours" || exit 2
decrypt "$theirs" "$tmp/theirs" || exit 2

git merge-file --marker-size="$marker_size" \
  -L "ours ($path)" -L "ancestor ($path)" -L "theirs ($path)" \
  "$tmp/ours" "$tmp/base" "$tmp/theirs"
status=$?

# A negative status means git merge-file itself failed, rather than reporting a
# number of conflicts. Leave %A untouched so nothing is written half-encrypted.
if [ "$status" -lt 0 ]; then
  echo "git-age-merge: git merge-file failed for $path" >&2
  exit 2
fi

# Back to ciphertext: %A is a blob, not a working-tree file, so writing the
# plaintext here would commit the file unencrypted.
if ! git-age clean -- "$path" < "$tmp/ours" > "$tmp/sealed"; then
  echo "git-age-merge: cannot re-encrypt the merge result for $path" >&2
  exit 2
fi

if ! head -c 21 "$tmp/sealed" | grep -q '^age-encryption\.org'; then
  echo "git-age-merge: refusing to write plaintext into $ours" >&2
  exit 2
fi

cp "$tmp/sealed" "$ours"

# 0 = clean, anything above = conflicts, which git reports to the user.
[ "$status" -eq 0 ] && exit 0
exit 1
