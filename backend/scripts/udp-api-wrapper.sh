#!/bin/bash
# ============================================
#  RMS Panel - Non-interactive wrapper script
#  Called by the Node.js API (must run as root)
#  Adapted from RMS-UDP-CUSTOM-MANAGER's add_user_core logic
# ============================================

action="$1"
mkdir -p /etc/rms-users

case "$action" in

  add)
    username="$2"
    password="$3"
    limit="$4"
    exp_timestamp="$5"

    if [[ -z "$username" || -z "$password" || -z "$exp_timestamp" ]]; then
      echo "Usage: add <username> <password> <limit> <expiry_unix_timestamp>" >&2
      exit 1
    fi

    valid=$(date '+%Y-%m-%d' -d "@$exp_timestamp")
    osl_v=$(openssl version | awk '{print $2}' | cut -c1-5)
    if [[ "$osl_v" == "1.1.1" ]]; then
      pass_hash=$(openssl passwd -6 "$password")
    else
      pass_hash=$(openssl passwd -1 "$password")
    fi

    useradd -M -s /bin/false -e "$valid" -p "$pass_hash" -c "$limit,$password" "$username" 2>/dev/null
    if [[ $? -ne 0 ]]; then
      echo "Failed to create system user (may already exist)" >&2
      exit 1
    fi

    echo "$exp_timestamp" > "/etc/rms-users/${username}.expiry"
    echo "OK: user $username created"
    ;;

  renew)
    username="$2"
    new_exp_timestamp="$3"

    if [[ -z "$username" || -z "$new_exp_timestamp" ]]; then
      echo "Usage: renew <username> <new_expiry_unix_timestamp>" >&2
      exit 1
    fi

    valid=$(date '+%Y-%m-%d' -d "@$new_exp_timestamp")
    usermod -e "$valid" "$username" 2>/dev/null
    if [[ $? -ne 0 ]]; then
      echo "Failed to renew system user (does it exist?)" >&2
      exit 1
    fi

    echo "$new_exp_timestamp" > "/etc/rms-users/${username}.expiry"
    usermod -U "$username" 2>/dev/null
    rm -f "/etc/rms-users/${username}.blocked"
    echo "OK: user $username renewed"
    ;;

  block)
    username="$2"
    new_status="$3"  # "blocked" or "active"

    if [[ -z "$username" ]]; then
      echo "Usage: block <username> <blocked|active>" >&2
      exit 1
    fi

    if [[ "$new_status" == "blocked" ]]; then
      touch "/etc/rms-users/${username}.blocked"
      usermod -L "$username" 2>/dev/null
      pkill -u "$username" 2>/dev/null
      kill -9 $(ps -u "$username" -o pid= 2>/dev/null) 2>/dev/null
      echo "OK: user $username blocked and kicked"
    else
      rm -f "/etc/rms-users/${username}.blocked"
      usermod -U "$username" 2>/dev/null
      echo "OK: user $username unblocked"
    fi
    ;;

  delete)
    username="$2"
    if [[ -z "$username" ]]; then
      echo "Usage: delete <username>" >&2
      exit 1
    fi

    pkill -u "$username" 2>/dev/null
    kill -9 $(ps -u "$username" -o pid= 2>/dev/null) 2>/dev/null
    userdel -f "$username" 2>/dev/null
    rm -f "/etc/rms-users/${username}.expiry" "/etc/rms-users/${username}.blocked"
    echo "OK: user $username deleted"
    ;;

  expire)
    # Strict auto-expiry: kick and remove only THIS user's sessions.
    # No service-wide restart - that would disconnect every other
    # currently-connected user, which is not what we want.
    username="$2"
    if [[ -z "$username" ]]; then
      echo "Usage: expire <username>" >&2
      exit 1
    fi

    pkill -u "$username" 2>/dev/null
    kill -9 $(ps -u "$username" -o pid= 2>/dev/null) 2>/dev/null
    userdel --force "$username" 2>/dev/null
    rm -f "/etc/rms-users/${username}.expiry"
    echo "OK: user $username expired and removed"
    ;;

  list_online_users)
    # Best-effort online detection - lists Linux usernames that currently
    # have at least one running process, the same signal the script itself
    # relies on when killing a user's sessions (ps -u <username>).
    # Note: this is only as accurate as UDP Custom's own process model -
    # if it multiplexes all connections through a single daemon process
    # rather than spawning one per user, this won't reflect reality.
    ps -eo user= --no-headers | sort -u
    ;;

  list_session_counts)
    # Counts running processes per username - used as a proxy for "how
    # many active devices" a user has connected, assuming UDP Custom
    # spawns one process per connected session under that username.
    # Output format: "count username" per line.
    ps -eo user= --no-headers | sort | uniq -c
    ;;

  kick_user)
    # Disconnects ALL of this user's active sessions WITHOUT deleting
    # the account - used by the device-limit watchdog when someone
    # exceeds their allowed connection count.
    username="$2"
    if [[ -z "$username" ]]; then
      echo "Usage: kick_user <username>" >&2
      exit 1
    fi

    pkill -u "$username" 2>/dev/null
    kill -9 $(ps -u "$username" -o pid= 2>/dev/null) 2>/dev/null
    echo "OK: user $username kicked"
    ;;

  *)
    echo "Unknown action: $action" >&2
    echo "Valid actions: add, renew, block, delete, expire, list_online_users, list_session_counts, kick_user" >&2
    exit 1
    ;;
esac
